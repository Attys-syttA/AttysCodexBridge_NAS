$envFile = '<CODEX_WORKS_ON_WORK_PC>\telecodex\.env'
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^[A-Z0-9_]+=') {
    $key, $value = $_.Split('=', 2)
    Set-Item -Path ("Env:" + $key) -Value $value
  }
}
Set-Location '<CODEX_WORKS_ON_WORK_PC>\telecodex'
node '<CODEX_WORKS_ON_WORK_PC>\telecodex\dist\index.js'
