$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$stateDir = Join-Path $repoRoot '.telecodex'
$logDir = Join-Path $stateDir 'logs'
$envFile = Join-Path $repoRoot '.env'
$entrypoint = Join-Path $repoRoot 'dist\index.js'
$eventLog = Join-Path $stateDir 'process-events.jsonl'

function Ensure-Directory {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Write-JsonLine {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  Ensure-Directory -Path (Split-Path -Parent $Path)
  ($Value | ConvertTo-Json -Compress -Depth 8) | Add-Content -LiteralPath $Path -Encoding utf8
}

function Add-PathEntry {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $separator = [System.IO.Path]::PathSeparator
  $entries = @($env:Path -split [regex]::Escape([string]$separator) | Where-Object { $_ })
  if ($entries -notcontains $Path) {
    $env:Path = ($Path, $env:Path) -join $separator
  }
}

Ensure-Directory -Path $stateDir
Ensure-Directory -Path $logDir

if (-not (Test-Path -LiteralPath $envFile)) {
  Write-JsonLine -Path $eventLog -Value @{
    at = (Get-Date).ToUniversalTime().ToString('o')
    type = 'launcher_failed'
    pid = $PID
    detail = @{ reason = 'missing_env'; path = $envFile }
  }
  throw "Missing .env file: $envFile"
}

if (-not (Test-Path -LiteralPath $entrypoint)) {
  Write-JsonLine -Path $eventLog -Value @{
    at = (Get-Date).ToUniversalTime().ToString('o')
    type = 'launcher_failed'
    pid = $PID
    detail = @{ reason = 'missing_entrypoint'; path = $entrypoint }
  }
  throw "Missing built entrypoint: $entrypoint. Run npm run build first."
}

Get-Content -LiteralPath $envFile | ForEach-Object {
  if ($_ -match '^[A-Z0-9_]+=') {
    $key, $value = $_.Split('=', 2)
    Set-Item -Path ("Env:" + $key) -Value $value
  }
}

Add-PathEntry -Path (Join-Path $repoRoot 'node_modules\.bin')
if ($env:APPDATA) {
  Add-PathEntry -Path (Join-Path $env:APPDATA 'npm')
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutLog = Join-Path $logDir "bot-$stamp.out.log"
$stderrLog = Join-Path $logDir "bot-$stamp.err.log"
$startPath = Join-Path $stateDir 'bot-start.json'

Set-Location $repoRoot
$process = Start-Process -FilePath 'node' `
  -ArgumentList @($entrypoint) `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -WindowStyle Hidden `
  -PassThru

Set-Content -LiteralPath (Join-Path $stateDir 'bot.pid') -Value $process.Id -Encoding utf8
@{
  schemaVersion = 1
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  launcherPid = $PID
  botPid = $process.Id
  repoRoot = $repoRoot
  entrypoint = $entrypoint
  stdoutLog = $stdoutLog
  stderrLog = $stderrLog
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $startPath -Encoding utf8

Write-JsonLine -Path $eventLog -Value @{
  at = (Get-Date).ToUniversalTime().ToString('o')
  type = 'launcher_started'
  pid = $PID
  detail = @{
    botPid = $process.Id
    stdoutLog = $stdoutLog
    stderrLog = $stderrLog
  }
}

Write-JsonLine -Path $eventLog -Value @{
  at = (Get-Date).ToUniversalTime().ToString('o')
  type = 'launcher_detached'
  pid = $PID
  detail = @{
    botPid = $process.Id
    stdoutLog = $stdoutLog
    stderrLog = $stderrLog
  }
}

exit 0
