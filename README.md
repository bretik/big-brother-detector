# Big Brother Detector

Author: Lubos Bretschneider  
Website: bretik.dev

Big Brother Detector detects whether HTTPS traffic is being intercepted by
Zscaler Internet Security.

## Supported browsers

- Firefox
- Google Chrome
- Microsoft Edge
- Chromium
- Brave

The Chromium-based browsers all use the same extension package in `dist\chrome`.
Firefox uses `dist\firefox`.

## Detection modes

The extension supports these modes:

1. `Firefox built-in`
   Firefox reads certificate details through its own extension API.

2. `Native helper`
   Chromium-based browsers use a local native helper and do not require a
   browser startup flag.

3. `Chrome flag`
   Chromium-based browsers read the browser's own TLS metadata when started
   with the `WebRequestSecurityInfo` feature flag.

## Build the project

Run this from the project root:

```powershell
.\build.ps1
```

To build release artifacts:

```powershell
.\package.ps1
```

This creates:

- `dist\chrome`
- `dist\firefox`
- `artifacts\big-brother-detector-chromium-<tag>.zip`
- `artifacts\big-brother-detector-firefox-<tag>.xpi`
- `artifacts\SHA256SUMS.txt`

## GitHub releases

The repository includes a GitHub Actions workflow at
`.github\workflows\release.yml`.

- pushing a tag like `v0.0.1` builds the extension packages and creates a
  GitHub release
- manual runs through `workflow_dispatch` can create a release for a supplied
  tag
- each release uploads:
  - a Chromium package zip
  - a Firefox package xpi
  - a SHA-256 checksum file

### Browser installation note

Firefox can install an `.xpi` package directly when it is signed for normal
distribution. Chromium-based browsers generally do **not** allow direct
installation from a GitHub release asset without store or policy-based
distribution, so the release zip is best suited for browser store submission or
developer loading.

## Install in Firefox

1. Open Firefox.
2. Go to `about:debugging`.
3. Open `This Firefox`.
4. Click `Load Temporary Add-on`.
5. Select `C:\Dev\playgroung\big-brother\dist\firefox\manifest.json`.

Firefox will use the built-in detection mode automatically.

## Install in Chrome, Edge, Chromium, or Brave

1. Open the browser extensions page.
   Chrome: `chrome://extensions`
   Edge: `edge://extensions`
   Brave: `brave://extensions`
2. Turn on developer mode.
3. Click `Load unpacked`.
4. Select `C:\Dev\playgroung\big-brother\dist\chrome`.

After loading, copy the extension ID from the browser's extension details page.
You will need it for `Native helper` mode.

## Use `Chrome flag` mode

Start the browser with this flag:

```powershell
--enable-features=WebRequestSecurityInfo
```

Then:

1. reload the extension
2. open the popup
3. select `Chrome flag`

If the diagnostics show `Chrome flag mode available: yes`, the browser accepted
certificate inspection through the webRequest API.

## Use `Native helper` mode

This mode is recommended for Chromium-based browsers when the startup flag is
not available.

### Step 1: collect extension IDs

Load the extension in each browser you want to support and copy the extension
ID from that browser's extensions page.

### Step 2: install the native helper

From the project root, run one of these commands.

Only Brave:

```powershell
.\native-helper\install-helper.ps1 -BraveExtensionId <brave-id>
```

Only Chrome:

```powershell
.\native-helper\install-helper.ps1 -ChromeExtensionId <chrome-id>
```

Chrome, Edge, and Brave:

```powershell
.\native-helper\install-helper.ps1 -ChromeExtensionId <chrome-id> -EdgeExtensionId <edge-id> -BraveExtensionId <brave-id>
```

Only Edge and Brave:

```powershell
.\native-helper\install-helper.ps1 -Browsers Edge,Brave -EdgeExtensionId <edge-id> -BraveExtensionId <brave-id>
```

Supported browser values are:

- `Chrome`
- `Edge`
- `Chromium`
- `Brave`

The installer publishes the native host, writes its manifest, registers it for
all selected browsers, and allows the selected extension IDs to connect.
If you omit `-Browsers`, the installer uses whichever `-<Browser>ExtensionId`
parameters you supplied.

Native host name:

```text
dev.bretik.tlshelper
```

### Step 3: reload the extension

After the installer finishes:

1. reload the extension in the selected browser
2. open the popup
3. choose `Native helper`

If it is working, diagnostics should show:

- `Native helper reachable: yes`

## What is detected

The extension checks the top-level page certificate and matches issuer and
subject values associated with Zscaler, such as:

- `Issued to: example.com / Zscaler Inc.`
- `Issued by: Zscaler Intermediate Root CA (...)`

## Troubleshooting

### `Specified native messaging host not found`

Run the native helper installer again with the current extension ID for that
browser, then reload the extension. For Brave, use:

```powershell
.\native-helper\install-helper.ps1 -BraveExtensionId <brave-id>
```

The installer now registers the host under Brave's Windows native messaging
registry keys, including Brave Beta and Nightly locations.

### `Chrome flag mode available: no`

The browser was not started with:

```powershell
--enable-features=WebRequestSecurityInfo
```

Use `Native helper` mode instead, or restart the browser with the flag.

### Firefox shows no certificate details

Reload the temporary add-on from `dist\firefox` so the latest background page
and manifest are loaded.

### The icon or popup looks inconsistent

Reload the unpacked extension from the latest `dist` folder so the popup,
background script, and shared files all come from the same build.

## License

MIT. See `LICENSE`.
