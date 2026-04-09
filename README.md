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

2. `Chrome flag`
   Chromium-based browsers read the browser's own TLS metadata when started
   with the `WebRequestSecurityInfo` feature flag.

## Build the project

Run this from the project root:

```powershell
.\build.ps1
```

This creates:

- `dist\chrome`
- `dist\firefox`

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

## Use `Chrome flag` mode

Chromium-based browsers now support only `Chrome flag` mode.

Start the browser with this flag:

```powershell
--enable-features=WebRequestSecurityInfo
```

Then:

1. reload the extension
2. open the popup
3. confirm the diagnostics say `Chrome flag mode available: yes`

If the diagnostics say `Chrome flag mode available: no`, the browser is not
exposing certificate details to the extension.

## What is detected

The extension checks the top-level page certificate and matches issuer and
subject values associated with Zscaler, such as:

- `Issued to: example.com / Zscaler Inc.`
- `Issued by: Zscaler Intermediate Root CA (...)`

## Troubleshooting

### `Chrome flag mode available: no`

The browser was not started with:

```powershell
--enable-features=WebRequestSecurityInfo
```

Restart the browser with the flag and reload the extension.

### Firefox shows no certificate details

Reload the temporary add-on from `dist\firefox` so the latest background page
and manifest are loaded.

### The icon or popup looks inconsistent

Reload the unpacked extension from the latest `dist` folder so the popup,
background script, and shared files all come from the same build.

