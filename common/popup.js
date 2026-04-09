"use strict";

function sendMessage(message) {
  if (typeof browser !== "undefined" && browser.runtime && browser.runtime.sendMessage) {
    return browser.runtime.sendMessage(message);
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    return chrome.runtime.sendMessage(message);
  }

  return Promise.reject(new Error("This browser did not expose a runtime messaging API."));
}

async function getCurrentState() {
  try {
    return await sendMessage({ type: "GET_CURRENT_STATE" });
  } catch (error) {
    return {
      status: {
        kind: "unknown",
        label: "Unknown",
        reason: error && error.message ? error.message : "Failed to load extension state.",
      },
    };
  }
}

async function getSettings() {
  try {
    return await sendMessage({ type: "GET_SETTINGS" });
  } catch (error) {
    return {
      setupText: error && error.message ? error.message : "Settings are not available.",
      diagnostics: ["Diagnostics are not available."],
    };
  }
}

function getPrimaryCertificateSummary(state) {
  return state && state.certificateSummary ? state.certificateSummary : { count: 0, firstSubject: "", firstIssuer: "", rawDERPresent: false, firstKeys: [] };
}

function isChromeFlagUnavailable(settings) {
  if (!settings || settings.browserFamily !== "chrome" || !Array.isArray(settings.diagnostics)) {
    return false;
  }

  return settings.diagnostics.some((entry) => entry === "Chrome flag mode available: no");
}

function getDisplayState(state, settings) {
  if (!isChromeFlagUnavailable(settings)) {
    return state;
  }

  if (state && state.status && state.status.kind !== "loading") {
    return state;
  }

  return {
    ...state,
    status: {
      kind: "unknown",
      label: "Not available",
      reason: "Certificate inspection is not available because Chrome was not started with --enable-features=WebRequestSecurityInfo.",
    },
  };
}

function renderDetails(state, settings) {
  const details = document.getElementById("details");
  const summary = getPrimaryCertificateSummary(state);
  const debug = state && state.debug ? state.debug : { firstCertKeys: [], firstCertType: "none" };

  details.textContent = "";

  if (isChromeFlagUnavailable(settings)) {
    details.textContent = "Certificate hints are not available until Chrome is started with --enable-features=WebRequestSecurityInfo.";
    return;
  }

  if (!summary.count) {
    details.textContent = state && state.status && state.status.kind === "loading" ? "Checking certificate details..." : "No certificate details available.";
    return;
  }

  const subject = summary.firstSubject || "Unknown subject";
  const issuer = summary.firstIssuer || "Unknown issuer";
  const firstKeys = Array.isArray(debug.firstCertKeys) && debug.firstCertKeys.length ? debug.firstCertKeys.join(", ") : "<none>";
  const rows = [
    ["Count", String(summary.count)],
    ["Issued to", subject],
    ["Issued by", issuer],
    ["rawDER", summary.rawDERPresent ? "present" : "missing"],
    ["Cert keys", firstKeys],
  ];

  const wrapper = document.createElement("div");
  wrapper.className = "certificate-summary";

  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "certificate-row";

    const key = document.createElement("div");
    key.className = "certificate-key";
    key.textContent = label;

    const cell = document.createElement("div");
    cell.className = "certificate-value";
    cell.textContent = value;

    row.appendChild(key);
    row.appendChild(cell);
    wrapper.appendChild(row);
  }

  details.appendChild(wrapper);
}

function renderDiagnostics(settings, state) {
  const diagnosticsText = document.getElementById("diagnostics-text");
  const diagnostics = settings && Array.isArray(settings.diagnostics) ? settings.diagnostics.slice() : [];
  const summary = getPrimaryCertificateSummary(state);
  const debug = state && state.debug ? state.debug : { securityInfoKeys: [], firstCertKeys: [], firstCertType: "none" };
  const securityDump = debug && debug.securityInfoSnapshot ? JSON.stringify(debug.securityInfoSnapshot, null, 2) : "<none>";

  diagnostics.unshift(`Certificate count: ${summary.count}`);
  diagnostics.unshift(`Issued to: ${summary.firstSubject || "<none>"}`);
  diagnostics.unshift(`Issued by: ${summary.firstIssuer || "<none>"}`);
  diagnostics.unshift(`rawDER present: ${summary.rawDERPresent ? "yes" : "no"}`);
  diagnostics.unshift(`First cert keys: ${Array.isArray(debug.firstCertKeys) ? debug.firstCertKeys.join(", ") || "<none>" : "<invalid>"}`);
  diagnostics.unshift(`SecurityInfo keys: ${Array.isArray(debug.securityInfoKeys) ? debug.securityInfoKeys.join(", ") || "<none>" : "<invalid>"}`);
  diagnostics.push("");
  diagnostics.push("SecurityInfo dump:");
  diagnostics.push(securityDump);
  diagnosticsText.textContent = diagnostics.length ? diagnostics.join("\n") : "No diagnostics available.";
}

function renderState(state, settings) {
  const fallbackStatus = {
    kind: "unknown",
    label: "Unknown",
    reason: "No status found.",
  };
  const displayState = getDisplayState(state, settings) || {};
  const status = displayState && displayState.status ? displayState.status : fallbackStatus;
  const presentation = BigBrotherStatus.getStatusPresentation(status);

  document.getElementById("headline").textContent = presentation.headline;
  document.getElementById("hostname").textContent = displayState.hostname || displayState.url || "No active page";
  document.getElementById("status-label").textContent = status.label;
  document.getElementById("status-dot").style.background = presentation.color;
  renderDetails(displayState, settings);
}

function renderSettings(settings, state) {
  const setupCard = document.getElementById("setup-card");
  const setupText = document.getElementById("setup-text");
  const text = settings && typeof settings.setupText === "string" ? settings.setupText.trim() : "";

  setupCard.classList.toggle("hidden", !text);
  setupText.textContent = text;
  renderDiagnostics(settings, state);
}

async function init() {
  const [state, settings] = await Promise.all([getCurrentState(), getSettings()]);
  const currentState = state || { status: { kind: "unknown", label: "Unknown", reason: "No state." } };
  const currentSettings = settings || {};
  renderState(currentState, currentSettings);
  renderSettings(currentSettings, currentState);
}

init();
