$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root '.data\pglite'

Write-Host "Local PGlite will be deleted: $DataDir" -ForegroundColor Yellow
$answer = Read-Host 'Continue? (yes/no)'
if ($answer -ne 'yes') {
  Write-Host 'Cancelled.'
  exit 0
}

if (Test-Path -LiteralPath $DataDir) {
  $resolved = (Resolve-Path -LiteralPath $DataDir).Path
  if ($resolved -ne $DataDir) {
    throw "Unexpected path: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
  Write-Host 'Local database removed.' -ForegroundColor DarkGray
}

Set-Location $Root
npm run db:seed
if ($LASTEXITCODE -ne 0) { throw 'db:seed failed' }
Write-Host 'Done: seed 3 users / 3 permits / 5 entries.' -ForegroundColor Green
