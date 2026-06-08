param(
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$TaskName = 'AttysCodexBridge Watchdog',
  [int]$IntervalMinutes = 1,
  [switch]$Unregister,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$watchdogPath = Join-Path $RepoRoot 'scripts\watchdog.ps1'

if ($Status) {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  return
}

if ($Unregister) {
  $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existingTask) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Unregistered scheduled task: $TaskName"
  } else {
    Write-Host "Scheduled task is not registered: $TaskName"
  }
  return
}

if (-not (Test-Path -LiteralPath $watchdogPath)) {
  throw "Missing watchdog script: $watchdogPath"
}

$pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$pwsh = if ($pwshCommand) { $pwshCommand.Source } else { (Get-Command powershell -ErrorAction Stop).Source }
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$watchdogPath`" -RepoRoot `"$RepoRoot`""
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $argument -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'AttysCodexBridge process and heartbeat watchdog.' `
  -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "RepoRoot: $RepoRoot"
Write-Host "Interval: $IntervalMinutes minute(s)"
