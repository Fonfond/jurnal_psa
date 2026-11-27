#requires -Version 5.1
<#
  PITR drill on the local PostgreSQL 15 lab: base backup + WAL archive restore to
  a point in time. Proves RPO/RTO mechanics for ADM-06 without Docker.

  Example:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/pitr-drill.ps1
#>
param(
  [string]$Bin = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.data\pg15\pgsql\bin'),
  [string]$Root = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.data\pg15'),
  [string]$DbHost = '127.0.0.1',
  [int]$Port = 55432,
  [int]$RecoveryPort = 55434,
  [string]$User = 'logbook',
  [string]$Password = 'logbook',
  [string]$Database = 'logbook',
  [string]$DepartmentId = '01930000-0000-7000-8000-000000000001',
  [string]$SslMode = 'require'
)

$ErrorActionPreference = 'Continue'
$env:PGPASSWORD = $Password
$env:PGSSLMODE = $SslMode
$psql = Join-Path $Bin 'psql.exe'
$baseDir = Join-Path $Root 'pitr_base'
$recoveryDir = Join-Path $Root 'pitr_recovery'
$archive = Join-Path $Root 'wal_archive'
$cert = Join-Path $Root 'certs\server.crt'
$key = Join-Path $Root 'certs\server.key'
# PostgreSQL strips backslashes in config values; cmd copy needs them. The
# wrapper converts forward-slash paths (see scripts/pg/restore-wal.cmd).
$restoreCmd = (Join-Path $PSScriptRoot 'restore-wal.cmd').Replace('\', '/')
$archiveFwd = $archive.Replace('\', '/')

function Assert-Psql([string]$sql, [string]$db = $Database) {
  $output = & $psql -h $DbHost -p $Port -U $User -d $db -v ON_ERROR_STOP=1 -tAc $sql 2>&1
  if ($LASTEXITCODE -ne 0) { throw "SQL failed: $sql`n$output" }
  return ($output | Out-String).Trim()
}

Write-Host '1/6 Taking base backup with WAL streaming...'
if (Test-Path $baseDir) { Remove-Item -Recurse -Force $baseDir }
& (Join-Path $Bin 'pg_basebackup.exe') -h $DbHost -p $Port -U $User -D $baseDir -X stream -c fast 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "pg_basebackup failed with exit code $LASTEXITCODE" }

Write-Host '2/6 Writing PITR marker BEFORE the target time...'
$beforeId = [guid]::NewGuid().ToString()
$afterId = [guid]::NewGuid().ToString()
$runId = (Get-Date -Format 'yyyyMMddHHmmss')
Assert-Psql "insert into users (id, external_id, full_name, role, department_id, status) values ('$beforeId','pitr-before-$runId','PITR Before','worker','$DepartmentId','active')" | Out-Null
# Target time is after marker 1 committed and before marker 2 exists.
$target = Assert-Psql "select (now() + interval '1 second')::text"
Assert-Psql 'select pg_switch_wal()' | Out-Null
Start-Sleep -Seconds 2

Write-Host "3/6 Writing PITR marker AFTER the target time ($target)..."
Assert-Psql "insert into users (id, external_id, full_name, role, department_id, status) values ('$afterId','pitr-after-$runId','PITR After','worker','$DepartmentId','active')" | Out-Null
Assert-Psql 'select pg_switch_wal()' | Out-Null
Start-Sleep -Seconds 2

Write-Host '4/6 Preparing recovery cluster...'
if (Test-Path $recoveryDir) { Remove-Item -Recurse -Force $recoveryDir }
Copy-Item -Recurse -Path $baseDir -Destination $recoveryDir
$recoveryConf = @"

# --- logbook PITR drill ---
port = $RecoveryPort
listen_addresses = '127.0.0.1'
ssl = on
ssl_cert_file = '$($cert.Replace('\','/'))'
ssl_key_file = '$($key.Replace('\','/'))'
archive_mode = off
archive_command = ''
restore_command = '"$restoreCmd" "$archiveFwd" %f %p'
recovery_target_time = '$target'
recovery_target_action = 'promote'
"@
Add-Content -Path (Join-Path $recoveryDir 'postgresql.auto.conf') -Value $recoveryConf -Encoding ascii
New-Item -ItemType File -Force -Path (Join-Path $recoveryDir 'recovery.signal') | Out-Null

Write-Host '5/6 Starting recovery to the target time...'
$recoveryLog = Join-Path $Root 'pitr_recovery.log'
$startOut = Join-Path $Root 'pitr_start.out.log'
$startErr = Join-Path $Root 'pitr_start.err.log'
Start-Process -FilePath (Join-Path $Bin 'pg_ctl.exe') `
  -ArgumentList @('-D', $recoveryDir, '-l', $recoveryLog, 'start') `
  -NoNewWindow -PassThru `
  -RedirectStandardOutput $startOut -RedirectStandardError $startErr | Out-Null
$ready = $false
for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  & (Join-Path $Bin 'pg_isready.exe') -h $DbHost -p $RecoveryPort -t 2 *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
}
if (-not $ready) {
  Get-Content $recoveryLog -Tail 60 -ErrorAction SilentlyContinue | Out-Host
  throw "Recovery cluster did not become ready on port $RecoveryPort"
}

$before = & $psql -h $DbHost -p $RecoveryPort -U $User -d $Database -tAc "select count(*) from users where external_id = 'pitr-before-$runId'" 2>&1
$after = & $psql -h $DbHost -p $RecoveryPort -U $User -d $Database -tAc "select count(*) from users where external_id = 'pitr-after-$runId'" 2>&1
# pg_isready reports read-only startup before recovery_target_action runs; wait
# until the server has actually left recovery (promoted).
$inRecovery = 'true'
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
  $value = & $psql -h $DbHost -p $RecoveryPort -U $User -d $Database -tAc "select case when pg_is_in_recovery() then 'true' else 'false' end" 2>&1
  $inRecovery = ("$value" | Out-String).Trim()
  if ($inRecovery -eq 'false') { break }
  Start-Sleep -Milliseconds 500
}
$timeline = & $psql -h $DbHost -p $RecoveryPort -U $User -d $Database -tAc "select timeline_id from pg_control_checkpoint()" 2>&1
$result = [ordered]@{
  target_time = $target
  recovery_port = $RecoveryPort
  marker_before_present = ("$before".Trim() -eq '1')
  marker_after_present = ("$after".Trim() -eq '1')
  promoted = ($inRecovery -eq 'false')
  timeline_id = ("$timeline" | Out-String).Trim()
}
$result | ConvertTo-Json | Out-Host

Write-Host '6/6 Stopping recovery cluster...'
& (Join-Path $Bin 'pg_ctl.exe') -D $recoveryDir stop -m fast *> (Join-Path $Root 'pitr_stop.log')
Get-Content (Join-Path $Root 'pitr_stop.log') -Tail 3 -ErrorAction SilentlyContinue | Out-Host

if (-not $result.marker_before_present) { throw 'PITR drill failed: marker BEFORE target is missing' }
if ($result.marker_after_present) { throw 'PITR drill failed: marker AFTER target was replayed' }
if (-not $result.promoted) { throw 'PITR drill failed: recovery did not promote' }
Write-Host "PITR OK: restored to $target, timeline $($result.timeline_id), marker after target excluded"
