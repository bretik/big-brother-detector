param(
  [string]$OutputRoot,
  [string]$ReleaseLabel
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

$chromeArchivePath = Join-Path $artifactsRoot "big-brother-detector-chromium-$label.zip"
$firefoxZipPath = Join-Path $artifactsRoot "big-brother-detector-firefox-$label.zip"
$firefoxXpiPath = Join-Path $artifactsRoot "big-brother-detector-firefox-$label.xpi"
$checksumsPath = Join-Path $artifactsRoot "SHA256SUMS.txt"

Compress-Archive -Path (Join-Path $distRoot "chrome\*") -DestinationPath $chromeArchivePath -CompressionLevel Optimal
Compress-Archive -Path (Join-Path $distRoot "firefox\*") -DestinationPath $firefoxZipPath -CompressionLevel Optimal
Move-Item -LiteralPath $firefoxZipPath -Destination $firefoxXpiPath

$hashLines = @()
foreach ($filePath in @($chromeArchivePath, $firefoxXpiPath)) {
  $hash = Get-FileHash -LiteralPath $filePath -Algorithm SHA256
  $hashLines += "$($hash.Hash.ToLowerInvariant()) *$([System.IO.Path]::GetFileName($filePath))"
}

Set-Content -LiteralPath $checksumsPath -Value $hashLines

Write-Host "Created release artifacts:"
Write-Host " - $chromeArchivePath"
Write-Host " - $firefoxXpiPath"
Write-Host " - $checksumsPath"
