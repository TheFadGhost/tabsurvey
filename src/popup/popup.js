import { MSG, STORAGE_KEYS, LIMITS, mergeSettings } from "../lib/schema.js";
import {
  el,
  truncateMiddle,
  formatRelative,
  faviconEl,
  stateGlyphs,
  announce,
  debounce,
  message,
  storageGet,
  storageOnChanged,
  resolveTheme,
  applyResolvedTheme,
  watchSystemTheme,
  hashDotIndex
} from "../shared/uiCommon.js";

const records = new Map();
let settings = mergeSettings(undefined);
let query = "";
let activeFilter = "all";
let hostGranted = false;
let systemUnsub = null;
let refs = null;

const STATIC_FILTERS = [
  ["all", "All"],
  ["duplicates", "Duplicates"],
  ["audible", "Audible"],
  ["unreadable", "Unreadable"]
];

const STATUS_WORDS = {
  pdf: "PDF",
  internal: "blocked",
  file: "file",
  "no-host-permission": "no permission",
  "excluded-domain": "excluded",
  "too-little-text": "unreadable",
  "image-only": "unreadable",
  "paywall-stub": "unreadable",
  timeout: "unreadable",
  "injection-failed": "unreadable",
  unknown: "unreadable"
};

function getURL(path) {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL(path);
    }
  } catch {}
  return path;
}

function allRecords() {
  return [...records.values()];
}

function isUnreadable(rec) {
  const ex = rec.extraction;
  if (ex && ex.status === "failed") return true;
  return rec.kind === "web" && !ex;
}

function compactStatusWord(rec) {
  const ex = rec.extraction;
  if (ex && ex.status === "failed") return STATUS_WORDS[ex.reason] || "unreadable";
  if (rec.kind && rec.kind !== "web") return STATUS_WORDS[rec.kind] || null;
  return null;
}

function rowTitle(rec) {
  return rec.title || rec.url || "(untitled)";
}

function rowAriaLabel(rec) {
  let label = `${rowTitle(rec)}, ${rec.domain || rec.kind || ""}`;
  if (rec.audible) label += ", audible";
  if (rec.discarded) label += ", discarded";
  if (rec.duplicateOf != null) label += ", duplicate";
  if (rec.pinned) label += ", pinned";
  if (isUnreadable(rec)) label += ", unreadable";
  return label;
}

function recordHaystack(rec) {
  const parts = [rec.title, rec.url, rec.domain];
  const tags = Array.isArray(rec.tags) ? rec.tags : [];
  for (const tag of tags) {
    if (tag && typeof tag.label === "string") parts.push(tag.label);
  }
  if (rec.summary && typeof rec.summary.abstract === "string") parts.push(rec.summary.abstract);
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function matchesQuery(haystack, tokens) {
  for (const token of tokens) {
    if (!haystack.includes(token)) return false;
  }
  return true;
}

function visibleRows() {
  const rows = allRecords().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  let filtered = rows;
  if (activeFilter === "duplicates") filtered = filtered.filter((r) => r.duplicateOf != null);
  else if (activeFilter === "audible") filtered = filtered.filter((r) => r.audible);
  else if (activeFilter === "unreadable") filtered = filtered.filter((r) => isUnreadable(r));
  else if (activeFilter.startsWith("tag:")) {
    const wanted = activeFilter.slice(4);
    filtered = filtered.filter(
      (r) => Array.isArray(r.tags) && r.tags.some((t) => t && t.label === wanted)
    );
  }
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    filtered = filtered.filter((r) => matchesQuery(recordHaystack(r), tokens));
  }
  return filtered;
}

function topTagFilters(all) {
  const counts = new Map();
  for (const rec of all) {
    const tags = Array.isArray(rec.tags) ? rec.tags : [];
    for (const tag of tags) {
      if (!tag || typeof tag.label !== "string" || !tag.label) continue;
      counts.set(tag.label, (counts.get(tag.label) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([label]) => label);
}

function filterDefs(all) {
  const defs = [...STATIC_FILTERS];
  for (const label of topTagFilters(all)) defs.push([`tag:${label}`, label]);
  return defs;
}

function renderChips() {
  while (refs.filters.firstChild) refs.filters.removeChild(refs.filters.firstChild);
  for (const [id, label] of filterDefs(allRecords())) {
    const isActive = id === activeFilter;
    const props = {
      type: "button",
      className: isActive ? "chip chip--active" : "chip",
      dataset: { filter: id },
      "aria-pressed": String(isActive),
      onClick: () => setFilter(id)
    };
    const chip = el("button", props);
    if (id.startsWith("tag:")) {
      const dot = el("span", { className: "chip__dot" });
      dot.style.background = `var(--dot-${hashDotIndex(label)})`;
      chip.appendChild(dot);
    }
    chip.appendChild(document.createTextNode(label));
    refs.filters.appendChild(chip);
  }
}

function buildRow(rec) {
  const id = String(rec.id);
  const row = el("div", {
    className: "row",
    role: "listitem",
    tabIndex: -1,
    dataset: { id },
    ariaLabel: rowAriaLabel(rec)
  });
  const favWrap = el("span", { className: "row__fav" });
  try {
    favWrap.appendChild(faviconEl(getURL, rec, 16));
  } catch {}
  row.appendChild(favWrap);

  const titleEl = el("span", {
    className: "row__title",
    dir: "auto",
    title: rowTitle(rec)
  }, truncateMiddle(rowTitle(rec), LIMITS.TITLE_TRUNCATE));
  row.appendChild(titleEl);

  const domainEl = el("span", { className: "row__domain", dir: "auto" }, rec.domain || rec.kind || "");
  row.appendChild(domainEl);

  const statusWord = compactStatusWord(rec);
  if (statusWord) {
    row.appendChild(el("span", { className: "row__status" }, statusWord));
  }

  const meta = el("span", { className: "row__meta" });
  meta.appendChild(el("span", { className: "row__time" }, formatRelative(rec.lastAccessed)));
  try {
    for (const glyphNode of stateGlyphs(rec)) meta.appendChild(glyphNode);
  } catch {}
  row.appendChild(meta);

  row.addEventListener("click", (e) => {
    if (e.target.closest("input, button, a, select, textarea")) return;
    focusRecord(id);
  });
  return row;
}

function renderList() {
  const list = refs.list;
  const scrollTop = list.scrollTop;
  while (list.firstChild) list.removeChild(list.firstChild);
  const rows = visibleRows();
  const fragment = document.createDocumentFragment();
  rows.forEach((rec, index) => {
    const node = buildRow(rec);
    node.tabIndex = index === 0 ? 0 : -1;
    fragment.appendChild(node);
  });
  list.appendChild(fragment);
  list.scrollTop = Math.min(scrollTop, Math.max(0, list.scrollHeight - list.clientHeight));
  return rows;
}

function renderEmpty(rows, total) {
  const note = refs.emptyNote;
  while (note.firstChild) note.removeChild(note.firstChild);
  if (rows.length > 0) {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  if (total === 0) {
    note.appendChild(el("span", {}, "No open tabs match."));
    note.appendChild(el("span", { className: "hint" }, "Open a few tabs and they will appear here."));
    return;
  }
  if (query.trim()) {
    note.appendChild(el("span", {}, `No results for \u201c${query.trim()}\u201d.`));
    note.appendChild(resetButton());
    return;
  }
  note.appendChild(el("span", {}, "No open tabs match."));
  note.appendChild(resetButton());
}

function resetButton() {
  return el("button", { type: "button", className: "btn btn--ghost btn--small", onClick: resetFilters }, "Reset filters");
}

function resetFilters() {
  query = "";
  activeFilter = "all";
  refs.search.value = "";
  renderAll();
  announce("Filters reset");
}

function setFilter(id) {
  if (activeFilter === id) return;
  activeFilter = id;
  renderAll();
  announceResults();
}

function announceResults() {
  const count = visibleRows().length;
  const name =
    activeFilter === "all"
      ? "All"
      : activeFilter.startsWith("tag:")
        ? activeFilter.slice(4)
        : activeFilter.charAt(0).toUpperCase() + activeFilter.slice(1);
  announce(`${name}: ${count} tab${count === 1 ? "" : "s"}`);
}

function updateEnableButton(total) {
  const hasWeb = allRecords().some((r) => r.kind === "web");
  refs.enableReading.hidden = !(settings.hostPermissionAvailable !== true && !hostGranted && hasWeb && total > 0);
}

function renderStats() {
  const all = allRecords();
  const windows = new Set();
  let duplicates = 0;
  for (const rec of all) {
    if (Number.isFinite(rec.windowId) && rec.windowId >= 0) windows.add(rec.windowId);
    if (rec.duplicateOf != null) duplicates += 1;
  }
  refs.count.textContent = String(all.length);
  refs.count.setAttribute("aria-label", `${all.length} open tabs`);
  refs.footstats.textContent = `${all.length} tabs \u00b7 ${windows.size} windows \u00b7 ${duplicates} duplicates`;
}

function renderAll() {
  if (!refs) return;
  renderStats();
  renderChips();
  const rows = renderList();
  renderEmpty(rows, records.size);
  updateEnableButton(records.size);
}

async function enableReading() {
  try {
    if (
      typeof chrome !== "undefined" &&
      chrome.permissions &&
      typeof chrome.permissions.request === "function"
    ) {
      await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
      hostGranted = true;
    }
  } catch {}
  await message(MSG.SET_SETTINGS, { patch: { hostPermissionAvailable: true } }).catch(() => {});
  await message(MSG.REQUEST_EXTRACT_ALL).catch(() => {});
  updateEnableButton(records.size);
}

function refreshHostState() {
  try {
    if (
      typeof chrome !== "undefined" &&
      chrome.permissions &&
      typeof chrome.permissions.contains === "function"
    ) {
      chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] }, (granted) => {
        hostGranted = Boolean(granted);
        updateEnableButton(records.size);
      });
    }
  } catch {}
}

function focusRecord(id) {
  const tabId = Number(id);
  message(MSG.FOCUS_TAB, { tabId })
    .then(() => {
      setTimeout(() => window.close(), 150);
    })
    .catch(() => {});
}

function applyThemeSetting(value) {
  const resolved = resolveTheme(value);
  try {
    localStorage.setItem("tabsurvey.themeMirror", resolved);
  } catch {}
  applyResolvedTheme(resolved);
  if (systemUnsub) {
    systemUnsub();
    systemUnsub = null;
  }
  if (value === "system") {
    systemUnsub = watchSystemTheme((concrete) => {
      try {
        localStorage.setItem("tabsurvey.themeMirror", concrete);
      } catch {}
      applyResolvedTheme(concrete);
    });
  }
}

function syncSettingsControls() {
  const themeValue = ["light", "dark", "high-contrast", "system"].includes(settings.theme)
    ? settings.theme
    : "system";
  refs.themeSelect.value = themeValue;
  for (const radio of refs.summaryRadios) radio.checked = radio.value === settings.summaryLength;
  refs.excluded.value = (Array.isArray(settings.excludedDomains) ? settings.excludedDomains : []).join("\n");
}

function openSettings(open) {
  if (open) syncSettingsControls();
  refs.settingsPanel.hidden = !open;
  refs.openSettings.setAttribute("aria-expanded", String(open));
}

function saveExcludedDomains() {
  const lines = refs.excluded.value
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  settings = mergeSettings({ ...settings, excludedDomains: [...new Set(lines)] });
  message(MSG.SET_SETTINGS, { patch: { excludedDomains: settings.excludedDomains } }).catch(() => {});
  announce(`Saved ${settings.excludedDomains.length} excluded domain${settings.excludedDomains.length === 1 ? "" : "s"}`);
}

function moveFocusRow(current, delta) {
  const rows = [...refs.list.querySelectorAll(".row")];
  if (rows.length === 0) return;
  const idx = current ? rows.indexOf(current) : -1;
  const next = Math.max(0, Math.min(rows.length - 1, idx === -1 ? 0 : idx + delta));
  for (const row of rows) row.tabIndex = -1;
  rows[next].tabIndex = 0;
  rows[next].focus();
  rows[next].scrollIntoView({ block: "nearest" });
}

function isTyping(target) {
  return Boolean(target && target.closest && target.closest("input, textarea, select"));
}

function wireEvents() {
  refs.search.addEventListener("input", () => {
    query = refs.search.value;
    renderAll();
    announceResults();
  });

  refs.openSettings.addEventListener("click", () => openSettings(refs.settingsPanel.hidden));

  refs.themeSelect.addEventListener("change", () => {
    const value = refs.themeSelect.value;
    settings = mergeSettings({ ...settings, theme: value });
    applyThemeSetting(value);
    message(MSG.SET_SETTINGS, { patch: { theme: value } }).catch(() => {});
  });

  for (const radio of refs.summaryRadios) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      settings = mergeSettings({ ...settings, summaryLength: radio.value });
      message(MSG.SET_SETTINGS, { patch: { summaryLength: radio.value } }).catch(() => {});
    });
  }

  refs.saveExcluded.addEventListener("click", saveExcludedDomains);

  refs.enableReading.addEventListener("click", () => void enableReading());

  refs.openDash.addEventListener("click", async () => {
    await openDashboard();
    window.close();
  });

  refs.list.addEventListener("keydown", (e) => {
    const row = e.target.closest ? e.target.closest(".row") : null;
    if (!row) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocusRow(row, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocusRow(row, -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveFocusRow(null, 0);
    } else if (e.key === "End") {
      e.preventDefault();
      const rows = [...refs.list.querySelectorAll(".row")];
      moveFocusRow(rows[rows.length - 1], 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      focusRecord(row.dataset.id);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !isTyping(e.target)) {
      e.preventDefault();
      refs.search.focus();
      refs.search.select();
      return;
    }
    if (e.key === "Escape") {
      if (!refs.settingsPanel.hidden) {
        openSettings(false);
        refs.openSettings.focus();
      } else if (document.activeElement === refs.search) {
        refs.search.blur();
      }
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !isTyping(e.target)) {
      const inList = document.activeElement && refs.list.contains(document.activeElement);
      if (!inList) {
        e.preventDefault();
        moveFocusRow(null, e.key === "ArrowDown" ? 1 : -1);
      }
    }
  });

  let pendingChanges = null;
  const flushChanges = debounce(() => {
    const changes = pendingChanges;
    pendingChanges = null;
    if (!changes) return;
    digestSnapshot(changes);
    applyThemeSetting(settings.theme);
    renderAll();
  }, 80);
  storageOnChanged((changes) => {
    if (!(STORAGE_KEYS.TABS in changes) && !(STORAGE_KEYS.SETTINGS in changes)) return;
    pendingChanges = { ...(pendingChanges || {}) };
    if (STORAGE_KEYS.TABS in changes) pendingChanges[STORAGE_KEYS.TABS] = changes[STORAGE_KEYS.TABS].newValue;
    if (STORAGE_KEYS.SETTINGS in changes) pendingChanges[STORAGE_KEYS.SETTINGS] = changes[STORAGE_KEYS.SETTINGS].newValue;
    flushChanges();
  });
}

function digestSnapshot(data) {
  if (!data || typeof data !== "object") return;
  const rawTabs = data[STORAGE_KEYS.TABS];
  if (rawTabs && typeof rawTabs === "object") {
    records.clear();
    for (const [key, value] of Object.entries(rawTabs)) {
      if (value && typeof value === "object") records.set(String(key), value);
    }
  }
  const rawSettings = data[STORAGE_KEYS.SETTINGS];
  if (rawSettings !== undefined) settings = mergeSettings(rawSettings);
}

async function loadSnapshot() {
  const snapshot = await storageGet([STORAGE_KEYS.TABS, STORAGE_KEYS.SETTINGS]);
  digestSnapshot(snapshot);
  applyThemeSetting(settings.theme);
  syncSettingsControls();
  renderAll();
  refreshHostState();
  message(MSG.REFRESH_INVENTORY).catch(() => {});
}

function boot() {
  refs = {
    search: document.getElementById("search"),
    filters: document.getElementById("filters"),
    list: document.getElementById("list"),
    emptyNote: document.getElementById("empty-note"),
    footstats: document.getElementById("footstats"),
    count: document.getElementById("count"),
    enableReading: document.getElementById("enable-reading"),
    openDash: document.getElementById("open-dash"),
    openSettings: document.getElementById("open-settings"),
    settingsPanel: document.getElementById("settings-panel"),
    themeSelect: document.getElementById("theme-select"),
    excluded: document.getElementById("excluded-domains"),
    saveExcluded: document.getElementById("save-excluded"),
    summaryRadios: [...document.querySelectorAll('input[name="summary-length"]')]
  };
  wireEvents();
  renderAll();
  void loadSnapshot();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}
