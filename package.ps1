param(
  [string]$OutputRoot,
  [string]$ReleaseLabel,
  [string]$AmoJwtIssuer,
  [string]$AmoJwtSecret,
  [switch]$SkipAmoConnectivityCheck
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactsRoot = if ($OutputRoot) { $OutputRoot } else { Join-Path $root "artifacts" }
$distRoot = Join-Path $root "dist"

& (Join-Path $root "build.ps1")

if (Test-Path -LiteralPath $artifactsRoot) {
  Remove-Item -LiteralPath $artifactsRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $artifactsRoot | Out-Null

$chromeManifestPath = Join-Path $distRoot "chrome\manifest.json"
$chromeManifest = Get-Content -LiteralPath $chromeManifestPath -Raw | ConvertFrom-Json
$version = if ($chromeManifest.version) { $chromeManifest.version } else { "0.0.0" }
$label = if ($ReleaseLabel) { $ReleaseLabel } else { "v$version" }
$resolvedAmoJwtIssuer = if ($AmoJwtIssuer) { $AmoJwtIssuer } else { $env:AMO_JWT_ISSUER }
$resolvedAmoJwtSecret = if ($AmoJwtSecret) { $AmoJwtSecret } else { $env:AMO_JWT_SECRET }

$chromeArchivePath = Join-Path $artifactsRoot "big-brother-detector-chromium-$label.zip"
$signedFirefoxArtifactsRoot = Join-Path $artifactsRoot "firefox-signed"
$signedFirefoxXpiPath = Join-Path $artifactsRoot "big-brother-detector-firefox-$label.xpi"
$checksumsPath = Join-Path $artifactsRoot "SHA256SUMS.txt"

Compress-Archive -Path (Join-Path $distRoot "chrome\*") -DestinationPath $chromeArchivePath -CompressionLevel Optimal

if ([string]::IsNullOrWhiteSpace($resolvedAmoJwtIssuer) -or [string]::IsNullOrWhiteSpace($resolvedAmoJwtSecret)) {
  throw "AMO_JWT_ISSUER and AMO_JWT_SECRET are required to build the signed Firefox package."
}

$webExt = Get-Command web-ext -ErrorAction SilentlyContinue
if (-not $webExt) {
  throw "web-ext was not found on PATH. Install it with 'npm install --global web-ext' before building signed release artifacts."
}

if (-not $SkipAmoConnectivityCheck) {
  try {
    Invoke-WebRequest -Uri "https://addons.mozilla.org/" -Method Get -UseBasicParsing -TimeoutSec 20 | Out-Null
  } catch {
    Write-Warning "PowerShell could not reach addons.mozilla.org before signing. web-ext sign will still be attempted so you can see the real AMO/network/authentication error."
    Write-Warning $_.Exception.Message
  }
}

New-Item -ItemType Directory -Path $signedFirefoxArtifactsRoot | Out-Null

$previousWebExtApiKey = $env:WEB_EXT_API_KEY
$previousWebExtApiSecret = $env:WEB_EXT_API_SECRET
$env:WEB_EXT_API_KEY = $resolvedAmoJwtIssuer
$env:WEB_EXT_API_SECRET = $resolvedAmoJwtSecret

try {
  & $webExt.Source sign `
    --source-dir (Join-Path $distRoot "firefox") `
    --artifacts-dir $signedFirefoxArtifactsRoot `
    --channel unlisted
} finally {
  $env:WEB_EXT_API_KEY = $previousWebExtApiKey
  $env:WEB_EXT_API_SECRET = $previousWebExtApiSecret
}

if ($LASTEXITCODE -ne 0) {
  throw "web-ext sign failed. See the error above for the AMO, proxy, TLS trust, or authentication details."
}

$signedXpi = Get-ChildItem -LiteralPath $signedFirefoxArtifactsRoot -Filter *.xpi | Select-Object -First 1
if (-not $signedXpi) {
  throw "Signed Firefox XPI was not produced."
}

Move-Item -LiteralPath $signedXpi.FullName -Destination $signedFirefoxXpiPath
Remove-Item -LiteralPath $signedFirefoxArtifactsRoot -Recurse -Force
$firefoxPackagePath = $signedFirefoxXpiPath

$hashLines = @()
foreach ($filePath in @($chromeArchivePath, $firefoxPackagePath)) {
  $hash = Get-FileHash -LiteralPath $filePath -Algorithm SHA256
  $hashLines += "$($hash.Hash.ToLowerInvariant()) *$([System.IO.Path]::GetFileName($filePath))"
}

Set-Content -LiteralPath $checksumsPath -Value $hashLines

Write-Host "Created release artifacts:"
Write-Host " - $chromeArchivePath"
Write-Host " - $firefoxPackagePath"
Write-Host " - $checksumsPath"
