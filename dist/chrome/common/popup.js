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
      mode: "firefox_builtin",
      modeOptions: [],
      browserFamily: "unknown",
      setupText: error && error.message ? error.message : "Settings are not available.",
      diagnostics: ["Diagnostics are not available."],
    };
  }
}

async function saveSettings(mode) {
  return sendMessage({ type: "SAVE_SETTINGS", mode });
}

function getPrimaryCertificateSummary(state) {
  return state && state.certificateSummary ? state.certificateSummary : { count: 0, firstSubject: "", firstIssuer: "", rawDERPresent: false, firstKeys: [] };
}

function renderDetails(state) {
  const details = document.getElementById("details");
  const summary = getPrimaryCertificateSummary(state);
  const debug = state && state.debug ? state.debug : { firstCertKeys: [], firstCertType: "none" };

  details.textContent = "";

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

function renderState(state) {
  const fallbackStatus = {
    kind: "unknown",
    label: "Unknown",
    reason: "No status found.",
  };
  const status = state && state.status ? state.status : fallbackStatus;
  const presentation = BigBrotherStatus.getStatusPresentation(status);

  document.getElementById("headline").textContent = presentation.headline;
  document.getElementById("hostname").textContent = state.hostname || state.url || "No active page";
  document.getElementById("status-label").textContent = status.label;
  document.getElementById("status-dot").style.background = presentation.color;
  renderDetails(state);
}

function renderSettings(settings, state) {
  const modeSummary = document.getElementById("mode-summary");
  const setupText = document.getElementById("setup-text");
  const saveStatus = document.getElementById("save-status");
  const form = document.getElementById("mode-form");
  const saveButton = document.getElementById("save-button");
  const choiceNative = document.getElementById("choice-native");
  const choiceFlag = document.getElementById("choice-flag");

  setupText.textContent = settings.setupText || "No setup instructions available.";
  saveStatus.textContent = "";
  renderDiagnostics(settings, state);

  if (!settings.modeOptions || !settings.modeOptions.length) {
    modeSummary.textContent = "This browser uses its built-in certificate inspection path.";
    form.classList.add("hidden");
    choiceNative.classList.add("hidden");
    choiceFlag.classList.add("hidden");
    saveButton.disabled = true;
    return;
  }

  form.classList.remove("hidden");
  modeSummary.textContent = `Current mode: ${settings.mode === "native_helper" ? "Native helper" : "Chrome flag"}`;
  choiceNative.classList.toggle("hidden", !settings.modeOptions.includes("native_helper"));
  choiceFlag.classList.toggle("hidden", !settings.modeOptions.includes("chrome_flag"));

  const radio = form.querySelector(`input[name="mode"][value="${settings.mode}"]`);
  if (radio) {
    radio.checked = true;
  }
}

async function handleSave(event) {
  event.preventDefault();

  const saveStatus = document.getElementById("save-status");
  const selected = document.querySelector('input[name="mode"]:checked');
  if (!selected) {
    saveStatus.textContent = "Choose a detection mode first.";
    return;
  }

  saveStatus.textContent = "Saving...";

  try {
    const result = await saveSettings(selected.value);
    if (result && result.error) {
      throw new Error(result.error);
    }
    renderState(result.state);
    renderSettings(result.settings, result.state);
    saveStatus.textContent = "Mode saved.";
  } catch (error) {
    saveStatus.textContent = error && error.message ? error.message : "Failed to save mode.";
  }
}

async function init() {
  const [state, settings] = await Promise.all([getCurrentState(), getSettings()]);
  const currentState = state || { status: { kind: "unknown", label: "Unknown", reason: "No state." } };
  renderState(currentState);
  renderSettings(settings || {}, currentState);
  document.getElementById("mode-form").addEventListener("submit", handleSave);
}

init();

