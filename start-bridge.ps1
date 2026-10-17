<#
.SYNOPSIS
  Starts everything Claude Code needs to reach the bridge model.

.DESCRIPTION
  1. opencode serve  - the process that actually talks to the model, and the
                       reason the free tier is allowed
  2. bridge.mjs      - Anthropic /v1/messages shim on 127.0.0.1:8787

  Run this in its own window before launching `claude`. Both are idempotent:
  re-running while they are up just re-checks health.

  The shared password is persisted to .opencode-password (gitignored). It has
  to be, because the two processes must agree and `opencode serve` keeps the
  password it started with: generating a fresh one on each run would leave the
  bridge unable to authenticate and every turn would fail.

.PARAMETER OpenCodePort
  Port for opencode serve. Default 4599.

.PARAMETER BridgePort
  Port for the bridge. Default 8787.

.PARAMETER Password
  Password for the local opencode serve API. Defaults to the persisted one, then
  to $env:OC_PASS, then to a generated one. It only guards a loopback listener.

.PARAMETER Effort
  Pin the reasoning effort and ignore whatever Claude Code asks for.
  One of: low, medium, high, xhigh, max.

.PARAMETER AuxEffort
  Effort for Claude Code's short requests (session titles, classifiers,
  compaction). Leave unset to use the session's own effort for those too.
#>
[CmdletBinding()]
param(
  [int]$OpenCodePort = 4599,
  [int]$BridgePort = 8787,
  [string]$Password,
  [ValidateSet("", "low", "medium", "high", "xhigh", "max")]
  [string]$Effort = "",
  [ValidateSet("", "low", "medium", "high", "xhigh", "max")]
  [string]$AuxEffort = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigDir = Join-Path $Root "opencode-config"
$SecretFile = Join-Path $Root ".opencode-password"

function Test-Port([int]$Port) {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
}

function Resolve-OpenCode {
  # Ask for the .cmd and the real executable by name. `Get-Command opencode`
  # returns the .ps1 shim, which Start-Process cannot run at all.
  $cmd = Get-Command opencode.cmd, opencode.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:APPDATA\npm\node_modules\@opencode\cli\bin\opencode.exe",
    "$HOME/.opencode/bin/opencode",
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw "opencode not found. Install the CLI first: npm i -g @opencode/cli"
}

if (-not $Password) {
  if (Test-Path $SecretFile) { $Password = (Get-Content $SecretFile -Raw).Trim() }
}
if (-not $Password) { $Password = $env:OC_PASS }
if (-not $Password) {
  $Password = [guid]::NewGuid().ToString("N").Substring(0, 20)
  Write-Host "[info] generated a local opencode password (saved to .opencode-password)"
}
[System.IO.File]::WriteAllText($SecretFile, $Password)

# ---- 1. opencode serve -------------------------------------------------------
if (Test-Port $OpenCodePort) {
  Write-Host "[ok]   opencode serve already listening on $OpenCodePort"
} else {
  Write-Host "[start] opencode serve on $OpenCodePort"
  $exe = Resolve-OpenCode
  $env:OPENCODE_PASSWORD = $Password
  $env:OPENCODE_CONFIG_DIR = $ConfigDir
  Start-Process -FilePath $exe `
    -ArgumentList "serve", "--port", "$OpenCodePort", "--hostname", "127.0.0.1" `
    -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 700
    if (Test-Port $OpenCodePort) { break }
  }
  if (Test-Port $OpenCodePort) { Write-Host "[ok]   opencode serve up" }
  else { throw "opencode serve did not come up on port $OpenCodePort" }
}

# ---- 2. bridge ---------------------------------------------------------------
if (Test-Port $BridgePort) {
  Write-Host "[ok]   bridge already listening on $BridgePort"
} else {
  Write-Host "[start] bridge on $BridgePort"
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $node) { throw "node not found on PATH. Install Node 20+ and reopen the shell." }
  $env:OC_PORT = "$OpenCodePort"
  $env:OC_PASS = $Password
  $env:BRIDGE_PORT = "$BridgePort"
  if ($Effort) { $env:BRIDGE_EFFORT = $Effort }
  if ($AuxEffort) { $env:BRIDGE_AUX_EFFORT = $AuxEffort }
  # Quote the script path: paths often contain spaces and Start-Process would
  # otherwise split the argument.
  $bridgeScript = Join-Path $Root "bridge.mjs"
  Start-Process -FilePath $node.Source -ArgumentList ('"{0}"' -f $bridgeScript) -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Port $BridgePort) { break }
  }
  if (Test-Port $BridgePort) { Write-Host "[ok]   bridge up" }
  else { throw "bridge did not come up on port $BridgePort" }
}

# ---- 3. verify ---------------------------------------------------------------
# /health only reads local state, so it cannot see a password mismatch or a
# missing provider credential. Only a real completion proves the chain works.
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$BridgePort/health" -TimeoutSec 10
  # The marker field, not the model name. Comparing against $env:BRIDGE_MODEL
  # meant the guard only ran when that variable happened to be set, so it never
  # fired in the case it exists for: some other service already on 8787.
  if ($h.bridge -ne $true) {
    throw "port $BridgePort is answering but is not this bridge (no bridge marker). Stop whatever holds it, or pass -BridgePort"
  }
  Write-Host "[ok]   health: model=$($h.model) effort=$($h.effort) usable_input=$($h.limits.input)"
} catch {
  throw "health check failed: $($_.Exception.Message)"
}

try {
  $body = @{
    model = $h.model
    max_tokens = 16
    messages = @(@{ role = "user"; content = "Reply with the single word PONG." })
  } | ConvertTo-Json -Depth 5
  $probe = Invoke-RestMethod "http://127.0.0.1:$BridgePort/v1/messages" -Method Post `
    -ContentType "application/json" -Body $body -TimeoutSec 120
  $text = ($probe.content | Where-Object { $_.type -eq "text" } | ForEach-Object { $_.text }) -join ""
  Write-Host "[ok]   live completion: $([Math]::Min(60, $text.Length)) chars, stop=$($probe.stop_reason)"
} catch {
  throw "the bridge is up but a real completion failed - check the opencode password and that OpenCode is logged in: $($_.Exception.Message)"
}

# The child processes already have these in their own environment; leaving them
# here puts the password into every later command run in this shell.
Remove-Item Env:OC_PASS, Env:OPENCODE_PASSWORD -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Ready. Launch Claude Code with:  claude"
Write-Host "Stop with: stop-bridge.ps1"