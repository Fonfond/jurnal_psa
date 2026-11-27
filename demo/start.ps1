$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host 'Logbook demo: preparing...' -ForegroundColor Cyan
npm run build:shared
if ($LASTEXITCODE -ne 0) { throw 'build:shared failed' }
npm run db:seed
if ($LASTEXITCODE -ne 0) { throw 'db:seed failed' }

$Shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
Write-Host "Starting API and web with $Shell..." -ForegroundColor Cyan
Start-Process $Shell -ArgumentList @(
  '-NoExit',
  '-Command',
  "Set-Location '$Root'; npm run dev:api"
)
Start-Process $Shell -ArgumentList @(
  '-NoExit',
  '-Command',
  "Set-Location '$Root'; npm run dev:web"
)

Start-Sleep -Seconds 6
Start-Process 'http://localhost:5173'
Write-Host ''
Write-Host 'Ready: http://localhost:5173' -ForegroundColor Green
Write-Host 'Login: worker@logbook.local / Logbook!2026' -ForegroundColor Green
Write-Host 'Stop: close API and web windows.' -ForegroundColor DarkGray
