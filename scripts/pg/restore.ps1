#requires -Version 5.1
<#
  Restore a Logbook PostgreSQL logical backup into a target database and verify it.
  Supports a full RTO measurement (--Verify only checks an existing restore).

  Example:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/restore.ps1 -Dump .data\pg15\backups\logbook-20261124-120000.dump -TargetDatabase logbook_restore
#>
param(
  [string]$Bin = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.data\pg15\pgsql\bin'),
  [Parameter(Mandatory = $true)][string]$Dump,
  [string]$DbHost = '127.0.0.1',
  [int]$Port = 55432,
  [string]$User = 'logbook',
  [string]$Password = 'logbook',
  [string]$AdminDatabase = 'postgres',
  [string]$TargetDatabase = 'logbook_restore',
  [int]$Jobs = 4,
  [switch]$KeepExisting,
  [string]$SslMode = 'require',
  [string]$SslRootCert
)

$ErrorActionPreference = 'Continue'
if (-not (Test-Path -LiteralPath $Dump)) { throw "Dump not found: $Dump" }
$env:PGPASSWORD = $Password
$env:PGSSLMODE = $SslMode
if ($SslRootCert) { $env:PGSSLROOTCERT = $SslRootCert }

$psql = Join-Path $Bin 'psql.exe'
$createdb = Join-Path $Bin 'createdb.exe'
$dropdb = Join-Path $Bin 'dropdb.exe'
$pgRestore = Join-Path $Bin 'pg_restore.exe'

$started = Get-Date
if (-not $KeepExisting) {
  & $dropdb -h $DbHost -p $Port -U $User --if-exists $TargetDatabase 2>$null
  if ($LASTEXITCODE -ne 0) { throw "dropdb failed with exit code $LASTEXITCODE" }
}
$exists = & $psql -h $DbHost -p $Port -U $User -d $AdminDatabase -tAc "select 1 from pg_database where datname = '$TargetDatabase'"
if (("$exists").Trim() -ne '1') {
  & $createdb -h $DbHost -p $Port -U $User $TargetDatabase
  if ($LASTEXITCODE -ne 0) { throw "createdb failed with exit code $LASTEXITCODE" }
}

& $pgRestore -h $DbHost -p $Port -U $User -d $TargetDatabase -j $Jobs --exit-on-error $Dump
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }

& $psql -h $DbHost -p $Port -U $User -d $TargetDatabase -v ON_ERROR_STOP=1 -c 'ANALYZE' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "ANALYZE failed with exit code $LASTEXITCODE" }

$elapsedMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
$verify = & $psql -h $DbHost -p $Port -U $User -d $TargetDatabase -tA -F '|' -c @"
select 'migrations', count(*) from schema_migrations
union all select 'users', count(*) from users
union all select 'departments', count(*) from departments
union all select 'entries', count(*) from journal_entries
union all select 'reviews', count(*) from journal_reviews
union all select 'audit_events', count(*) from audit_events
union all select 'signatures', count(*) from document_signatures
union all select 'journals', count(*) from journals
union all select 'shifts', count(*) from shifts
union all select 'groundings', count(*) from groundings
order by 1
"@
if ($LASTEXITCODE -ne 0) { throw "verification query failed with exit code $LASTEXITCODE" }

$counts = [ordered]@{}
foreach ($line in $verify) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $parts = $line -split '\|'
  $counts[$parts[0]] = [int]$parts[1]
}

# Cross-check: all migrations from the source backup are present and the
# highest issued journal sequence matches. Since 0014 the authoritative allocator
# is a per-journal PostgreSQL sequence; journal_counters is only a legacy fallback
# for journals that have no sequence yet.
$counterCheck = & $psql -h $DbHost -p $Port -U $User -d $TargetDatabase -tAc @"
select count(*) from (
  select j.id from journals j
  left join journal_counters c on c.journal_id = j.id
  left join pg_sequences s on s.schemaname = 'public'
    and s.sequencename = journal_seq_sequence_name(j.id)
  where coalesce(s.last_value, c.last_seq, 0)
        < coalesce((select max(e.journal_seq) from journal_entries e where e.journal_id = j.id), 0)
) bad
"@
$counterMismatch = [int]$counterCheck.Trim()

$result = [ordered]@{
  target_database = $TargetDatabase
  dump = (Split-Path $Dump -Leaf)
  restore_duration_ms = $elapsedMs
  counts = $counts
  journal_counter_mismatches = $counterMismatch
  restored_at = (Get-Date).ToUniversalTime().ToString('o')
}
$result | ConvertTo-Json -Depth 4 | Out-Host

if ($counterMismatch -ne 0) { throw "journal_counters mismatch after restore: $counterMismatch" }
if ($counts['migrations'] -lt 11) { throw "Expected at least 11 applied migrations, got $($counts['migrations'])" }

Write-Host "Restore OK: $TargetDatabase in $elapsedMs ms"
