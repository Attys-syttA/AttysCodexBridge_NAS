param(
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [int]$StaleSeconds = 180,
  [int]$RestartWindowMinutes = 10,
  [int]$MaxRestarts = 3,
  [switch]$StatusOnly,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$stateDir = Join-Path $RepoRoot '.telecodex'
$logDir = Join-Path $stateDir 'logs'
$healthPath = Join-Path $stateDir 'health.json'
$pidPath = Join-Path $stateDir 'bot.pid'
$statusPath = Join-Path $stateDir 'watchdog-status.json'
$eventPath = Join-Path $stateDir 'watchdog-events.jsonl'
$stopRequestPath = Join-Path $stateDir 'stop-request.json'
$envPath = Join-Path $RepoRoot '.env'
$launcherPath = Join-Path $RepoRoot 'start-attyscodexbridge-workspace.ps1'
$entrypointPath = Join-Path $RepoRoot 'dist\index.js'

function Ensure-Directory {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  Ensure-Directory -Path (Split-Path -Parent $Path)
  ($Value | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $Path -Encoding utf8
}

function Write-JsonLine {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  Ensure-Directory -Path (Split-Path -Parent $Path)
  ($Value | ConvertTo-Json -Compress -Depth 12) | Add-Content -LiteralPath $Path -Encoding utf8
}

function Read-JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-ActiveStopRequest {
  $request = Read-JsonFile -Path $stopRequestPath
  if (-not $request -or $request.action -ne 'stop') {
    return $false
  }

  if (-not $request.expiresAt) {
    return $true
  }

  try {
    return ([datetime]$request.expiresAt).ToUniversalTime() -gt (Get-Date).ToUniversalTime()
  } catch {
    return $false
  }
}

function Import-DotEnv {
  param([Parameter(Mandatory = $true)][string]$Path)
  $result = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    return $result
  }

  Get-Content -LiteralPath $Path -Encoding utf8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#') -or $line -notmatch '=') {
      return
    }
    if ($line.StartsWith('export ')) {
      $line = $line.Substring(7).Trim()
    }
    $separatorIndex = $line.IndexOf('=')
    if ($separatorIndex -lt 1) {
      return
    }
    $key = $line.Substring(0, $separatorIndex).Trim()
    $value = $line.Substring($separatorIndex + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $result[$key] = $value
  }

  return $result
}

function Get-ProcessByIdSafe {
  param([int]$ProcessId)
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
  } catch {
    return $null
  }
}

function Get-DescendantProcesses {
  param([int]$RootProcessId)
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootProcessId)
  $descendants = @()
  while ($queue.Count -gt 0) {
    $currentProcessId = [int]$queue.Dequeue()
    $children = @($all | Where-Object { $_.ParentProcessId -eq $currentProcessId })
    foreach ($child in $children) {
      $descendants += $child
      $queue.Enqueue([int]$child.ProcessId)
    }
  }
  return $descendants
}

function Get-TrackedBotPid {
  $pidFromFile = $null
  if (Test-Path -LiteralPath $pidPath) {
    $raw = (Get-Content -LiteralPath $pidPath -Raw -Encoding utf8).Trim()
    if ($raw -match '^\d+$') {
      $pidFromFile = [int]$raw
    }
  }

  if ($pidFromFile) {
    return $pidFromFile
  }

  $health = Read-JsonFile -Path $healthPath
  if ($health -and $health.process -and $health.process.pid) {
    return [int]$health.process.pid
  }

  return $null
}

function Get-RecentRestartCount {
  param([datetime]$Since)
  if (-not (Test-Path -LiteralPath $eventPath)) {
    return 0
  }

  $count = 0
  foreach ($line in Get-Content -LiteralPath $eventPath -Encoding utf8 -Tail 200) {
    try {
      $event = $line | ConvertFrom-Json
      $eventTime = if ($event.at) { [datetime]$event.at } elseif ($event.checkedAt) { [datetime]$event.checkedAt } else { $null }
      $isRestart = $event.type -eq 'restart_started' -or $event.decision -eq 'restart_started'
      if ($eventTime -and $isRestart -and $eventTime -ge $Since) {
        $count += 1
      }
    } catch {
      # Ignore malformed lines.
    }
  }
  return $count
}

function Send-WatchdogAlert {
  param(
    [hashtable]$Env,
    [string]$Text
  )
  $token = $Env['TELEGRAM_BOT_TOKEN']
  $chatId = $Env['TELECODEX_WATCHDOG_ALERT_CHAT_ID']
  if (-not $chatId) {
    $allowed = $Env['TELEGRAM_ALLOWED_USER_IDS']
    if ($allowed) {
      $chatId = ($allowed -split ',' | Select-Object -First 1).Trim()
    }
  }

  if (-not $token -or -not $chatId) {
    return @{ sent = $false; reason = 'missing_telegram_alert_config' }
  }

  try {
    $uri = "https://api.telegram.org/bot$token/sendMessage"
    Invoke-RestMethod -Method Post -Uri $uri -Body @{
      chat_id = $chatId
      text = $Text
      disable_web_page_preview = 'true'
    } -TimeoutSec 20 | Out-Null
    return @{ sent = $true }
  } catch {
    return @{ sent = $false; reason = $_.Exception.Message }
  }
}

function Stop-ProcessTree {
  param([int]$RootProcessId)
  $descendants = @(Get-DescendantProcesses -RootProcessId $RootProcessId | Sort-Object ProcessId -Descending)
  foreach ($child in $descendants) {
    try {
      Stop-Process -Id ([int]$child.ProcessId) -Force -ErrorAction Stop
    } catch {
      # Child may have exited between snapshot and stop.
    }
  }
  try {
    Stop-Process -Id $RootProcessId -Force -ErrorAction Stop
  } catch {
    # Root may have already exited.
  }
}

Ensure-Directory -Path $stateDir
Ensure-Directory -Path $logDir

$now = (Get-Date).ToUniversalTime()
$envValues = Import-DotEnv -Path $envPath
$machineName = $env:COMPUTERNAME
if (-not $machineName) {
  $machineName = [System.Net.Dns]::GetHostName()
}
$userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$hostLabel = $envValues['TELECODEX_HOST_LABEL']
if (-not $hostLabel) {
  $hostLabel = "$machineName\$env:USERNAME"
}
$health = Read-JsonFile -Path $healthPath
$trackedPid = Get-TrackedBotPid
$trackedProcess = if ($trackedPid) { Get-ProcessByIdSafe -ProcessId $trackedPid } else { $null }
$heartbeatAgeSeconds = $null
$isHeartbeatStale = $false
if ($health -and $health.updatedAt) {
  $updatedAt = [datetime]$health.updatedAt
  $heartbeatAgeSeconds = [int]($now - $updatedAt.ToUniversalTime()).TotalSeconds
  $isHeartbeatStale = $heartbeatAgeSeconds -gt $StaleSeconds
}

$codexProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'codex.exe' -and $_.CommandLine -match 'app-server' } | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine)
$codeProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' } | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine)
$mcpProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'serena|mcp-server-filesystem|@modelcontextprotocol/server-filesystem|mcp-server-dev|app\.main' } | Select-Object Name,ProcessId,ParentProcessId,CreationDate,CommandLine)

$preflightErrors = @()
if (-not (Test-Path -LiteralPath $envPath)) {
  $preflightErrors += 'missing_env'
}
if (-not (Test-Path -LiteralPath $entrypointPath)) {
  $preflightErrors += 'missing_entrypoint'
}
if (-not (Test-Path -LiteralPath $launcherPath)) {
  $preflightErrors += 'missing_launcher'
}
if (-not $envValues['TELEGRAM_BOT_TOKEN']) {
  $preflightErrors += 'missing_telegram_token'
}
if (-not $envValues['TELEGRAM_ALLOWED_USER_IDS']) {
  $preflightErrors += 'missing_allowed_users'
}

$reason = 'healthy'
if (-not $trackedPid) {
  $reason = 'missing_pid'
} elseif (-not $trackedProcess) {
  $reason = 'process_missing'
} elseif (-not $health) {
  $reason = 'missing_health'
} elseif ($isHeartbeatStale) {
  $reason = 'stale_heartbeat'
}

$decision = 'none'
$restartCount = Get-RecentRestartCount -Since $now.AddMinutes(-1 * $RestartWindowMinutes)
$activeStopRequest = Test-ActiveStopRequest
$status = @{
  schemaVersion = 1
  checkedAt = $now.ToString('o')
  repoRoot = $RepoRoot
  hostLabel = $hostLabel
  machineName = $machineName
  userName = $userName
  reason = $reason
  decision = $decision
  statusOnly = [bool]$StatusOnly
  noRestart = [bool]$NoRestart
  stopRequested = [bool]$activeStopRequest
  trackedBotPid = $trackedPid
  botProcessAlive = [bool]$trackedProcess
  heartbeatAgeSeconds = $heartbeatAgeSeconds
  preflightErrors = $preflightErrors
  recentRestartCount = $restartCount
  activeRequest = if ($health) { $health.activeRequest } else { $null }
  codexAppServerCount = $codexProcesses.Count
  vsCodeProcessCount = $codeProcesses.Count
  mcpProcessCount = $mcpProcesses.Count
}

if ($StatusOnly -or $reason -eq 'healthy') {
  $status.decision = if ($reason -eq 'healthy') { 'observe_healthy' } else { 'observe_only' }
  Write-JsonFile -Path $statusPath -Value $status
  Write-JsonLine -Path $eventPath -Value $status
  return
}

if ($activeStopRequest) {
  $status.decision = 'stop_requested_no_restart'
  Write-JsonFile -Path $statusPath -Value $status
  Write-JsonLine -Path $eventPath -Value $status
  return
}

$noRestartReasons = @()
if ($NoRestart) {
  $noRestartReasons += 'no_restart_flag'
}
if ($preflightErrors.Count -gt 0) {
  $noRestartReasons += $preflightErrors
}
if ($restartCount -ge $MaxRestarts) {
  $noRestartReasons += 'restart_budget_exhausted'
}

if ($noRestartReasons.Count -gt 0) {
  $status.decision = 'no_restart_alert'
  $status.noRestartReasons = $noRestartReasons
  $alertText = @(
    'AttysCodexBridge watchdog did not restart the bridge.',
    "Host: $hostLabel ($machineName\$env:USERNAME)",
    "Reason: $reason",
    "No-restart reasons: $($noRestartReasons -join ', ')",
    "Repo: $RepoRoot",
    "Status file: $statusPath"
  ) -join "`n"
  $status.alert = Send-WatchdogAlert -Env $envValues -Text $alertText
  Write-JsonFile -Path $statusPath -Value $status
  Write-JsonLine -Path $eventPath -Value $status
  return
}

$status.decision = 'restart_started'
Write-JsonLine -Path $eventPath -Value $status

if ($trackedProcess) {
  Stop-ProcessTree -RootProcessId ([int]$trackedProcess.ProcessId)
  Start-Sleep -Seconds 2
}

$pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$pwsh = if ($pwshCommand) { $pwshCommand.Source } else { $null }
if (-not $pwsh) {
  $pwsh = (Get-Command powershell -ErrorAction Stop).Source
}

try {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcherPath)
  $started = Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
  $status.decision = 'restart_launched'
  $status.launcherPid = $started.Id
} catch {
  $status.decision = 'restart_failed_alert'
  $status.restartError = $_.Exception.Message
  $alertText = @(
    'AttysCodexBridge watchdog failed to restart the bridge.',
    "Host: $hostLabel ($machineName\$env:USERNAME)",
    "Reason: $reason",
    "Error: $($_.Exception.Message)",
    "Repo: $RepoRoot",
    "Status file: $statusPath"
  ) -join "`n"
  $status.alert = Send-WatchdogAlert -Env $envValues -Text $alertText
}

Write-JsonFile -Path $statusPath -Value $status
Write-JsonLine -Path $eventPath -Value $status
