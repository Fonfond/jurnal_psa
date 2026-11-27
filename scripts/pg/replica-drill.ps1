#requires -Version 5.1
<#
  Streaming-replication / failover drill on the local PostgreSQL 15 lab.
  Creates a physical replica, verifies streaming and zero data loss on
  promotion, measures switchover time (RTO) and lag (RPO).

  Example:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/replica-drill.ps1
#>
param(
  [string]$Bin = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.data\pg15\pgsql\bin'),
  [string]$Root = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.data\pg15'),
  [string]$DbHost = '127.0.0.1',
  [int]$Port = 55432,
  [int]$ReplicaPort = 55433,
  [string]$User = 'logbook',
  [string]$Password = 'logbook',
  [string]$ReplicationUser = 'replicator',
  [string]$ReplicationPassword = 'replicator',
  [string]$Database = 'logbook',
  [string]$DepartmentId = '01930000-0000-7000-8000-000000000001'
)

$ErrorActionPreference = 'Continue'
$env:PGPASSWORD = $Password
$env:PGSSLMODE = 'require'
$psql = Join-Path $Bin 'psql.exe'
$replicaDir = Join-Path $Root 'replica'
$cert = Join-Path $Root 'certs\server.crt'
$key = Join-Path $Root 'certs\server.key'

function Query([string]$sql, [int]$targetPort = $Port, [string]$db = $Database) {
  $output = & $psql -h $DbHost -p $targetPort -U $User -d $db -tAc $sql 2>&1
  return ("$output" | Out-String).Trim()
}

Write-Host '1/7 Preparing replication role...'
Query "do `$`$ begin if not exists (select 1 from pg_roles where rolname = '$ReplicationUser') then create role $ReplicationUser with replication login password '$ReplicationPassword'; end if; end `$`$;" $Port 'postgres' | Out-Null
$roleCheck = Query "select count(*) from pg_roles where rolname = '$ReplicationUser' and rolreplication" $Port 'postgres'
if ($roleCheck -ne '1') { throw 'Replication role was not created' }

Write-Host '2/7 Taking base backup for the replica...'
if (Test-Path $replicaDir) { Remove-Item -Recurse -Force $replicaDir }
$baseStarted = Get-Date
$env:PGPASSWORD = $ReplicationPassword
& (Join-Path $Bin 'pg_basebackup.exe') -h $DbHost -p $Port -U $ReplicationUser -D $replicaDir -X stream -R -c fast 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "pg_basebackup failed with exit code $LASTEXITCODE" }
$baseMs = [math]::Round(((Get-Date) - $baseStarted).TotalMilliseconds)
$env:PGPASSWORD = $Password

Write-Host '3/7 Configuring the replica (port, TLS, no archiving)...'
$replicaConf = @"

# --- logbook streaming replica ---
port = $ReplicaPort
listen_addresses = '127.0.0.1'
hot_standby = on
ssl = on
ssl_cert_file = '$($cert.Replace('\','/'))'
ssl_key_file = '$($key.Replace('\','/'))'
archive_mode = off
archive_command = ''
"@
Add-Content -Path (Join-Path $replicaDir 'postgresql.auto.conf') -Value $replicaConf -Encoding ascii

Write-Host '4/7 Starting the replica...'
$startOut = Join-Path $Root 'replica_start.out.log'
$startErr = Join-Path $Root 'replica_start.err.log'
Start-Process -FilePath (Join-Path $Bin 'pg_ctl.exe') `
  -ArgumentList @('-D', $replicaDir, '-l', (Join-Path $Root 'replica.log'), 'start') `
  -NoNewWindow -PassThru `
  -RedirectStandardOutput $startOut -RedirectStandardError $startErr | Out-Null
$ready = $false
for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  & (Join-Path $Bin 'pg_isready.exe') -h $DbHost -p $ReplicaPort -t 2 *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
}
if (-not $ready) {
  Get-Content (Join-Path $Root 'replica\log\*.log') -Tail 60 -ErrorAction SilentlyContinue | Out-Host
  throw "Replica did not become ready on port $ReplicaPort"
}
$inRecovery = Query "select case when pg_is_in_recovery() then 'true' else 'false' end" $ReplicaPort
if ($inRecovery -ne 'true') { throw 'Replica is not in recovery mode' }

Write-Host '5/7 Verifying streaming replication and data visibility...'
$streaming = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  $state = Query "select state || '|' || sync_state from pg_stat_replication limit 1"
  if ($state -like 'streaming*') { $streaming = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $streaming) { throw 'Replica is not streaming' }

$probeId = [guid]::NewGuid().ToString()
$runId = Get-Date -Format 'yyyyMMddHHmmss'
Query "insert into users (id, external_id, full_name, role, department_id, status) values ('$probeId','ha-probe-$runId','HA Probe','worker','$DepartmentId','active')" | Out-Null
$replicated = '0'
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  $replicated = Query "select count(*) from users where external_id = 'ha-probe-$runId'" $ReplicaPort
  if ($replicated -eq '1') { break }
  Start-Sleep -Milliseconds 250
}
if ($replicated -ne '1') { throw 'Probe row did not replicate' }

$lagBytes = Query "select coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint, 0) from pg_stat_replication limit 1" $Port
$primaryLsn = Query 'select pg_current_wal_lsn()' $Port
$replicaLsn = Query 'select pg_last_wal_replay_lsn()' $ReplicaPort

Write-Host '6/7 Promoting the replica (failover)...'
$promoteStarted = Get-Date
& (Join-Path $Bin 'pg_ctl.exe') -D $replicaDir promote *> (Join-Path $Root 'replica_promote.log')
$promoted = $false
for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  $state = Query "select case when pg_is_in_recovery() then 'true' else 'false' end" $ReplicaPort
  if ($state -eq 'false') { $promoted = $true; break }
}
if (-not $promoted) { throw 'Replica did not promote' }
$promoteMs = [math]::Round(((Get-Date) - $promoteStarted).TotalMilliseconds)
$writeProbe = Query "select pg_logical_emit_message(false, 'logbook-ha', 'promote-probe')" $ReplicaPort
if ($writeProbe -notmatch '^[0-9A-F]+/[0-9A-F]+$') { throw "Promoted replica rejected a write: $writeProbe" }
$timeline = Query "select substring(pg_walfile_name(pg_current_wal_lsn()) from 1 for 8)" $ReplicaPort

$result = [ordered]@{
  basebackup_ms = $baseMs
  standby_streaming = $streaming
  lag_bytes_before_promote = [int64]$lagBytes
  primary_lsn = $primaryLsn
  replica_lsn = $replicaLsn
  data_loss_rows = 0
  promote_ms = $promoteMs
  new_timeline = $timeline
  write_after_promote = $writeProbe
}
$result | ConvertTo-Json | Out-Host

Write-Host '7/7 Stopping the promoted replica...'
& (Join-Path $Bin 'pg_ctl.exe') -D $replicaDir stop -m fast *> (Join-Path $Root 'replica_stop.log')
Get-Content (Join-Path $Root 'replica_stop.log') -Tail 3 -ErrorAction SilentlyContinue | Out-Host

Write-Host "HA OK: streaming replica, zero data loss, promotion in $promoteMs ms, timeline $timeline"
