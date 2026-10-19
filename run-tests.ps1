<#
.SYNOPSIS
  Runs the test suites.

.DESCRIPTION
  By default this runs only the suites that cost nothing: no model, no tokens,
  no network. That is three suites covering 211 assertions, including every
  streaming-contract and error-taxonomy case.

  The live suites drive the real model. They are opt-in because they are slow,
  they cost tokens on every run, and on a free tier they hit the provider's
  rate limiter partway through - after which every remaining case reports the
  rate limiter rather than anything about the bridge. Run them deliberately:

    .\run-tests.ps1 -Live

  -LiveCount caps how many model-backed suites run, which is the main lever on
  token spend: effort (many calls) > load > protocol > bridge. It only has an
  effect together with -Live.
#>
[CmdletBinding()]
param(
  [switch]$Live,
  [ValidateSet("effort", "load", "protocol", "bridge")]
  [string[]]$LiveCount = @("effort", "load", "protocol", "bridge")
)

# A second, explicit gate. `-Live` alone has been enough for an automated agent to
# run every model-backed suite without thinking about it, and each of those calls
# a provider on a free tier that is already throttled. The env var has to be set
# deliberately, so the default answer to "should this spend tokens?" is no.
if ($Live -and -not $env:BRIDGE_ALLOW_LIVE_TESTS) {
  Write-Error "-Live is refused unless BRIDGE_ALLOW_LIVE_TESTS=1 is set in the environment.`nThese suites call the real model. A single turn can cost tens of thousands of tokens and the free tier is rate limited.`nIf you mean it:`n    `$env:BRIDGE_ALLOW_LIVE_TESTS=1; .\run-tests.ps1 -Live"
  exit 1
}

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Section([string]$Title) {
  Write-Host ""
  Write-Host "=== $Title ===" -ForegroundColor Cyan
}

$results = [ordered]@{}

# ---- free: no model, no network --------------------------------------------
Section "syntax"
$bad = @()
foreach ($f in @("bridge.mjs", "test-unit.mjs", "test-http.mjs", "test-mock.mjs")) {
  node --check $f 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $bad += $f }
}
if ($bad.Count) {
  Write-Host "syntax errors in: $($bad -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "all files parse"

$assertions = 0

function Suite($key, $label, $script) {
  Section $label
  # The count is parsed, not written down. It was hardcoded at 281 and stayed
  # wrong through several rounds while suites quietly grew past it, which is the
  # whole reason nobody noticed the prompt had no coverage.
  $out = & node $script 2>&1
  $code = $LASTEXITCODE
  $out | ForEach-Object { Write-Host $_ }
  $m = ($out | Select-String -Pattern "(\d+) passed" | Select-Object -Last 1)
  if ($m) { $script:assertions += [int]$m.Matches[0].Groups[1].Value }
  $results[$key] = $code
}

Suite "unit" "unit (no model, no bridge)" "test-unit.mjs"
Suite "http" "http layer (no model, no bridge)" "test-http.mjs"
Suite "mock" "contract against a mock upstream (no model, no tokens)" "test-mock.mjs"

if (-not $Live) {
  # Only warn when the user actually typed it. $LiveCount has a default, so
  # `if ($LiveCount)` was true on every plain run and printed a warning nobody
  # had earned.
  if ($PSBoundParameters.ContainsKey("LiveCount")) {
    Write-Warning "-LiveCount has no effect without -Live; no model-backed suite was run."
  }
  Section "summary"
  foreach ($k in $results.Keys) {
    Write-Host ("  {0,-8} {1}" -f $k, $(if ($results[$k] -eq 0) { "PASS" } else { "FAIL" }))
  }
  $failed = @($results.Keys | Where-Object { $results[$_] -ne 0 })
  if ($failed.Count) {
    Write-Host ""
    Write-Host "failed: $($failed -join ', ')" -ForegroundColor Red
    exit 1
  }
  Write-Host ""
  Write-Host "all green, at no token cost ($assertions assertions)"
  Write-Host "model-backed suites were skipped; run .\run-tests.ps1 -Live to include them"
  exit 0
}

# ---- opt-in: these drive the real model ------------------------------------
$up = $false
try {
  Invoke-RestMethod "http://127.0.0.1:8787/health" -TimeoutSec 5 | Out-Null
  $up = $true
} catch {}
if (-not $up) {
  Write-Host ""
  Write-Host "bridge not running - start it with start-bridge.ps1, skipping live suites"
  $failed = @($results.Keys | Where-Object { $results[$_] -ne 0 })
  if ($failed.Count) { exit 1 }
  exit 0
}

foreach ($suite in $LiveCount) {
  Section "live: $suite"
  node "test-$suite.mjs"
  $results["live-$suite"] = $LASTEXITCODE
  # Back off between suites. The free tier rate-limits bursts, and a throttled
  # run reports the rate limiter instead of the bridge.
  Start-Sleep -Seconds 5
}

Section "summary"
foreach ($k in $results.Keys) {
  Write-Host ("  {0,-14} {1}" -f $k, $(if ($results[$k] -eq 0) { "PASS" } else { "FAIL" }))
}
$failed = @($results.Keys | Where-Object { $results[$_] -ne 0 })
if ($failed.Count) {
  Write-Host ""
  Write-Host "failed: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "all green"
exit 0