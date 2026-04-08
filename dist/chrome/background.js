"use strict";

importScripts("./common/status.js");

const tabStates = new Map();
const pendingVisualFlushes = new Set();
const pendingVisualVersions = new Map();
const pendingRequestVersions = new Map();
const TAB_STATE_PREFIX = "tabState:";
const DEFAULT_SETTINGS = {
  mode: "native_helper",
};
const HOST_NAME = "dev.bretik.tlshelper";
const MODE_OPTIONS = ["native_helper", "chrome_flag"];

let activeTabId = null;
let currentMode = DEFAULT_SETTINGS.mode;
let flagModeAvailable = false;
let flagModeError = "";
let nativeHelperAvailable = null;
let nativeHelperError = "";

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs);
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function tabStateKey(tabId) {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

function cloneCertificateSummary(summary) {
  if (!summary) {
    return { count: 0, firstSubject: "", firstIssuer: "", rawDERPresent: false, firstKeys: [] };
  }

  return {
    count: typeof summary.count === "number" ? summary.count : 0,
    firstSubject: summary.firstSubject || "",
    firstIssuer: summary.firstIssuer || "",
    rawDERPresent: !!summary.rawDERPresent,
    firstKeys: Array.isArray(summary.firstKeys) ? summary.firstKeys.slice() : [],
  };
}

function clonePersistedState(state) {
  if (!state) {
    return null;
  }

  return {
    url: state.url || "",
    hostname: state.hostname || "",
    status: state.status ? { ...state.status } : { kind: "unknown", label: "Unknown", reason: "" },
    certificateSummary: cloneCertificateSummary(state.certificateSummary),
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
}

function isPersistableFinalState(state) {
  return isFinalVisualState(state);
}

async function persistTabState(tabId, state) {
  const key = tabStateKey(tabId);
  if (isPersistableFinalState(state)) {
    await storageSet({ [key]: clonePersistedState(state) });
    return;
  }

  await storageRemove([key]);
}

async function restorePersistedTabStates() {
  const stored = await storageGet(null);
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(TAB_STATE_PREFIX) || !value || typeof value !== "object") {
      continue;
    }

    const tabId = Number(key.slice(TAB_STATE_PREFIX.length));
    if (!Number.isInteger(tabId)) {
      continue;
    }

    tabStates.set(tabId, value);
    pendingVisualVersions.set(tabId, (pendingVisualVersions.get(tabId) || 0) + 1);
    scheduleTabVisualUpdate(tabId);
  }
}

function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function probeNativeHelper() {
  try {
    const response = await sendNativeMessage({ type: "ping" });
    nativeHelperAvailable = !!(response && response.ok === true);
    nativeHelperError = nativeHelperAvailable ? "" : "Native helper responded unexpectedly.";
  } catch (error) {
    nativeHelperAvailable = false;
    nativeHelperError = error && error.message ? error.message : "Native helper ping failed.";
  }
}

function getFlagModeReason() {
  if (flagModeAvailable) {
    return "Chrome flag mode is active. If this browser was started with WebRequestSecurityInfo enabled, certificate inspection will use Chrome's own TLS metadata.";
  }

  const detail = flagModeError
    ? ` Chrome reported: ${flagModeError}`
    : "";
  return "Chrome flag mode is selected, but this Chrome build is not exposing TLS certificate details to the extension. Start Chrome with the WebRequestSecurityInfo developer flag enabled, or switch to Native helper mode." + detail;
}

function getSetupText(mode) {
  if (mode === "chrome_flag") {
    return "Chrome flag mode needs Chrome to be started with the WebRequestSecurityInfo developer flag enabled. If your company Chrome build does not allow that, switch to Native helper mode instead.";
  }

  return "Native helper mode needs the local helper to be installed once. In PowerShell, run .\\native-helper\\install-helper.ps1 with the matching extension ID switch for this browser, such as -BraveExtensionId <id>, -ChromeExtensionId <id>, -EdgeExtensionId <id>, or -ChromiumExtensionId <id>. After installation, reload the extension and keep this mode selected.";
}

function buildDiagnostics() {
  const diagnostics = [];
  diagnostics.push(`Selected mode: ${currentMode === "chrome_flag" ? "Chrome flag" : "Native helper"}`);
  diagnostics.push(`Chrome flag mode available: ${flagModeAvailable ? "yes" : "no"}`);
  if (!flagModeAvailable && flagModeError) {
    diagnostics.push(`Flag registration error: ${flagModeError}`);
  }
  if (nativeHelperAvailable === null) {
    diagnostics.push("Native helper reachable: not checked yet");
  } else {
    diagnostics.push(`Native helper reachable: ${nativeHelperAvailable ? "yes" : "no"}`);
  }
  if (nativeHelperAvailable === false && nativeHelperError) {
    diagnostics.push(`Native helper error: ${nativeHelperError}`);
  }
  diagnostics.push("For startup flag verification, chrome://version should include --enable-features=WebRequestSecurityInfo in the Command Line field.");
  return diagnostics;
}

function drawIcon(color, intercepted) {
  const sizes = [16, 32];
  const images = {};

  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d");
    const center = size / 2;

    context.clearRect(0, 0, size, size);
    context.fillStyle = color;
    context.beginPath();
    context.arc(center, center, size * 0.42, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(center, center, size * 0.22, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = intercepted ? "#111111" : "#ffffff";
    context.lineWidth = Math.max(2, size * 0.08);
    context.beginPath();
    context.arc(center, center, size * 0.34, Math.PI * 0.15, Math.PI * 0.85);
    context.stroke();

    images[size] = context.getImageData(0, 0, size, size);
  }

  return images;
}

async function setActionVisuals(tabId, state) {
  if (!chrome.action || typeof tabId !== "number") {
    return;
  }

  const presentation = BigBrotherStatus.getStatusPresentation(state.status);
  const imageData = drawIcon(presentation.color, state.status.kind === "intercepted");

  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: presentation.badgeText }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: presentation.color }),
    chrome.action.setTitle({
      tabId,
      title: `${presentation.headline}: ${state.hostname || state.url || "unknown page"}`,
    }),
    chrome.action.setIcon({ tabId, imageData }),
  ]);
}

function scheduleTabVisualUpdate(tabId) {
  const version = pendingVisualVersions.get(tabId) || 0;
  if (pendingVisualFlushes.has(tabId)) {
    return;
  }

  pendingVisualFlushes.add(tabId);
  Promise.resolve()
    .then(async () => {
      pendingVisualFlushes.delete(tabId);
      const state = tabStates.get(tabId);
      if (!state) {
        return;
      }

      if ((pendingVisualVersions.get(tabId) || 0) !== version) {
        return;
      }

      await setActionVisuals(tabId, state);
      if (tabStates.get(tabId) !== state || (pendingVisualVersions.get(tabId) || 0) !== version) {
        scheduleTabVisualUpdate(tabId);
      }
    })
    .catch(() => {});
}

function isFinalVisualState(state) {
  const kind = state && state.status ? state.status.kind : "unknown";
  return kind === "intercepted" || kind === "not_intercepted" || kind === "insecure";
}

function setTabState(tabId, state) {
  tabStates.set(tabId, state);
  pendingVisualVersions.set(tabId, (pendingVisualVersions.get(tabId) || 0) + 1);
  persistTabState(tabId, state).catch(() => {});
  scheduleTabVisualUpdate(tabId);
}

function beginTabRequest(tabId) {
  const version = (pendingRequestVersions.get(tabId) || 0) + 1;
  pendingRequestVersions.set(tabId, version);
  return version;
}

function canApplyTabRequestResult(tabId, requestVersion, url) {
  if ((pendingRequestVersions.get(tabId) || 0) !== requestVersion) {
    return false;
  }

  const currentState = tabStates.get(tabId);
  return !!(currentState && currentState.url === url);
}

function refreshTabVisualState(tabId) {
  if (tabStates.has(tabId)) {
    scheduleTabVisualUpdate(tabId);
  }
}

function createHttpsUnknownState(url, reason) {
  return BigBrotherStatus.createUnknownState(url, reason);
}

function createStateForNonHttps(url) {
  if (url.startsWith("http://")) {
    return BigBrotherStatus.buildTabState({
      url,
      securityInfo: {
        protocol: "http:",
        certificates: [],
      },
    });
  }

  return BigBrotherStatus.createUnknownState(url, "This tab is not an HTTP(S) page.");
}

function getCurrentStateForTab(tabId) {
  if (typeof tabId === "number" && tabStates.has(tabId)) {
    return tabStates.get(tabId);
  }

  return {
    hostname: "",
    url: "",
    status: {
      kind: "unknown",
      label: "Unknown",
      reason: "No active tab state is cached yet.",
    },
    securityInfo: null,
    certificateSummary: { count: 0, firstSubject: "", firstIssuer: "" },
  };
}

async function buildStateFromChromeSecurityInfo(url, securityInfo) {
  if (!securityInfo) {
    return BigBrotherStatus.createLoadingState(url, getFlagModeReason());
  }

  return BigBrotherStatus.buildTabState({
    url,
    securityInfo: {
      protocol: "https:",
      certificates: Array.isArray(securityInfo.certificates) ? securityInfo.certificates : [],
    },
  });
}

function shouldPreserveExistingHttpsState(tabId, url, securityInfo) {
  if (securityInfo) {
    return false;
  }

  const existingState = getCurrentStateForTab(tabId);
  return !!(
    existingState &&
    existingState.url === url &&
    existingState.status &&
    existingState.status.kind !== "loading" &&
    existingState.status.kind !== "unknown"
  );
}

async function buildStateFromNativeHelper(url) {
  try {
    const hostname = BigBrotherStatus.safeHostname(url);
    const response = await sendNativeMessage({ type: "inspect_tls", hostname, url });
    nativeHelperAvailable = true;
    nativeHelperError = "";

    if (!response || response.ok !== true) {
      return createHttpsUnknownState(
        url,
        response && response.error
          ? `Native helper could not inspect this host: ${response.error}`
          : "Native helper did not return certificate data."
      );
    }

    return BigBrotherStatus.buildTabState({
      url,
      securityInfo: {
        protocol: "https:",
        certificates: Array.isArray(response.certificates) ? response.certificates : [],
      },
    });
  } catch (error) {
    nativeHelperAvailable = false;
    nativeHelperError = error && error.message ? error.message : "Native helper failed.";
    return createHttpsUnknownState(
      url,
      `Native helper is not available. Install it with native-helper\\install-helper.ps1 and register it for this extension ID. ${nativeHelperError}`
    );
  }
}

async function updateTabStateForUrl(tabId, url, securityInfo) {
  const requestVersion = beginTabRequest(tabId);

  if (!url.startsWith("https://")) {
    setTabState(tabId, createStateForNonHttps(url));
    return;
  }

  if (currentMode === "native_helper") {
    setTabState(tabId, BigBrotherStatus.createLoadingState(url, "Checking certificate details with the native helper..."));
    const nextState = await buildStateFromNativeHelper(url);
    if (canApplyTabRequestResult(tabId, requestVersion, url)) {
      setTabState(tabId, nextState);
    }
    return;
  }

  if (!securityInfo) {
    if (shouldPreserveExistingHttpsState(tabId, url, securityInfo)) {
      return;
    }
    setTabState(tabId, BigBrotherStatus.createLoadingState(url, getFlagModeReason()));
    return;
  }

  const nextState = await buildStateFromChromeSecurityInfo(url, securityInfo);
  if (canApplyTabRequestResult(tabId, requestVersion, url)) {
    setTabState(tabId, nextState);
  }
}

function unregisterHeaderListener() {
  if (chrome.webRequest.onHeadersReceived.hasListener(handleHeadersReceived)) {
    chrome.webRequest.onHeadersReceived.removeListener(handleHeadersReceived);
  }
}

function registerHeaderListener() {
  unregisterHeaderListener();

  const filter = { urls: ["<all_urls>"], types: ["main_frame"] };
  const baseOptions = ["responseHeaders", "extraHeaders"];

  if (currentMode === "chrome_flag") {
    try {
      chrome.webRequest.onHeadersReceived.addListener(handleHeadersReceived, filter, [
        "responseHeaders",
        "extraHeaders",
        "securityInfoRawDer",
      ]);
      flagModeAvailable = true;
      flagModeError = "";
      return;
    } catch (error) {
      flagModeAvailable = false;
      flagModeError = error && error.message ? error.message : "securityInfo registration failed.";
    }
  } else {
    flagModeAvailable = false;
    flagModeError = "";
  }

  chrome.webRequest.onHeadersReceived.addListener(handleHeadersReceived, filter, baseOptions);
}

async function handleHeadersReceived(details) {
  if (details.type !== "main_frame" || typeof details.tabId !== "number" || details.tabId < 0) {
    return;
  }

  await updateTabStateForUrl(details.tabId, details.url, details.securityInfo || null);
}

async function refreshActiveTab() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  const tab = tabs && tabs.length ? tabs[0] : null;
  activeTabId = tab && typeof tab.id === "number" ? tab.id : null;

  if (!tab || typeof tab.id !== "number") {
    return;
  }

  await updateTabStateForUrl(tab.id, tab.url || "", null);
}

async function loadSettings() {
  const stored = await storageGet(["mode"]);
  const mode = MODE_OPTIONS.includes(stored.mode) ? stored.mode : DEFAULT_SETTINGS.mode;
  currentMode = mode;
  return { mode };
}

function buildSettingsPayload() {
  return {
    browserFamily: "chrome",
    mode: currentMode,
    modeOptions: MODE_OPTIONS,
    setupText: getSetupText(currentMode),
    diagnostics: buildDiagnostics(),
  };
}

async function saveMode(mode) {
  currentMode = MODE_OPTIONS.includes(mode) ? mode : DEFAULT_SETTINGS.mode;
  await storageSet({ mode: currentMode });
  registerHeaderListener();
  await probeNativeHelper();
  await refreshActiveTab();
  return {
    settings: buildSettingsPayload(),
    state: getCurrentStateForTab(activeTabId),
  };
}

chrome.tabs.onActivated.addListener(() => {
  refreshActiveTab().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab && tab.url) {
    updateTabStateForUrl(tabId, tab.url, null).catch(() => {});
    return;
  }

  if (changeInfo.status === "complete") {
    refreshTabVisualState(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  pendingVisualVersions.delete(tabId);
  pendingRequestVersions.delete(tabId);
  storageRemove([tabStateKey(tabId)]).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "GET_CURRENT_STATE") {
    const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : activeTabId;
    sendResponse(getCurrentStateForTab(tabId));
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    probeNativeHelper()
      .then(() => sendResponse(buildSettingsPayload()))
      .catch(() => sendResponse(buildSettingsPayload()));
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    saveMode(message.mode)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  return false;
});

async function bootstrap() {
  await loadSettings();
  await restorePersistedTabStates();
  registerHeaderListener();
  await probeNativeHelper();
  await refreshActiveTab();
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch(() => {});
});

bootstrap().catch(() => {
  registerHeaderListener();
});








