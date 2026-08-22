export const LIMITS = Object.freeze({
  MAX_EXTRACT_CHARS: 20000,
  MAX_HEADINGS: 12,
  MIN_TEXT_CHARS: 280,
  STORED_EXCERPT_CHARS: 1200,
  EXTRACT_CONCURRENCY: 3,
  EXTRACT_TIMEOUT_MS: 15000,
  UNDO_SECONDS_DEFAULT: 8,
  MAX_TABS_SOFT: 2000,
  TITLE_TRUNCATE: 64,
  URL_TRUNCATE: 96
});

export const SUMMARY_SENTENCES = Object.freeze({ short: 2, medium: 3, long: 4 });
export const SUMMARY_MAXCHARS = Object.freeze({ short: 200, medium: 320, long: 460 });

export const STORAGE_KEYS = Object.freeze({
  TABS: "tabs",
  SETTINGS: "settings",
  SESSIONS: "sessions",
  CORRECTIONS: "corrections",
  PENDING_CLOSE: "pendingClose"
});

export const MSG = Object.freeze({
  GET_STATE: "getState",
  REFRESH_INVENTORY: "refreshInventory",
  REQUEST_EXTRACT_ALL: "requestExtractAll",
  CLOSE_TABS: "closeTabs",
  CANCEL_CLOSE: "cancelClose",
  SAVE_SESSION: "saveSession",
  RESTORE_SESSION: "restoreSession",
  DELETE_SESSION: "deleteSession",
  IMPORT_SESSIONS: "importSessions",
  SET_SETTINGS: "setSettings",
  CORRECT_TAGS: "correctTags",
  GROUP_TABS: "groupTabs",
  DISCARD_TABS: "discardTabs",
  SET_EXCLUDED_DOMAIN: "setExcludedDomain",
  FOCUS_TAB: "focusTab"
});

export const URL_KIND = Object.freeze({
  WEB: "web",
  INTERNAL: "internal",
  FILE: "file",
  PDF: "pdf",
  INVALID: "invalid"
});

export const INTERNAL_SCHEMES = [
  "chrome:", "edge:", "about:", "chrome-extension:", "moz-extension:",
  "devtools:", "view-source:", "browser:", "opera:", "vivaldi:", "brave:"
];

export const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "fbclid", "msclkid", "dclid", "twclid", "igshid", "mc_cid", "mc_eid",
  "ref", "ref_src", "ref_url", "referrer", "spm", "vn", "share_id", "yclid", "_ga"
];

export const FAILURE_REASONS = Object.freeze({
  INTERNAL: "internal",
  PDF: "pdf",
  FILE: "file",
  NO_HOST: "no-host-permission",
  EXCLUDED: "excluded-domain",
  TOO_LITTLE: "too-little-text",
  IMAGE_ONLY: "image-only",
  PAYWALL: "paywall-stub",
  TIMEOUT: "timeout",
  INJECTION: "injection-failed",
  UNKNOWN: "unknown"
});

const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp", "com.au", "net.au",
  "org.au", "co.nz", "co.za", "com.br", "com.mx", "com.cn", "com.tw", "com.hk", "co.in",
  "co.kr", "com.sg", "com.tr", "com.ar", "com.ua", "co.il", "com.pl", "com.vn"
]);

export function registrableDomain(hostname) {
  if (!hostname) return "";
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

function looksLikePdf(parsed) {
  const lowerPath = parsed.pathname.toLowerCase();
  if (lowerPath.endsWith(".pdf")) return true;
  for (const value of parsed.searchParams.values()) {
    if (typeof value === "string" && value.toLowerCase().endsWith(".pdf")) return true;
  }
  return false;
}

export function classifyUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 4096) {
    return { kind: URL_KIND.INVALID, host: "", domain: "" };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: URL_KIND.INVALID, host: "", domain: "" };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === "file:") return { kind: URL_KIND.FILE, host: "", domain: "file" };
  if (INTERNAL_SCHEMES.includes(scheme)) return { kind: URL_KIND.INTERNAL, host: "", domain: "" };
  if (scheme === "http:" || scheme === "https:") {
    const domain = registrableDomain(parsed.hostname);
    if (looksLikePdf(parsed)) return { kind: URL_KIND.PDF, host: parsed.host, domain };
    if (parsed.host === "chrome.google.com" && parsed.pathname.startsWith("/webstore")) {
      return { kind: URL_KIND.INTERNAL, host: parsed.host, domain };
    }
    return { kind: URL_KIND.WEB, host: parsed.host, domain };
  }
  return { kind: URL_KIND.INVALID, host: "", domain: "" };
}

export function normalizeUrl(url) {
  if (typeof url !== "string") return "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim();
  }
  parsed.hash = "";
  const drop = [];
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.includes(lower) || lower.startsWith("utm_")) drop.push(key);
  }
  for (const key of drop) parsed.searchParams.delete(key);
  const entries = [...parsed.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  parsed.search = "";
  for (const [k, v] of entries) parsed.searchParams.append(k, v);
  let out = parsed.toString();
  while (out.endsWith("/") && parsed.pathname !== "/") out = out.slice(0, -1);
  return out;
}

export function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const collapsed = cleaned.replace(/[ \t]+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= maxLen) return collapsed;
  return chars.slice(0, maxLen).join("") + "…";
}

export function createTabRecord(tab) {
  const info = classifyUrl(tab.url);
  return {
    id: tab.id,
    url: typeof tab.url === "string" ? tab.url : "",
    normalizedUrl: normalizeUrl(tab.url),
    kind: info.kind,
    domain: info.domain,
    title: sanitizeText(tab.title, 300),
    favIconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : -1,
    groupId: Number.isInteger(tab.groupId) && tab.groupId > -1 ? tab.groupId : null,
    index: Number.isInteger(tab.index) ? tab.index : 0,
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0,
    duplicateOf: null,
    extraction: null,
    summary: null,
    tags: []
  };
}

export function applyTabDelta(record, tab) {
  if (typeof tab.title === "string") record.title = sanitizeText(tab.title, 300);
  if (typeof tab.url === "string") {
    record.url = tab.url;
    record.normalizedUrl = normalizeUrl(tab.url);
    const info = classifyUrl(record.url);
    record.kind = info.kind;
    record.domain = info.domain;
  }
  record.pinned = Boolean(tab.pinned);
  record.audible = Boolean(tab.audible);
  record.discarded = Boolean(tab.discarded);
  if (Number.isInteger(tab.index)) record.index = tab.index;
  if (Number.isInteger(tab.windowId)) record.windowId = tab.windowId;
  record.groupId = Number.isInteger(tab.groupId) && tab.groupId > -1 ? tab.groupId : null;
  if (Number.isFinite(tab.lastAccessed)) record.lastAccessed = tab.lastAccessed;
  if (typeof tab.favIconUrl === "string") record.favIconUrl = tab.favIconUrl;
}

export function validateExtractionPayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, error: "not-an-object" };
  const status = payload.status;
  if (status !== "ok" && status !== "failed") return { ok: false, error: "bad-status" };
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  if (status === "failed") {
    if (!Object.values(FAILURE_REASONS).includes(reason)) return { ok: false, error: "bad-reason" };
    return { ok: true, value: { status, reason } };
  }
  const text = sanitizeText(payload.text, LIMITS.MAX_EXTRACT_CHARS);
  if (!text || Array.from(text).length < 40) return { ok: false, error: "empty-text" };
  let headings = [];
  if (Array.isArray(payload.headings)) {
    headings = payload.headings
      .filter((h) => typeof h === "string")
      .map((h) => sanitizeText(h, 200))
      .filter((h) => h.length > 0)
      .slice(0, LIMITS.MAX_HEADINGS);
  }
  const value = {
    status,
    reason: "",
    text,
    excerpt: Array.from(text).slice(0, LIMITS.STORED_EXCERPT_CHARS).join(""),
    headings,
    description: sanitizeText(payload.description, 300),
    extractedAt: Date.now(),
    byteLength: text.length
  };
  return { ok: true, value };
}

export const DEFAULT_SETTINGS = Object.freeze({
  theme: "system",
  summaryLength: "medium",
  undoSeconds: LIMITS.UNDO_SECONDS_DEFAULT,
  excludedDomains: [],
  onboardedAt: 0,
  hostPermissionAsked: false
});

export function mergeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  if (["light", "dark", "high-contrast", "system"].includes(raw.theme)) out.theme = raw.theme;
  if (["short", "medium", "long"].includes(raw.summaryLength)) out.summaryLength = raw.summaryLength;
  if (Number.isFinite(raw.undoSeconds)) out.undoSeconds = Math.min(60, Math.max(2, Math.round(raw.undoSeconds)));
  if (Array.isArray(raw.excludedDomains)) {
    out.excludedDomains = [...new Set(raw.excludedDomains.filter((d) => typeof d === "string").map((d) => d.toLowerCase()))];
  }
  if (Number.isFinite(raw.onboardedAt)) out.onboardedAt = raw.onboardedAt;
  if (typeof raw.hostPermissionAsked === "boolean") out.hostPermissionAsked = raw.hostPermissionAsked;
  return out;
}

export function validateSessionsImport(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.sessions)) {
    return { ok: false, error: "unsupported-format" };
  }
  const sessions = [];
  for (const s of raw.sessions.slice(0, 500)) {
    if (!s || typeof s !== "object" || typeof s.name !== "string" || !Array.isArray(s.tabs)) continue;
    const tabs = [];
    for (const t of s.tabs.slice(0, 2000)) {
      if (!t || typeof t !== "object") continue;
      if (typeof t.url !== "string" || t.url.length === 0 || t.url.length > 4096) continue;
      tabs.push({ url: t.url, title: sanitizeText(t.title, 300), savedAt: Number.isFinite(t.savedAt) ? t.savedAt : Date.now() });
    }
    if (tabs.length === 0) continue;
    sessions.push({
      id: typeof s.id === "string" && s.id.length <= 64 ? s.id : `imp-${Date.now()}-${sessions.length}`,
      name: sanitizeText(s.name, 120) || "Imported session",
      createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
      tabs
    });
  }
  return { ok: true, sessions };
}


