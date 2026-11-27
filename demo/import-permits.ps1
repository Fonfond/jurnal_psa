$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
node demo/import-permits.mjs
if ($LASTEXITCODE -ne 0) { throw 'import failed' }
