#requires -Version 5.1
<#
  Local PostgreSQL 15 lab for the Logbook acceptance run (no Docker required).

  - downloads the official EDB PostgreSQL 15 Windows binaries (once),
  - initdb with SCRAM-SHA-256,
  - self-signed TLS certificate (openssl from the PostgreSQL bundle),
  - hostssl-only pg_hba, WAL archiving enabled,
  - starts the cluster and creates the `logbook` database.

  Example:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/bootstrap-pg15.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/bootstrap-pg15.ps1 -Stop
#>
param(
  [string]$Root = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.data\pg15'),
  [int]$Port = 55432,
  [string]$Superuser = 'logbook',
  [string]$Password = 'logbook',
  [string]$Database = 'logbook',
  [string]$PgVersion = '15.15',
  [switch]$SkipDownload,
  [switch]$Stop,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Bin = Join-Path $Root 'pgsql\bin'
$Data = Join-Path $Root 'data'
$Archive = Join-Path $Root 'wal_archive'
$CertDir = Join-Path $Root 'certs'
$Log = Join-Path $Root 'server.log'

function Get-PgTool([string]$Name) {
  $path = Join-Path $Bin "$Name.exe"
  if (-not (Test-Path $path)) { throw "PostgreSQL tool not found: $path" }
  return $path
}

if ($Stop) {
  if (Test-Path (Join-Path $Data 'postmaster.pid')) {
    & (Get-PgTool 'pg_ctl') -D $Data stop -m fast | Out-Host
  } else {
    Write-Host 'Cluster is not running.'
  }
  exit 0
}

New-Item -ItemType Directory -Force -Path $Root, $Archive, $CertDir | Out-Null

if (-not (Test-Path (Join-Path $Bin 'postgres.exe'))) {
  if ($SkipDownload) { throw "PostgreSQL binaries are missing in $Bin and -SkipDownload is set." }
  $zip = Join-Path $Root "postgresql-$PgVersion-binaries.zip"
  if (-not (Test-Path $zip)) {
    $url = "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-1-windows-x64-binaries.zip"
    Write-Host "Downloading $url"
    & curl.exe -L --fail --retry 3 -o $zip $url
    if ($LASTEXITCODE -ne 0) { throw "Download failed with exit code $LASTEXITCODE" }
  }
  Write-Host "Extracting $zip"
  & tar.exe -xf $zip -C $Root
  if ($LASTEXITCODE -ne 0) { throw "Extraction failed with exit code $LASTEXITCODE" }
}
& (Get-PgTool 'postgres') --version

if ((Test-Path $Data) -and $Force) {
  & (Get-PgTool 'pg_ctl') -D $Data stop -m immediate 2>$null | Out-Null
  Remove-Item -Recurse -Force $Data
}

if (-not (Test-Path (Join-Path $Data 'PG_VERSION'))) {
  $pwFile = Join-Path $Root 'initdb-password.txt'
  Set-Content -Path $pwFile -Value $Password -NoNewline -Encoding ascii
  Write-Host 'Initializing cluster (UTF8, SCRAM-SHA-256, superuser logbook)'
  & (Get-PgTool 'initdb') -D $Data -U $Superuser -A scram-sha-256 --pwfile=$pwFile -E UTF8 --locale=C | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "initdb failed with exit code $LASTEXITCODE" }
  Remove-Item -Force $pwFile
}

# --- TLS certificate (self-signed, TLS 1.2+) --------------------------------
$cert = Join-Path $CertDir 'server.crt'
$key = Join-Path $CertDir 'server.key'
if (-not (Test-Path $cert) -or -not (Test-Path $key)) {
  # The EDB 15 bundle has no openssl.exe; make-cert.mjs falls back to the
  # pure-JS `selfsigned` package (npm install --no-save selfsigned).
  $openssl = Join-Path $Bin 'openssl.exe'
  if (Test-Path $openssl) { $env:OPENSSL_PATH = $openssl }
  $node = (Get-Command node -ErrorAction Stop).Source
  & $node (Join-Path $PSScriptRoot 'make-cert.mjs') $CertDir
  if ($LASTEXITCODE -ne 0) { throw "Certificate generation failed with exit code $LASTEXITCODE" }
}

# --- Cluster configuration --------------------------------------------------
$confFile = Join-Path $Data 'postgresql.conf'
$marker = '# --- logbook pg15 acceptance lab ---'
$existing = Get-Content $confFile -Raw
if ($existing -notmatch [regex]::Escape($marker)) {
  $archiveCommand = "copy `"%p`" `"$($Archive.Replace('\','/'))/%f`""
  $conf = @"

$marker
port = $Port
listen_addresses = '127.0.0.1'
password_encryption = 'scram-sha-256'
ssl = on
ssl_cert_file = '$($cert.Replace('\','/'))'
ssl_key_file = '$($key.Replace('\','/'))'
ssl_min_protocol_version = 'TLSv1.2'
shared_buffers = '256MB'
work_mem = '8MB'
maintenance_work_mem = '128MB'
max_connections = 100
wal_level = 'replica'
max_wal_senders = 10
max_replication_slots = 10
archive_mode = on
archive_command = '$archiveCommand'
archive_timeout = '60s'
logging_collector = on
log_directory = 'log'
log_min_duration_statement = 250
log_checkpoints = on
log_lock_waits = on
log_temp_files = 0
timezone = 'UTC'
"@
  Add-Content -Path $confFile -Value $conf -Encoding ascii
}

$hbaFile = Join-Path $Data 'pg_hba.conf'
# Overwrite instead of append: initdb's default `host all ...` line would
# otherwise match before our hostnossl reject rules (pg_hba is order-sensitive).
$hba = @"
# logbook pg15 acceptance lab: TLS-only local access (hostssl only)
hostssl all all 127.0.0.1/32 scram-sha-256
hostssl all all ::1/128 scram-sha-256
hostssl replication logbook 127.0.0.1/32 scram-sha-256
hostssl replication replicator 127.0.0.1/32 scram-sha-256
hostnossl all all 127.0.0.1/32 reject
hostnossl all all ::1/128 reject
"@
Set-Content -Path $hbaFile -Value $hba -Encoding ascii

$pidFile = Join-Path $Data 'postmaster.pid'
if (Test-Path $pidFile) {
  $pidValue = (Get-Content $pidFile -First 1)
  $pgProcess = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if (-not $pgProcess) {
    Write-Host "Removing stale postmaster.pid (PID $pidValue is not running)"
    Remove-Item -Force $pidFile
  }
}

if (Test-Path $pidFile) {
  Write-Host 'Cluster already running; reloading configuration.'
  & (Get-PgTool 'pg_ctl') -D $Data reload *> (Join-Path $Root 'pg_ctl-reload.log')
  Get-Content (Join-Path $Root 'pg_ctl-reload.log') -Tail 5 | Out-Host
} else {
  Write-Host "Starting PostgreSQL on 127.0.0.1:$Port (TLS only)"
  # Start-Process with redirected files and WITHOUT -Wait: -Wait also waits for
  # the postgres child (never exits). Readiness is polled with pg_isready.
  $startOut = Join-Path $Root 'pg_ctl-start.out.log'
  $startErr = Join-Path $Root 'pg_ctl-start.err.log'
  Start-Process -FilePath (Get-PgTool 'pg_ctl') `
    -ArgumentList @('-D', $Data, '-l', $Log, 'start') `
    -NoNewWindow -PassThru `
    -RedirectStandardOutput $startOut -RedirectStandardError $startErr | Out-Null
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    & (Get-PgTool 'pg_isready') -h 127.0.0.1 -p $Port -t 2 *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  }
  if (-not $ready) {
    Get-Content $startOut -Tail 10 -ErrorAction SilentlyContinue | Out-Host
    Get-Content $startErr -Tail 20 -ErrorAction SilentlyContinue | Out-Host
    Get-Content $Log -Tail 40 -ErrorAction SilentlyContinue | Out-Host
    throw "PostgreSQL did not become ready on 127.0.0.1:$Port"
  }
  Get-Content $startOut -Tail 5 -ErrorAction SilentlyContinue | Out-Host
}

$env:PGPASSWORD = $Password
$env:PGSSLMODE = 'require'
$psql = Get-PgTool 'psql'
$exists = & $psql -h 127.0.0.1 -p $Port -U $Superuser -d postgres -tAc "select 1 from pg_database where datname = '$Database'"
if (("$exists").Trim() -ne '1') {
  & (Get-PgTool 'createdb') -h 127.0.0.1 -p $Port -U $Superuser $Database
  if ($LASTEXITCODE -ne 0) { throw "createdb failed with exit code $LASTEXITCODE" }
}

& $psql -h 127.0.0.1 -p $Port -U $Superuser -d $Database -c "select version() as version, current_setting('ssl') as ssl, current_setting('ssl_min_protocol_version') as min_tls" | Out-Host

Write-Host ""
Write-Host "DATABASE_URL=postgres://${Superuser}:${Password}@127.0.0.1:${Port}/${Database}?sslmode=verify-full"
Write-Host "CA certificate: $cert"
Write-Host "WAL archive:    $Archive"
