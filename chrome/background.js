"use strict";

importScripts("./common/status.js");

const tabStates = new Map();
const pendingVisualFlushes = new Set();
const pendingVisualVersions = new Map();
const pendingRequestVersions = new Map();
const TAB_STATE_PREFIX = "tabState:";

let activeTabId = null;
let flagModeAvailable = false;
let flagModeKnown = false;
let flagModeError = "";
let headerListenerUsesSecurityInfo = false;

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

function isFinalVisualState(state) {
  const kind = state && state.status ? state.status.kind : "unknown";
  return kind === "intercepted" || kind === "not_intercepted" || kind === "insecure";
}

async function persistTabState(tabId, state) {
  const key = tabStateKey(tabId);
  if (isFinalVisualState(state)) {
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

function setFlagModeAvailability(isAvailable, errorMessage) {
  flagModeKnown = true;
  flagModeAvailable = !!isAvailable;
  flagModeError = errorMessage || "";
}

function getFlagModeReason() {
  if (flagModeKnown && flagModeAvailable) {
    return "Chrome flag mode is active. Certificate inspection uses Chrome's TLS metadata for this page.";
  }

  if (!flagModeKnown) {
    return "Checking whether Chrome is exposing TLS metadata for this page.";
  }

  const detail = flagModeError ? ` Chrome reported: ${flagModeError}` : "";
  return "Chrome flag mode requires Chrome to be started with the WebRequestSecurityInfo developer flag enabled." + detail;
}

function buildDiagnostics() {
  const diagnostics = [];
  diagnostics.push(`Chrome flag mode available: ${flagModeAvailable ? "yes" : "no"}`);
  if (!flagModeAvailable && flagModeError) {
    diagnostics.push(`Flag registration error: ${flagModeError}`);
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

function normalizeChromeTabState(state) {
  if (!state) {
    return state;
  }

  if (state.status && state.status.kind === "loading" && flagModeKnown && !flagModeAvailable) {
    return BigBrotherStatus.createUnknownState(state.url || "", getFlagModeReason());
  }

  return state;
}

function getCurrentStateForTab(tabId) {
  if (typeof tabId === "number" && tabStates.has(tabId)) {
    return normalizeChromeTabState(tabStates.get(tabId));
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
    if (flagModeKnown && !flagModeAvailable) {
      return BigBrotherStatus.createUnknownState(url, getFlagModeReason());
    }

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

  const existingState = normalizeChromeTabState(getCurrentStateForTab(tabId));
  return !!(
    existingState &&
    existingState.url === url &&
    existingState.status &&
    existingState.status.kind !== "loading" &&
    existingState.status.kind !== "unknown"
  );
}

async function updateTabStateForUrl(tabId, url, securityInfo) {
  const requestVersion = beginTabRequest(tabId);

  if (!url.startsWith("https://")) {
    setTabState(tabId, createStateForNonHttps(url));
    return;
  }

  if (!securityInfo) {
    if (shouldPreserveExistingHttpsState(tabId, url, securityInfo)) {
      return;
    }

    const nextState = await buildStateFromChromeSecurityInfo(url, null);
    setTabState(tabId, nextState);
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

function registerHeaderListener(useSecurityInfo) {
  unregisterHeaderListener();

  const filter = { urls: ["<all_urls>"], types: ["main_frame"] };
  const extraInfoSpec = ["responseHeaders", "extraHeaders"];

  if (useSecurityInfo) {
    extraInfoSpec.push("securityInfoRawDer");
  }

  chrome.webRequest.onHeadersReceived.addListener(handleHeadersReceived, filter, extraInfoSpec);
  headerListenerUsesSecurityInfo = useSecurityInfo;
}

function registerPreferredHeaderListener() {
  try {
    registerHeaderListener(true);
    flagModeAvailable = false;
    flagModeKnown = false;
    flagModeError = "";
  } catch (error) {
    setFlagModeAvailability(false, error && error.message ? error.message : "securityInfo registration failed.");
    registerHeaderListener(false);
  }
}

async function handleHeadersReceived(details) {
  if (details.type !== "main_frame" || typeof details.tabId !== "number" || details.tabId < 0) {
    return;
  }

  if (details.url && details.url.startsWith("https://")) {
    if (details.securityInfo) {
      setFlagModeAvailability(true, "");
    } else {
      setFlagModeAvailability(false, "Chrome did not expose TLS certificate metadata for this request.");
      if (headerListenerUsesSecurityInfo) {
        registerHeaderListener(false);
      }
    }
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

function buildSettingsPayload() {
  return {
    browserFamily: "chrome",
    setupText: "Start Chrome or another Chromium browser with --enable-features=WebRequestSecurityInfo. Example: chrome.exe --enable-features=WebRequestSecurityInfo",
    diagnostics: buildDiagnostics(),
  };
}

async function saveMode() {
  await refreshActiveTab();
  return {
    settings: buildSettingsPayload(),
    state: getCurrentStateForTab(activeTabId),
  };
}

function prewarmNavigation(tabId, url, shouldTrackActiveTab = false) {
  if (typeof tabId !== "number" || tabId < 0 || !url) {
    return;
  }

  if (shouldTrackActiveTab) {
    activeTabId = tabId;
  }

  updateTabStateForUrl(tabId, url, null).catch(() => {});
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) {
    return;
  }

  prewarmNavigation(details.tabId, details.url, details.tabId === activeTabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) {
    return;
  }

  prewarmNavigation(details.tabId, details.url, details.tabId === activeTabId);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  prewarmNavigation(details.tabId, details.url, false);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab || typeof tab.id !== "number") {
    return;
  }

  const url = tab.pendingUrl || tab.url || "";
  prewarmNavigation(tab.id, url, false);
});

chrome.tabs.onActivated.addListener(() => {
  refreshActiveTab().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab && tab.url) {
    updateTabStateForUrl(tabId, tab.url, null).catch(() => {});
    return;
  }

  if (changeInfo.status === "complete") {
    const state = tabStates.get(tabId);
    if (state && state.status && state.status.kind === "loading") {
      const url = state.url || (tab && tab.url) || "";
      const reason = flagModeKnown && !flagModeAvailable
        ? getFlagModeReason()
        : "Certificate details were not captured for this navigation. Reload the page to inspect this connection.";
      setTabState(tabId, BigBrotherStatus.createUnknownState(url, reason));
      return;
    }

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
    sendResponse(buildSettingsPayload());
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    saveMode()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  return false;
});

async function bootstrap() {
  await restorePersistedTabStates();
  await refreshActiveTab();
}

registerPreferredHeaderListener();

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch(() => {});
});

bootstrap().catch(() => {});





