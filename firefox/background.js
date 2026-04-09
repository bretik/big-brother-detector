"use strict";

const tabStates = new Map();
const pendingVisualFlushes = new Set();
const pendingVisualVersions = new Map();
let activeTabId = null;

function drawIcon(color, intercepted) {
  const sizes = [16, 32];
  const images = {};

  for (const size of sizes) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

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
  const presentation = BigBrotherStatus.getStatusPresentation(state.status);
  const imageData = drawIcon(presentation.color, state.status.kind === "intercepted");

  await Promise.allSettled([
    browser.browserAction.setBadgeText({ tabId, text: presentation.badgeText }),
    browser.browserAction.setBadgeBackgroundColor({ tabId, color: presentation.color }),
    browser.browserAction.setTitle({
      tabId,
      title: `${presentation.headline}: ${state.hostname || state.url || "unknown page"}`,
    }),
    browser.browserAction.setIcon({ tabId, imageData }),
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
  scheduleTabVisualUpdate(tabId);
}

function refreshTabVisualState(tabId) {
  if (tabStates.has(tabId)) {
    scheduleTabVisualUpdate(tabId);
  }
}

async function refreshActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs.length ? tabs[0] : null;
  activeTabId = tab && typeof tab.id === "number" ? tab.id : null;

  if (!tab || typeof tab.id !== "number") {
    return;
  }

  const url = tab.url || "";
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const existingState = tabStates.get(tab.id);
    if (existingState && isFinalVisualState(existingState)) {
      refreshTabVisualState(tab.id);
      return;
    }

    setTabState(tab.id, BigBrotherStatus.createLoadingState(url, "Checking certificate details..."));
    return;
  }

  setTabState(tab.id, BigBrotherStatus.createUnknownState(url, "This tab is not an HTTP(S) page."));
}

async function updateTabState(tabId, url, securityInfo) {
  const existingState = tabStates.get(tabId);

  if (!url.startsWith("https://")) {
    setTabState(tabId, BigBrotherStatus.buildTabState({
      url,
      securityInfo: {
        protocol: "http:",
        certificates: [],
      },
    }));
    return;
  }

  if (!securityInfo) {
    if (existingState && existingState.status && existingState.status.kind !== "loading" && existingState.status.kind !== "unknown" && existingState.url === url) {
      refreshTabVisualState(tabId);
      return;
    }
    setTabState(tabId, BigBrotherStatus.createLoadingState(url, "Checking certificate details..."));
    return;
  }

  setTabState(tabId, BigBrotherStatus.buildTabState({
    url,
    securityInfo,
  }));
}

browser.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.type !== "main_frame" || typeof details.tabId !== "number" || details.tabId < 0) {
      return;
    }

    if (!details.url.startsWith("https://")) {
      await updateTabState(details.tabId, details.url, { protocol: "http:", certificates: [] });
      return;
    }

    let securityInfo = null;
    try {
      const info = await browser.webRequest.getSecurityInfo(details.requestId, {
        certificateChain: true,
        rawDER: true,
      });

      securityInfo = {
        protocol: "https:",
        certificates: Array.isArray(info.certificates) ? info.certificates : [],
      };
    } catch (error) {
      securityInfo = {
        protocol: "https:",
        certificates: [],
      };
    }

    await updateTabState(details.tabId, details.url, securityInfo);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["blocking", "responseHeaders"]
);

browser.tabs.onActivated.addListener(() => {
  refreshActiveTab().catch(() => {});
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab && tab.url) {
    if (tab.url.startsWith("http://") || tab.url.startsWith("https://")) {
      const existingState = tabStates.get(tabId);
      if (!existingState || !existingState.status || existingState.status.kind === "loading" || existingState.status.kind === "unknown") {
        setTabState(tabId, BigBrotherStatus.createLoadingState(tab.url, "Checking certificate details..."));
      }
    } else {
      setTabState(tabId, BigBrotherStatus.createUnknownState(tab.url, "This tab is not an HTTP(S) page."));
    }
    return;
  }

  if (changeInfo.status === "complete") {
    refreshTabVisualState(tabId);
  }
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "GET_CURRENT_STATE") {
    const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : activeTabId;
    return Promise.resolve(
      (typeof tabId === "number" && tabStates.get(tabId)) || {
        hostname: "",
        url: "",
        status: {
          kind: "unknown",
          label: "Unknown",
          reason: "No active tab state is cached yet.",
        },
        securityInfo: null,
        certificateSummary: { count: 0, firstSubject: "", firstIssuer: "" },
      }
    );
  }

  if (message.type === "GET_SETTINGS") {
    return Promise.resolve({
      browserFamily: "firefox",
      setupText: "",
      diagnostics: [
        "Certificate inspection API available: yes"
      ]
    });
  }

  if (message.type === "SAVE_SETTINGS") {
    return Promise.resolve({
      settings: {
        browserFamily: "firefox",
        setupText: "",
        diagnostics: [
          "Certificate inspection API available: yes"
        ]
      },
      state:
        (typeof activeTabId === "number" && tabStates.get(activeTabId)) ||
        BigBrotherStatus.createUnknownState("", "No active tab state is cached yet."),
    });
  }

  return false;
});

refreshActiveTab().catch(() => {});






