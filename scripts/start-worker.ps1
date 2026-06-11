$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$workerEnvPath = Join-Path $repoRoot "worker\.env"

if (-not (Test-Path -LiteralPath $workerEnvPath)) {
  throw "Nem találom a worker .env fájlt itt: $workerEnvPath"
}

Get-Content -LiteralPath $workerEnvPath | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) {
    return
  }

  if ($line.StartsWith("export ")) {
    $line = $line.Substring(7).Trim()
  }

  $separatorIndex = $line.IndexOf("=")
  if ($separatorIndex -lt 1) {
    return
  }

  $name = $line.Substring(0, $separatorIndex).Trim()
  $value = $line.Substring($separatorIndex + 1).Trim()

  if (
    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
    ($value.StartsWith("'") -and $value.EndsWith("'"))
  ) {
    $value = $value.Substring(1, $value.Length - 2)
  }

  [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}

Set-Location $repoRoot
npm run start:worker
