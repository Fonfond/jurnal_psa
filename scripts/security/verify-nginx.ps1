#requires -Version 5.1
<#
  Executable check for the production nginx configuration (AUTH-05).
  Downloads nginx for Windows (if needed), rewrites production paths to a local
  test prefix, generates a self-signed certificate and runs `nginx -t`.

  Example:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/security/verify-nginx.ps1
    ... -Version 1.28.0 -Force
#>
param(
  [string]$Version = '1.28.0',
  [string]$Root = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.data\nginx'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dist = Join-Path $Root "nginx-$Version"
$nginxExe = Join-Path $dist 'nginx.exe'
$prefix = Join-Path $Root 'verify'

if ($Force -and (Test-Path $Root)) {
  Remove-Item -Recurse -Force $Root
}
New-Item -ItemType Directory -Force -Path $Root | Out-Null

if (-not (Test-Path $nginxExe)) {
  $zip = Join-Path $Root "nginx-$Version.zip"
  if (-not (Test-Path $zip)) {
    $url = "https://nginx.org/download/nginx-$Version.zip"
    Write-Host "Downloading $url"
    & curl.exe -L --fail --retry 3 -o $zip $url
    if ($LASTEXITCODE -ne 0) { throw "nginx download failed with exit code $LASTEXITCODE" }
  }
  Write-Host "Extracting $zip"
  & tar.exe -xf $zip -C $Root
  if ($LASTEXITCODE -ne 0) { throw "nginx extraction failed with exit code $LASTEXITCODE" }
}
if (-not (Test-Path $nginxExe)) { throw "nginx.exe not found in $dist" }
# nginx -v writes to stderr; capture it without tripping ErrorActionPreference=Stop.
$nginxVersion = (& cmd /c "`"$nginxExe`" -v 2>&1" | Out-String).Trim()
Write-Host $nginxVersion

# --- test prefix layout ------------------------------------------------------
$confDir = Join-Path $prefix 'conf'
$logsDir = Join-Path $prefix 'logs'
$certsDir = Join-Path $prefix 'certs'
$webDir = Join-Path $prefix 'web'
if (Test-Path $prefix) { Remove-Item -Recurse -Force $prefix }
New-Item -ItemType Directory -Force -Path $confDir, $logsDir, $certsDir, $webDir, (Join-Path $prefix 'temp') | Out-Null

Copy-Item (Join-Path $dist 'conf\mime.types') (Join-Path $confDir 'mime.types')
Copy-Item (Join-Path $repo 'deploy\nginx\security-headers.conf') $confDir
Copy-Item (Join-Path $repo 'deploy\nginx\spa-csp.conf') $confDir

Write-Host 'Generating a self-signed certificate for nginx -t...'
& node (Join-Path $repo 'scripts\pg\make-cert.mjs') $certsDir
if ($LASTEXITCODE -ne 0) { throw "Certificate generation failed with exit code $LASTEXITCODE" }
Copy-Item (Join-Path $certsDir 'server.crt') (Join-Path $certsDir 'logbook.crt') -Force
Copy-Item (Join-Path $certsDir 'server.key') (Join-Path $certsDir 'logbook.key') -Force
Set-Content -Path (Join-Path $webDir 'index.html') -Value '<!doctype html><title>Logbook test</title>' -Encoding ascii

# Rewrite production paths to the local test prefix (forward slashes).
$config = Get-Content (Join-Path $repo 'deploy\nginx\nginx.conf') -Raw
$certsFwd = $certsDir.Replace('\', '/')
$webFwd = $webDir.Replace('\', '/')
$config = $config.Replace('/etc/nginx/certs', $certsFwd)
$config = $config.Replace('/var/www/logbook', $webFwd)
Set-Content -Path (Join-Path $confDir 'nginx.conf') -Value $config -Encoding ascii

Write-Host "Running nginx -t (prefix $prefix)..."
$prefixFwd = $prefix.Replace('\', '/') + '/'
# nginx writes test output to stderr; capture via cmd so ErrorActionPreference=Stop does not abort.
$output = (& cmd /c "`"$nginxExe`" -t -p `"$prefixFwd`" -c conf/nginx.conf 2>&1" | Out-String)
$code = $LASTEXITCODE
$output | Out-Host
if ($code -ne 0) {
  throw "nginx -t failed with exit code $code"
}
Write-Host 'NGINX CONFIG OK'
