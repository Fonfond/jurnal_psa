#requires -Version 5.1
<#
  Logical backup for Logbook PostgreSQL (pg_dump custom format + globals).
  Implements ADM-06: daily dump, SHA-256 control sum, manifest, 30-day retention.

  Example:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/backup.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/backup.ps1 -KeepDays 30
#>
param(
  [string]$Bin = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.data\pg15\pgsql\bin'),
  [string]$Root = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.data\pg15'),
  [string]$DbHost = '127.0.0.1',
  [int]$Port = 55432,
  [string]$User = 'logbook',
  [string]$Password = 'logbook',
  [string]$Database = 'logbook',
  [string]$OutDir,
  [int]$KeepDays = 30,
  [string]$SslMode = 'require',
  [string]$SslRootCert
)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path $Root 'backups' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$env:PGPASSWORD = $Password
$env:PGSSLMODE = $SslMode
if ($SslRootCert) { $env:PGSSLROOTCERT = $SslRootCert }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dump = Join-Path $OutDir "$Database-$stamp.dump"
$globals = Join-Path $OutDir "globals-$stamp.sql"
$manifestPath = Join-Path $OutDir "$Database-$stamp.manifest.json"

$started = Get-Date
& (Join-Path $Bin 'pg_dump.exe') -h $DbHost -p $Port -U $User -d $Database -Fc -Z 6 -f $dump
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

& (Join-Path $Bin 'pg_dumpall.exe') -h $DbHost -p $Port -U $User --globals-only -f $globals
if ($LASTEXITCODE -ne 0) { throw "pg_dumpall failed with exit code $LASTEXITCODE" }

$dumpHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dump).Hash.ToLowerInvariant()
$globalsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $globals).Hash.ToLowerInvariant()
Set-Content -Path "$dump.sha256" -Value "$dumpHash  $(Split-Path $dump -Leaf)" -Encoding ascii
Set-Content -Path "$globals.sha256" -Value "$globalsHash  $(Split-Path $globals -Leaf)" -Encoding ascii

$dumpSize = (Get-Item $dump).Length
$elapsedMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
$manifest = [ordered]@{
  database = $Database
  created_at = (Get-Date).ToUniversalTime().ToString('o')
  duration_ms = $elapsedMs
  dump_file = (Split-Path $dump -Leaf)
  dump_bytes = $dumpSize
  dump_sha256 = $dumpHash
  globals_file = (Split-Path $globals -Leaf)
  globals_sha256 = $globalsHash
  ssl_mode = $SslMode
  retention_days = $KeepDays
}
$manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding utf8

# Retention: remove dumps/manifests/checksums older than KeepDays.
$cutoff = (Get-Date).AddDays(-$KeepDays)
Get-ChildItem -Path $OutDir -File | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Force
  Write-Host "retention: removed $($_.Name)"
}

Write-Host "Backup OK: $dump"
Write-Host "  bytes=$dumpSize sha256=$dumpHash duration_ms=$elapsedMs"
Write-Host "  globals=$globals"
Write-Host "  manifest=$manifestPath"
