param(
  [string]$ChromeExtensionId,
  [string]$EdgeExtensionId,
  [string]$ChromiumExtensionId,
  [string]$BraveExtensionId,
  [string[]]$Browsers,
  [string]$HostName = "dev.bretik.tlshelper"
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$publishRoot = Join-Path $scriptRoot "out"
$manifestPath = Join-Path $publishRoot "$HostName.json"
$projectPath = Join-Path $scriptRoot "BigBrother.NativeHost.csproj"
$exePath = Join-Path $publishRoot "BigBrother.NativeHost.exe"

$browserRegistryRoots = [ordered]@{
  Chrome = @(
    "Software\Google\Chrome\NativeMessagingHosts",
    "Software\WOW6432Node\Google\Chrome\NativeMessagingHosts"
  )
  Edge = @(
    "Software\Microsoft\Edge\NativeMessagingHosts",
    "Software\WOW6432Node\Microsoft\Edge\NativeMessagingHosts"
  )
  Chromium = @(
    "Software\Chromium\NativeMessagingHosts",
    "Software\WOW6432Node\Chromium\NativeMessagingHosts"
  )
  Brave = @(
    "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    "Software\WOW6432Node\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    "Software\BraveSoftware\Brave-Browser-Beta\NativeMessagingHosts",
    "Software\WOW6432Node\BraveSoftware\Brave-Browser-Beta\NativeMessagingHosts",
    "Software\BraveSoftware\Brave-Browser-Nightly\NativeMessagingHosts",
    "Software\WOW6432Node\BraveSoftware\Brave-Browser-Nightly\NativeMessagingHosts"
  )
}

$browserCompatibilityRegistryRoots = [ordered]@{
  Brave = @(
    "Software\Google\Chrome\NativeMessagingHosts",
    "Software\WOW6432Node\Google\Chrome\NativeMessagingHosts",
    "Software\Chromium\NativeMessagingHosts",
    "Software\WOW6432Node\Chromium\NativeMessagingHosts"
  )
}

$extensionIds = [ordered]@{
  Chrome = $ChromeExtensionId
  Edge = $EdgeExtensionId
  Chromium = $ChromiumExtensionId
  Brave = $BraveExtensionId
}

function Normalize-BrowserName {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Browser
  )

  switch -Regex ($Browser.Trim()) {
    '^chrome$' { return 'Chrome' }
    '^edge$' { return 'Edge' }
    '^chromium$' { return 'Chromium' }
    '^brave$' { return 'Brave' }
    default { throw "Unsupported browser '$Browser'. Supported values: Chrome, Edge, Chromium, Brave." }
  }
}

function Get-SelectedBrowsers {
  $selected = @()

  if ($PSBoundParameters.ContainsKey("Browsers")) {
    foreach ($browser in $Browsers) {
      if (-not $browser) {
        continue
      }

      $normalized = Normalize-BrowserName -Browser $browser
      if ($selected -notcontains $normalized) {
        $selected += $normalized
      }
    }

    return $selected
  }

  foreach ($browser in $extensionIds.Keys) {
    if ($extensionIds[$browser]) {
      $selected += $browser
    }
  }

  return $selected
}

function Set-RegistryDefaultValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RegistryPath,
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RegistryPath)
  if (-not $registryKey) {
    throw "Failed to open writable registry key HKCU\$RegistryPath"
  }

  try {
    $registryKey.SetValue("", $Value, [Microsoft.Win32.RegistryValueKind]::String)
    $writtenValue = $registryKey.GetValue("")
    if ($writtenValue -ne $Value) {
      throw "Failed to verify registry value for HKCU\$RegistryPath"
    }
  } finally {
    $registryKey.Dispose()
  }
}

$selectedBrowsers = Get-SelectedBrowsers
if (-not $selectedBrowsers.Count) {
  throw "At least one browser target is required. Pass -Browsers with Chrome, Edge, Chromium, and/or Brave, or provide one of -ChromeExtensionId, -EdgeExtensionId, -ChromiumExtensionId, or -BraveExtensionId."
}

$allowedOrigins = @()
$installedBrowsers = @()
$writtenRegistryKeys = @()

foreach ($browser in $selectedBrowsers) {
  $extensionId = $extensionIds[$browser]
  if (-not $extensionId) {
    throw "$browser was selected, but no extension ID was provided. Pass -${browser}ExtensionId <id>."
  }

  $allowedOrigins += "chrome-extension://$extensionId/"
  $installedBrowsers += $browser
}

$allowedOrigins = @($allowedOrigins | Select-Object -Unique)

dotnet publish $projectPath -c Release -r win-x64 --self-contained false -o $publishRoot | Out-Host

if (-not (Test-Path -LiteralPath $exePath)) {
  throw "Native host executable was not produced at $exePath"
}

$manifest = [ordered]@{
  name = $HostName
  description = "Big Brother Detector native host for bretik.dev"
  path = $exePath
  type = "stdio"
  allowed_origins = $allowedOrigins
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding utf8

foreach ($browser in $installedBrowsers) {
  $registryRoots = @($browserRegistryRoots[$browser])
  if ($browserCompatibilityRegistryRoots.Contains($browser)) {
    $registryRoots += $browserCompatibilityRegistryRoots[$browser]
  }

  foreach ($registryRoot in ($registryRoots | Select-Object -Unique)) {
    $registryNativePath = "$registryRoot\$HostName"
    Set-RegistryDefaultValue -RegistryPath $registryNativePath -Value $manifestPath
    $writtenRegistryKeys += "HKCU\$registryNativePath"
  }
}

Write-Host "Native helper installed."
Write-Host "Host name: $HostName"
Write-Host "Manifest: $manifestPath"
Write-Host "Browsers: $($installedBrowsers -join ', ')"
Write-Host "Registry keys:"
foreach ($registryKey in $writtenRegistryKeys) {
  Write-Host " - $registryKey"
}
Write-Host "Allowed origins:"
foreach ($origin in $allowedOrigins) {
  Write-Host " - $origin"
}
Write-Host "Reload the selected browser extensions after installation."

