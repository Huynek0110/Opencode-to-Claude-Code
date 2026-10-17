param(
  [Parameter(Position = 0)][string]$Level,
  [switch]$List
)
$ErrorActionPreference = "Stop"
$Bridge = "http://127.0.0.1:8787"

if ($List -or -not $Level) {
  try {
    $e = Invoke-RestMethod "$Bridge/effort" -TimeoutSec 10
    Write-Host "current default : $($e.effort)"
    Write-Host "levels          : $($e.levels -join ', ')"
    Write-Host "locked          : $($e.locked)"
  } catch {
    Write-Host "bridge not running on $Bridge - start it with start-bridge.ps1"
    exit 1
  }
  if (-not $Level) { exit 0 }
}

$lvl = $Level.ToLower()
try {
  $r = Invoke-RestMethod "$Bridge/effort" -Method Post -ContentType "application/json" `
    -Body (@{ effort = $lvl } | ConvertTo-Json) -TimeoutSec 10
  Write-Host "default effort  : $($r.effort)"
  Write-Host ""
  Write-Host "Note: Claude Code sends its own level per request from /effort, --effort"
  Write-Host "or CLAUDE_CODE_EFFORT_LEVEL, which takes priority over this default."
} catch {
  $detail = ""
  try {
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $detail = ($reader.ReadToEnd() | ConvertFrom-Json).error
  } catch {}
  if (-not $detail) { $detail = $_.Exception.Message }
  Write-Host "set failed: $detail"
  exit 1
}