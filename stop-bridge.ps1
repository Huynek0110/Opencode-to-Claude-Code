<#
.SYNOPSIS
  Stops opencode serve and the bridge.

.DESCRIPTION
  Kills only the processes listening on the bridge ports, so it never takes an
  unrelated process - or an OpenCode session you are using - down with it.
  That claim holds for the bridge, which listens on its own dedicated port. For
  `opencode serve` it means "whatever holds port 4599": if you started OpenCode
  yourself on that port, this stops it too. Pick a different -OpenCodePort if
  that matters.

  Falls back to netstat when the NetTCPIP module is unavailable, because
  silently degrading to "not running" would make the next start fail on an
  occupied port.
#>
[CmdletBinding()]
param(
  [int]$OpenCodePort = 4599,
  [int]$BridgePort = 8787
)

$ErrorActionPreference = "SilentlyContinue"

function Test-Port([int]$Port) {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
}

function Get-ListenerPid([int]$Port) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  try {
    $line = netstat -ano -p tcp | Select-String ":$Port\s+.*LISTENING" | Select-Object -First 1
    if ($line) {
      $parts = ($line -split "\s+") | Where-Object { $_ }
      return [int]$parts[-1]
    }
  } catch {}
  return $null
}

function Stop-Port([int]$Port, [string]$Name) {
  $pid_ = Get-ListenerPid $Port
  if (-not $pid_) {
    Write-Host "[ok]   $Name not running"
    return
  }
  try {
    Stop-Process -Id $pid_ -Force -ErrorAction Stop
  } catch {
    # Reporting "[stop]" for a process that is still alive sends the user off to
    # run `claude` against a bridge they think they shut down.
    Write-Host "[FAIL] could not stop $Name (pid $pid_): $($_.Exception.Message)"
    return
  }
  # Wait for the listener to actually go away. Returning immediately made
  # `stop` then `start` race: the port still looked occupied, so start decided
  # the old bridge was fine and verified against a dying process.
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Test-Port $Port)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Test-Port $Port) {
    Write-Host "[FAIL] $Name still listening on $Port after 5s"
  } else {
    Write-Host "[stop] $Name (pid $pid_, port $Port)"
  }
}

Stop-Port $BridgePort "bridge.mjs"
Stop-Port $OpenCodePort "opencode serve"