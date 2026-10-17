param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)
# One-shot launcher: make sure the bridge is up, then hand over to Claude Code
# with any arguments you pass through.
#
#   .\claude-bridge.ps1
#   .\claude-bridge.ps1 -p "fix the failing test"
#   .\claude-bridge.ps1 --effort max

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

$busy = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if (-not $busy) {
  Write-Host "[bridge] not running, starting it"
  & (Join-Path $Root "start-bridge.ps1")
} else {
  Write-Host "[bridge] already running"
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  Write-Error "claude is not on PATH. Install Claude Code first: npm i -g @anthropic-ai/claude-code"
  exit 1
}

& claude @ClaudeArgs
exit $LASTEXITCODE