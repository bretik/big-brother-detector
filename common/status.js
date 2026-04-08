(function (global) {
  "use strict";

  const DEFAULT_RULES = {
    issuerPatterns: [/zscaler/i, /zscaler inc\.?/i, /zscaler intermediate root ca/i],
    subjectPatterns: [/zscaler/i, /zscaler inc\.?/i, /zscaler intermediate root ca/i],
  };

  const OID_MAP = {
    "2.5.4.3": "CN",
    "2.5.4.6": "C",
    "2.5.4.7": "L",
    "2.5.4.8": "ST",
    "2.5.4.10": "O",
    "2.5.4.11": "OU",
    "2.5.4.12": "T",
    "2.5.4.4": "SN",
    "2.5.4.9": "STREET",
    "2.5.4.5": "SERIALNUMBER",
  };

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function matchesAnyPattern(value, patterns) {
    return patterns.some((pattern) => pattern.test(value));
  }

  function toUint8Array(value) {
    if (value instanceof Uint8Array) {
      return value;
    }

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }

    if (ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    if (Array.isArray(value)) {
      return Uint8Array.from(value);
    }

    return new Uint8Array();
  }

  function bytesToHex(bytes) {
    const data = toUint8Array(bytes);
    let hex = "";

    for (let index = 0; index < data.length; index += 1) {
      hex += data[index].toString(16).padStart(2, "0");
    }

    return hex;
  }

  function describeDebugValue(value, seen = new WeakSet(), depth = 0) {
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (depth > 5) {
      return "[Max depth reached]";
    }

    if (value instanceof ArrayBuffer || (ArrayBuffer.isView && ArrayBuffer.isView(value))) {
      const bytes = toUint8Array(value);
      return {
        type: value instanceof ArrayBuffer ? "ArrayBuffer" : (value.constructor && value.constructor.name ? value.constructor.name : "TypedArray"),
        byteLength: bytes.length,
        hex: bytesToHex(bytes),
      };
    }

    if (Array.isArray(value)) {
      return value.map((item) => describeDebugValue(item, seen, depth + 1));
    }

    if (typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
      const output = {};
      for (const [key, entry] of Object.entries(value)) {
        output[key] = describeDebugValue(entry, seen, depth + 1);
      }
      seen.delete(value);
      return output;
    }

    return String(value);
  }

  function readLength(bytes, offsetRef) {
    const first = bytes[offsetRef.index];
    offsetRef.index += 1;

    if ((first & 0x80) === 0) {
      return first;
    }

    const lengthBytes = first & 0x7f;
    let length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = (length << 8) | bytes[offsetRef.index];
      offsetRef.index += 1;
    }
    return length;
  }

  function readNode(bytes, offsetRef) {
    const start = offsetRef.index;
    const tag = bytes[offsetRef.index];
    offsetRef.index += 1;
    const length = readLength(bytes, offsetRef);
    const valueStart = offsetRef.index;
    const end = valueStart + length;
    const constructed = (tag & 0x20) !== 0;
    const children = [];

    if (constructed) {
      while (offsetRef.index < end) {
        children.push(readNode(bytes, offsetRef));
      }
    } else {
      offsetRef.index = end;
    }

    return {
      tag,
      length,
      valueStart,
      end,
      children,
      bytes: bytes.slice(valueStart, end),
      start,
    };
  }

  function decodeBytes(tag, bytes) {
    if (!bytes || !bytes.length) {
      return "";
    }


    if (tag === 0x0c || tag === 0x13 || tag === 0x16 || tag === 0x14 || tag === 0x1e) {
      try {
        return new TextDecoder("utf-8").decode(bytes);
      } catch (error) {
        return "";
      }
    }

    return "";
  }

  function oidFromBytes(bytes) {
    if (!bytes || !bytes.length) {
      return "";
    }

    const parts = [];
    const first = bytes[0];
    parts.push(Math.floor(first / 40));
    parts.push(first % 40);

    let value = 0;
    for (let index = 1; index < bytes.length; index += 1) {
      const byte = bytes[index];
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) {
        parts.push(value);
        value = 0;
      }
    }

    return parts.join(".");
  }

  function parseRelativeDistinguishedName(setNode) {
    const parts = [];

    for (const seqNode of setNode.children || []) {
      if (!seqNode.children || seqNode.children.length < 2) {
        continue;
      }

      const oidNode = seqNode.children[0];
      const valueNode = seqNode.children[1];
      const oid = oidFromBytes(oidNode.bytes);
      const label = OID_MAP[oid] || oid;
      const value = decodeBytes(valueNode.tag, valueNode.bytes) || normalizeText(valueNode.valueText || "");

      if (label && value) {
        parts.push(`${label}=${value}`);
      }
    }

    return parts;
  }

  function parseName(nameNode) {
    const rdns = [];
    for (const setNode of nameNode.children || []) {
      if ((setNode.tag & 0x1f) !== 0x11) {
        continue;
      }
      const parts = parseRelativeDistinguishedName(setNode);
      if (parts.length) {
        rdns.push(parts.join("+"));
      }
    }
    return rdns.join(", ");
  }

  function parseCertificateNames(rawDER) {
    const bytes = toUint8Array(rawDER);
    if (!bytes.length || bytes[0] !== 0x30) {
      return { subject: "", issuer: "" };
    }

    const root = readNode(bytes, { index: 0 });
    const tbs = root.children && root.children.length ? root.children[0] : null;
    if (!tbs || !tbs.children || !tbs.children.length) {
      return { subject: "", issuer: "" };
    }

    const sequenceChildren = tbs.children.filter((child) => (child.tag & 0x1f) === 0x10);
    if (sequenceChildren.length < 4) {
      return { subject: "", issuer: "" };
    }

    let index = 0;
    if ((tbs.children[0].tag & 0xe0) === 0xa0) {
      index = 1;
    }

    const issuerNode = tbs.children[index + 2] || sequenceChildren[1] || null;
    const subjectNode = tbs.children[index + 4] || sequenceChildren[2] || null;

    return {
      issuer: issuerNode ? parseName(issuerNode) : "",
      subject: subjectNode ? parseName(subjectNode) : "",
    };
  }

  function collectTextValues(value, output, depth = 0) {
    if (value == null || depth > 3) {
      return;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output.push(String(value));
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectTextValues(item, output, depth + 1);
      }
      return;
    }

    if (typeof value === "object") {
      for (const entry of Object.values(value)) {
        collectTextValues(entry, output, depth + 1);
      }
    }
  }

  function findFieldText(value, fieldNames) {
    if (!value || typeof value !== "object") {
      return "";
    }

    for (const fieldName of fieldNames) {
      const direct = value[fieldName];
      if (typeof direct === "string" && direct.trim()) {
        return direct.trim();
      }
    }

    for (const [key, entry] of Object.entries(value)) {
      if (fieldNames.some((fieldName) => key.toLowerCase() === fieldName.toLowerCase())) {
        const nested = findFieldText(entry, fieldNames);
        if (nested) {
          return nested;
        }
        const collected = [];
        collectTextValues(entry, collected);
        if (collected.length) {
          return collected.join(" | ");
        }
      }
    }

    return "";
  }

  function normalizeCertificate(certificate) {
    if (!certificate) {
      return { subject: "", issuer: "", rawDERPresent: false, keys: [] };
    }

    const parsed = certificate.rawDER ? parseCertificateNames(certificate.rawDER) : { subject: "", issuer: "" };
    const fallbackSubject = normalizeText(findFieldText(certificate, ["subject", "subjectName", "issuedTo"]));
    const fallbackIssuer = normalizeText(findFieldText(certificate, ["issuer", "issuerName", "issuedBy"]));
    const keys = Object.keys(certificate).sort();

    return {
      subject: normalizeText(parsed.subject || fallbackSubject),
      issuer: normalizeText(parsed.issuer || fallbackIssuer),
      rawDERPresent: !!certificate.rawDER,
      keys,
    };
  }

  function certificateMatchesRules(certificate, rules) {
    const normalized = normalizeCertificate(certificate);
    const haystack = [normalized.issuer, normalized.subject].filter(Boolean).join(" ");

    if (normalized.issuer && matchesAnyPattern(normalized.issuer, rules.issuerPatterns)) {
      return true;
    }

    if (normalized.subject && matchesAnyPattern(normalized.subject, rules.subjectPatterns)) {
      return true;
    }

    if (haystack && (matchesAnyPattern(haystack, rules.issuerPatterns) || matchesAnyPattern(haystack, rules.subjectPatterns))) {
      return true;
    }

    return false;
  }

  function summarizeCertificates(certificates) {
    const list = Array.isArray(certificates) ? certificates : [];
    const normalized = list.map(normalizeCertificate);
    const first = normalized.length ? normalized[0] : null;

    return {
      count: normalized.length,
      firstSubject: first ? first.subject : "",
      firstIssuer: first ? first.issuer : "",
      rawDERPresent: first ? first.rawDERPresent : false,
      firstKeys: first ? first.keys : [],
    };
  }

  function summaryMatchesRules(summary, rules) {
    if (!summary) {
      return false;
    }

    const issuer = normalizeText(summary.firstIssuer);
    const subject = normalizeText(summary.firstSubject);
    const haystack = [issuer, subject].filter(Boolean).join(" ");

    if (issuer && matchesAnyPattern(issuer, rules.issuerPatterns)) {
      return true;
    }

    if (subject && matchesAnyPattern(subject, rules.subjectPatterns)) {
      return true;
    }

    if (haystack && (matchesAnyPattern(haystack, rules.issuerPatterns) || matchesAnyPattern(haystack, rules.subjectPatterns))) {
      return true;
    }

    return false;
  }

  function evaluateInterception(securityInfo, rules = DEFAULT_RULES) {
    if (!securityInfo) {
      return {
        kind: "unknown",
        label: "Unknown",
        reason: "No security information was available for this page.",
      };
    }

    if (securityInfo.protocol === "http:") {
      return {
        kind: "insecure",
        label: "No TLS",
        reason: "This page is not using HTTPS, so there is no certificate to inspect.",
      };
    }

    const certificates = Array.isArray(securityInfo.certificates)
      ? securityInfo.certificates
      : [];

    const matchedCertificate = certificates.find((certificate) =>
      certificateMatchesRules(certificate, rules)
    );

    if (matchedCertificate || summaryMatchesRules(securityInfo.certificateSummary, rules)) {
      return {
        kind: "intercepted",
        label: "Intercepted",
        reason: "A configured Zscaler issuer or subject matched this page.",
      };
    }

    if (securityInfo.protocol !== "https:") {
      return {
        kind: "unknown",
        label: "Unknown",
        reason: "The page did not provide an HTTPS certificate chain.",
      };
    }

    if (!certificates.length && !securityInfo.certificateSummary) {
      return {
        kind: "unknown",
        label: "Unknown",
        reason: "The HTTPS connection was seen, but no certificate chain was exposed.",
      };
    }

    return {
      kind: "not_intercepted",
      label: "Not intercepted",
      reason: "No configured interception issuer or subject matched this page.",
    };
  }

  function getStatusPresentation(status) {
    switch (status.kind) {
      case "loading":
        return {
          color: "#78909c",
          badgeText: "",
          headline: "Checking",
        };
      case "intercepted":
        return {
          color: "#c62828",
          badgeText: "MITM",
          headline: "Traffic intercepted",
        };
      case "not_intercepted":
        return {
          color: "#2e7d32",
          badgeText: "OK",
          headline: "Direct TLS",
        };
      case "insecure":
        return {
          color: "#ef6c00",
          badgeText: "HTTP",
          headline: "No TLS",
        };
      default:
        return {
          color: "#546e7a",
          badgeText: "?",
          headline: "Unknown",
        };
    }
  }

  function buildTabState(input) {
    const url = input && input.url ? input.url : "";
    const securityInfo = input && input.securityInfo ? input.securityInfo : null;
    const certificateSummary = summarizeCertificates(securityInfo && securityInfo.certificates);
    const status = evaluateInterception({
      ...securityInfo,
      certificateSummary,
    });
    return {
      url,
      hostname: safeHostname(url),
      status,
      securityInfo,
      certificateSummary,
      debug: buildDebug(securityInfo, certificateSummary),
      updatedAt: new Date().toISOString(),
    };
  }

  function buildDebug(securityInfo, certificateSummary) {
    const firstCert = Array.isArray(securityInfo && securityInfo.certificates) && securityInfo.certificates.length
      ? securityInfo.certificates[0]
      : null;

    return {
      securityInfoKeys: securityInfo ? Object.keys(securityInfo).sort() : [],
      certCount: certificateSummary ? certificateSummary.count : 0,
      firstSummary: certificateSummary || null,
      firstCertKeys: firstCert ? Object.keys(firstCert).sort() : [],
      firstCertType: firstCert ? typeof firstCert : "none",
      firstCertSnapshot: firstCert ? describeDebugValue(firstCert) : null,
      securityInfoSnapshot: securityInfo ? describeDebugValue(securityInfo) : null,
    };
  }

  function safeHostname(url) {
    try {
      return new URL(url).hostname;
    } catch (error) {
      return "";
    }
  }

  function createLoadingState(url, reason) {
    const certificateSummary = summarizeCertificates([]);
    return {
      url: url || "",
      hostname: safeHostname(url || ""),
      status: {
        kind: "loading",
        label: "Checking",
        reason: reason || "Waiting for certificate information.",
      },
      securityInfo: url && url.startsWith("https://")
        ? { protocol: "https:", certificates: [] }
        : url && url.startsWith("http://")
          ? { protocol: "http:", certificates: [] }
          : null,
      certificateSummary,
      debug: buildDebug(null, certificateSummary),
      updatedAt: new Date().toISOString(),
    };
  }

  function createUnknownState(url, reason) {
    return {
      url: url || "",
      hostname: safeHostname(url || ""),
      status: {
        kind: "unknown",
        label: "Unknown",
        reason,
      },
      securityInfo: url && url.startsWith("https://")
        ? { protocol: "https:", certificates: [] }
        : url && url.startsWith("http://")
          ? { protocol: "http:", certificates: [] }
          : null,
      certificateSummary: summarizeCertificates([]),
      debug: {
        securityInfoKeys: [],
        certCount: 0,
        firstSummary: null,
        firstCertKeys: [],
        firstCertType: "none",
      },
      updatedAt: new Date().toISOString(),
    };
  }

  global.BigBrotherStatus = {
    DEFAULT_RULES,
    buildTabState,
    createLoadingState,
    createUnknownState,
    evaluateInterception,
    getStatusPresentation,
    safeHostname,
    summarizeCertificates,
  };
})(this);

