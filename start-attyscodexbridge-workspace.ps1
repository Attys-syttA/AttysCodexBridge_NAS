$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $repoRoot '.env'
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^[A-Z0-9_]+=') {
    $key, $value = $_.Split('=', 2)
    Set-Item -Path ("Env:" + $key) -Value $value
  }
}
Set-Location $repoRoot
node (Join-Path $repoRoot 'dist\index.js')
