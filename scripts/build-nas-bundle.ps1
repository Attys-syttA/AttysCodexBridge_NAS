$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$bundleRoot = Join-Path $repoRoot "telegram_codex_bot"
$bridgeRoot = Join-Path $bundleRoot "bridge"
$bridgeStateDir = Join-Path $bundleRoot "bridge-state"
$bridgeLogsDir = Join-Path $bundleRoot "bridge-logs"
$bridgeConfigDir = Join-Path $bundleRoot "bridge-config"

$existingEnv = $null
$existingEnvPath = Join-Path $bridgeRoot ".env"
if (Test-Path -LiteralPath $existingEnvPath) {
  $existingEnv = Get-Content -LiteralPath $existingEnvPath -Raw
}

Set-Location $repoRoot
npm run build

foreach ($path in @($bundleRoot, $bridgeRoot, $bridgeStateDir, $bridgeLogsDir, $bridgeConfigDir)) {
  if (-not (Test-Path -LiteralPath $path)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  }
}

Get-ChildItem -LiteralPath $bridgeRoot -Force | Remove-Item -Recurse -Force

$filesToCopy = @(
  ".env.bridge.example",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "Dockerfile.bridge",
  "Dockerfile.bridge.dev",
  "docker-compose.bridge.yml",
  "docker-compose.bridge.dev.yml"
)

foreach ($file in $filesToCopy) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $bridgeRoot $file) -Force
}

foreach ($dir in @("dist", "src")) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $dir) -Destination (Join-Path $bridgeRoot $dir) -Recurse -Force
}

$docsTarget = Join-Path $bridgeRoot "docs"
New-Item -ItemType Directory -Path $docsTarget -Force | Out-Null
foreach ($doc in @(
  "docs\\nas-bridge-setup.hu.md",
  "docs\\nas-shared-folder-layout.hu.md",
  "docs\\worker-setup.hu.md"
)) {
  $fileName = Split-Path -Leaf $doc
  Copy-Item -LiteralPath (Join-Path $repoRoot $doc) -Destination (Join-Path $docsTarget $fileName) -Force
}

$bundleReadme = @"
# telegram_codex_bot NAS csomag

Ez a mappa a Synology NAS-ra szant feltoltos csomag.

## Mappak

- bridge/ - a bridge kontener futtatasahoz szukseges fajlok
- bridge-state/ - runtime allapot
- bridge-logs/ - logok
- bridge-config/ - opcionalis sajat kiegeszito fajlok

## Elsoleges NAS mod

Az alapertelmezett es ajanlott inditas a stabil mod:

- docker-compose.bridge.yml
- Dockerfile.bridge

Ez a mod kesz dist/ builddel fut, nem hasznal tsx watch-ot.

## Opcionalis NAS dev mod

Csak hibakereseshez:

- docker-compose.bridge.dev.yml
- Dockerfile.bridge.dev

Ez a mod forraskodot es tsx watch-ot hasznal, ezert DS223j-n nem ez az ajanlott ut.
"@
Set-Content -LiteralPath (Join-Path $bundleRoot "README.hu.md") -Value $bundleReadme -Encoding UTF8

$bridgeReadme = @"
# Bridge csomag

## Stabil NAS inditas

- compose: docker-compose.bridge.yml
- Dockerfile: Dockerfile.bridge
- futas: node dist/index.js

## NAS dev inditas

- compose: docker-compose.bridge.dev.yml
- Dockerfile: Dockerfile.bridge.dev
- futas: tsx watch src/index.ts

## Fontos

- A stabil mod az elsoleges.
- A src/ mappa a dev mod miatt marad benne.
- A worker kulon PC-n fut, nem ezen a bridge konteneren belul.
"@
Set-Content -LiteralPath (Join-Path $bridgeRoot "README.hu.md") -Value $bridgeReadme -Encoding UTF8

if ($existingEnv -ne $null) {
  Set-Content -LiteralPath $existingEnvPath -Value $existingEnv -Encoding UTF8
}

Write-Host "NAS bundle updated at: $bundleRoot"
