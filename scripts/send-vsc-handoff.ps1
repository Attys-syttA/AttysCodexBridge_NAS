param(
  [Parameter(Mandatory = $true)]
  [string]$ThreadId,

  [string]$Workspace = (Get-Location).Path,
  [string]$ChatId,
  [int]$MessageThreadId,
  [string]$Model,
  [string]$SourceHost = "vsc",
  [string]$TargetHost,
  [int]$TtlMinutes = 60,
  [switch]$Pending,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Read-DotEnv {
  param([string]$Path)

  $values = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    return $values
  }

  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      continue
    }

    if ($line.StartsWith("export ")) {
      $line = $line.Substring(7).Trim()
    }

    $separatorIndex = $line.IndexOf("=")
    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $line.Substring(0, $separatorIndex).Trim()
    $value = $line.Substring($separatorIndex + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $values[$key] = $value
  }

  return $values
}

function Get-ConfigValue {
  param(
    [hashtable]$EnvFile,
    [string]$Name,
    [switch]$PreferEnvFile
  )

  if ($PreferEnvFile -and $EnvFile[$Name]) {
    return $EnvFile[$Name]
  }

  $environmentValue = [Environment]::GetEnvironmentVariable($Name)
  if ($environmentValue) {
    return $environmentValue
  }

  return $EnvFile[$Name]
}

function Resolve-ConfigPath {
  param(
    [string]$RawPath,
    [string]$BasePath
  )

  if (-not $RawPath) {
    return $null
  }

  if ([System.IO.Path]::IsPathRooted($RawPath)) {
    return [System.IO.Path]::GetFullPath($RawPath)
  }

  return [System.IO.Path]::GetFullPath((Join-Path -Path $BasePath -ChildPath $RawPath))
}

if ($ThreadId -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$") {
  throw "ThreadId does not look like a Codex thread id: $ThreadId"
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath ".."))
$envPath = Join-Path -Path $repoRoot -ChildPath ".env"
$envFile = Read-DotEnv -Path $envPath

$telegramBotToken = Get-ConfigValue -EnvFile $envFile -Name "TELEGRAM_BOT_TOKEN" -PreferEnvFile
$allowedUserIds = Get-ConfigValue -EnvFile $envFile -Name "TELEGRAM_ALLOWED_USER_IDS" -PreferEnvFile
$stateDirRaw = Get-ConfigValue -EnvFile $envFile -Name "TELECODEX_STATE_DIR"
$hostLabel = Get-ConfigValue -EnvFile $envFile -Name "TELECODEX_HOST_LABEL"

if (-not $telegramBotToken -and -not $DryRun) {
  throw "Missing TELEGRAM_BOT_TOKEN. Set it in .env or the process environment."
}

if (-not $ChatId) {
  if (-not $allowedUserIds) {
    throw "Missing ChatId and TELEGRAM_ALLOWED_USER_IDS."
  }

  $ChatId = ($allowedUserIds -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 1)
}

if (-not $ChatId) {
  throw "Could not resolve Telegram chat id."
}

if (-not $TargetHost) {
  $TargetHost = if ($hostLabel) { $hostLabel } else { "$env:COMPUTERNAME\$env:USERNAME" }
}

$stateDir = Resolve-ConfigPath -RawPath $stateDirRaw -BasePath $repoRoot
if (-not $stateDir) {
  $stateDir = Join-Path -Path $repoRoot -ChildPath ".telecodex"
}

$resolvedWorkspace = [System.IO.Path]::GetFullPath($Workspace)
$displayWorkspace = $resolvedWorkspace
if ($resolvedWorkspace.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  $relativeWorkspace = [System.IO.Path]::GetRelativePath($repoRoot, $resolvedWorkspace)
  $displayWorkspace = if ($relativeWorkspace -eq ".") { "AttysCodexBridge" } else { "AttysCodexBridge\$relativeWorkspace" }
}
$createdAt = (Get-Date).ToUniversalTime()
$expiresAt = $createdAt.AddMinutes($TtlMinutes)
$status = if ($Pending) { "pending_inbound" } else { "attached" }
$contextKey = if ($PSBoundParameters.ContainsKey("MessageThreadId")) { "${ChatId}:${MessageThreadId}" } else { "$ChatId" }

$handoff = [ordered]@{
  status = $status
  workspace = $resolvedWorkspace
  threadId = $ThreadId
  sourceHost = $SourceHost
  targetHost = $TargetHost
  createdAt = $createdAt.ToString("o")
  expiresAt = $expiresAt.ToString("o")
}
if ($Model) {
  $handoff.model = $Model
}

$inboxPath = Join-Path -Path $stateDir -ChildPath "handoff-inbox.json"
$inbox = @{}
if (Test-Path -LiteralPath $inboxPath) {
  try {
    $parsedInbox = Get-Content -LiteralPath $inboxPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($parsedInbox -is [hashtable]) {
      $inbox = $parsedInbox
    }
  } catch {
    $inbox = @{}
  }
}

$inbox[$contextKey] = $handoff
$message = @"
VSC/Codex atadas keszen.

Host: $TargetHost
Workspace: $displayWorkspace
Thread ID: $ThreadId
$(if ($Model) { "Model: $Model" } else { "Model: (nincs atadva)" })
Allapot: $status

Ha valaszolsz, a Telegram chat ezt a Codex szalat folytatja.
"@

$body = @{
  chat_id = $ChatId
  text = $message
}
if ($PSBoundParameters.ContainsKey("MessageThreadId")) {
  $body.message_thread_id = $MessageThreadId
}

if ($DryRun) {
  [ordered]@{
    repoRoot = $repoRoot
    stateDir = $stateDir
    inboxPath = $inboxPath
    contextKey = $contextKey
    handoff = $handoff
    telegramMessage = $message
    wouldSendTelegramMessage = [bool]$telegramBotToken
  } | ConvertTo-Json -Depth 6
  exit 0
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$inbox | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $inboxPath -Encoding UTF8

$uri = "https://api.telegram.org/bot$telegramBotToken/sendMessage"
Invoke-RestMethod -Method Post -Uri $uri -ContentType "application/json; charset=utf-8" -Body ($body | ConvertTo-Json -Depth 5) | Out-Null

Write-Host "VSC/Codex handoff sent for context $contextKey."
