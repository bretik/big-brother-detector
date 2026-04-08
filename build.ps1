$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot = Join-Path $root "dist"

if (Test-Path -LiteralPath $distRoot) {
  Remove-Item -LiteralPath $distRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $distRoot | Out-Null

function Copy-ExtensionPackage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $sourceRoot = Join-Path $root $Name
  $targetRoot = Join-Path $distRoot $Name

  New-Item -ItemType Directory -Path $targetRoot | Out-Null
  Copy-Item -Path (Join-Path $sourceRoot "*") -Destination $targetRoot -Recurse -Force

  $sharedRoot = Join-Path $root "common"
  $sharedTarget = Join-Path $targetRoot "common"
  if (Test-Path -LiteralPath $sharedTarget) {
    Remove-Item -LiteralPath $sharedTarget -Recurse -Force
  }
  New-Item -ItemType Directory -Path $sharedTarget | Out-Null
  Copy-Item -Path (Join-Path $sharedRoot "*") -Destination $sharedTarget -Recurse -Force
}

Copy-ExtensionPackage -Name "chrome"
Copy-ExtensionPackage -Name "firefox"

Write-Host "Built extension packages:"
Write-Host " - $distRoot\\chrome"
Write-Host " - $distRoot\\firefox"
