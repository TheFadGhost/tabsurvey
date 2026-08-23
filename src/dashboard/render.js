import { LIMITS } from "../lib/schema.js";
import { search } from "../lib/searchIndex.js";
import { truncateMiddle, faviconEl, stateGlyphs, announce, rowAriaLabel as sharedRowAriaLabel } from "../shared/uiCommon.js";

const FAILURE_PHRASES = {
  pdf: "Skipped: PDF",
  internal: "Blocked: internal browser page",
  file: "File page",
  "no-host-permission": "No host permission granted",
  "excluded-domain": "Skipped: excluded domain",
  "too-little-text": "Extraction failed â€” page unreadable",
  "image-only": "Image-only page",
  "paywall-stub": "Paywall stub â€” no article text",
  timeout: "Page did not respond",
  "injection-failed": "Extraction failed — page unreadable",
  unknown: "Extraction failed — page unreadable"
};

const KIND_PHRASES = { pdf: FAILURE_PHRASES.pdf, internal: FAILURE_PHRASES.internal, file: FAILURE_PHRASES.file };

const STATE_FILTERS = [
  ["duplicates", "Duplicates"],
  ["audible", "Audible"],
  ["discarded", "Discarded"],
  ["unreadable", "Unreadable"]
];

let activeRowIndex = 0;
let sessionNameDraft = "";
let closeAfterDraft = false;
let excludedDraft = "";

export function isUnreadable(record) {
  if (!record) return false;
  const extraction = record.extraction;
  if (extraction && extraction.status === "failed") return true;
  return record.kind === "web" && !extraction;
}

function compareFor(sort) {
  switch (sort) {
    case "title":
      return (a, b) => String(a.title || "").localeCompare(String(b.title || ""));
    case "domain":
      return (a, b) => String(a.domain || "").localeCompare(String(b.domain || "")) || b.lastAccessed - a.lastAccessed;
    case "window":
      return (a, b) => a.windowId - b.windowId || b.lastAccessed - a.lastAccessed;
    case "recent":
    default:
      return (a, b) => b.lastAccessed - a.lastAccessed;
  }
}

export function visibleRecords(state) {
  const all = Object.values(state.tabs || {}).filter((r) => r && typeof r === "object");
  const query = String(state.filters.query || "").trim();
  let records = query ? search(all, query) : all.slice();
  const categories = state.filters.categories;
  if (categories && categories.size > 0) {
    records = records.filter(
      (r) => Array.isArray(r.tags) && r.tags.some((t) => t && typeof t.label === "string" && categories.has(t.label))
    );
  }
  const states = state.filters.states;
  if (states && states.size > 0) {
    records = records.filter((r) => {
      let hit = false;
      if (states.has("duplicates") && r.duplicateOf != null) hit = true;
      if (states.has("audible") && r.audible) hit = true;
      if (states.has("discarded") && r.discarded) hit = true;
      if (states.has("unreadable") && isUnreadable(r)) hit = true;
      return hit;
    });
  }
  const windows = state.filters.windowIds;
  if (windows && windows.size > 0) {
    records = records.filter((r) => windows.has(r.windowId));
  }
  records.sort(compareFor(state.filters.sort));
  return records;
}

export function failurePhrase(reason) {
  return FAILURE_PHRASES[reason] || FAILURE_PHRASES.unknown;
}

function summaryView(record, hostGranted) {
  const summary = record.summary;
  if (summary && typeof summary.abstract === "string" && summary.abstract.length > 0) {
    return { mode: "ok", text: summary.abstract, low: summary.confidence === "low" };
  }
  const extraction = record.extraction;
  if (extraction && extraction.status === "failed") {
    return { mode: "failed", text: failurePhrase(extraction.reason), low: false };
  }
  if (record.kind !== "web") {
    return { mode: "failed", text: KIND_PHRASES[record.kind] || FAILURE_PHRASES.unknown, low: false };
  }
  if (!hostGranted) {
    return { mode: "failed", text: FAILURE_PHRASES["no-host-permission"], low: false };
  }
  return { mode: "pending", text: "Reading pageâ€¦", low: false };
}

function tagHue(label) {
  let hash = 0;
  const str = String(label);
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return (hash % 12) + 1;
}

function elDiv(className) {
  const node = document.createElement("div");
  if (className) node.className = className;
  return node;
}

function elSpan(className, text) {
  const node = document.createElement("span");
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function elButton(className, text, title) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  if (title) node.title = title;
  return node;
}

function checkbox(checked, ariaLabel) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(checked);
  input.setAttribute("aria-label", ariaLabel);
  return input;
}

export function rowAriaLabel(record) {
  return sharedRowAriaLabel({ ...record, unreadable: isUnreadable(record) });
}

export function renderRow(record, ctx) {
  const li = document.createElement("li");
  li.className = "row row--rich";
  li.setAttribute("role", "listitem");
  li.dataset.id = String(record.id);
  li.setAttribute("aria-label", rowAriaLabel(record));

  const id = String(record.id);
  const title = record.title || record.url || "(untitled)";
  const check = checkbox(ctx.selection.has(id), `Select ${title}`);
  check.className = "row__check";
  check.addEventListener("change", () => {
    ctx.onToggleSelect(id, check.checked);
  });
  li.appendChild(check);

  const favWrap = elSpan("row__fav");
  try {
    const icon = faviconEl(ctx.getURL, record, 16);
    if (icon) favWrap.appendChild(icon);
  } catch {}
  li.appendChild(favWrap);

  const titleEl = elDiv("row__title");
  titleEl.dir = "auto";
  titleEl.textContent = truncateMiddle(title, LIMITS.TITLE_TRUNCATE || 64);
  titleEl.title = record.title || record.url || title;
  li.appendChild(titleEl);

  const domainEl = elDiv("row__domain");
  domainEl.dir = "auto";
  domainEl.textContent = record.domain || record.kind || "";
  li.appendChild(domainEl);

  const view = summaryView(record, ctx.hostGranted);
  const summaryEl = elDiv("row__summary");
  summaryEl.dir = "auto";
  if (view.mode === "pending") summaryEl.classList.add("is-pending");
  if (view.mode === "failed") summaryEl.classList.add("is-failed");
  if (view.low) {
    const badge = elSpan("low-confidence-badge", "low confidence");
    badge.title = "Summary derived from thin source text";
    summaryEl.appendChild(badge);
  }
  summaryEl.appendChild(document.createTextNode(view.text));
  li.appendChild(summaryEl);

  const tagsEl = elDiv("row__tags");
  tagsEl.dir = "auto";
  const tags = Array.isArray(record.tags) ? record.tags.filter((t) => t && t.label) : [];
  const shown = tags.slice(0, 3);
  for (const tag of shown) {
    const chip = elSpan("chip chip--removable");
    chip.title = tag.reason || tag.label;
    const dot = elSpan("chip__dot");
    dot.style.backgroundColor = `var(--dot-${tagHue(tag.label)})`;
    chip.appendChild(dot);
    const labelNode = elSpan(null, tag.label);
    labelNode.dir = "auto";
    chip.appendChild(labelNode);
    if (typeof ctx.onCorrectTag === "function") {
      const removeBtn = elButton("chip__remove", "Ã—", `Remove tag ${tag.label}`);
      removeBtn.setAttribute("aria-label", `Remove tag ${tag.label} from this tab`);
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx.onCorrectTag({ op: "remove", label: tag.label, tabId: record.id });
      });
      chip.appendChild(removeBtn);
    }
    tagsEl.appendChild(chip);
  }
  if (tags.length > shown.length) {
    const extra = tags.length - shown.length;
    const overflow = elSpan("chip", `+${extra}`);
    overflow.title = `${extra} more tag${extra === 1 ? "" : "s"}: ${tags
      .slice(3)
      .map((t) => t.label)
      .join(", ")}`;
    tagsEl.appendChild(overflow);
  }
  if (typeof ctx.onCorrectTag === "function") {
    const addChip = elButton("chip chip--add", "+ tag", "Add a tag to this tab");
    addChip.setAttribute("aria-label", `Add a tag to ${title}`);
    let inlineInput = null;
    addChip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (inlineInput) {
        inlineInput.focus();
        return;
      }
      inlineInput = document.createElement("input");
      inlineInput.type = "text";
      inlineInput.className = "input input--tag-inline";
      inlineInput.setAttribute("aria-label", "New tag name");
      inlineInput.placeholder = "tag name";
      tagsEl.insertBefore(inlineInput, addChip);
      inlineInput.focus();
      const submit = () => {
        const value = String(inlineInput.value || "").trim();
        const inputRef = inlineInput;
        inlineInput = null;
        inputRef.remove();
        if (value) ctx.onCorrectTag({ op: "add", label: value, tabId: record.id });
        addChip.hidden = false;
      };
      inlineInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          submit();
        } else if (ev.key === "Escape") {
          ev.stopPropagation();
          const inputRef2 = inlineInput;
          inlineInput = null;
          if (inputRef2) inputRef2.remove();
          addChip.hidden = false;
          addChip.focus();
        }
      });
      inlineInput.addEventListener("blur", () => {
        setTimeout(() => {
          if (inlineInput && inlineInput.value.trim() === "") {
            const inputRef3 = inlineInput;
            inlineInput = null;
            inputRef3.remove();
            addChip.hidden = false;
          }
        }, 120);
      });
      addChip.hidden = true;
    });
    tagsEl.appendChild(addChip);
  }
  li.appendChild(tagsEl);

  const metaEl = elDiv("row__meta");
  const statusEl = elDiv("row__status");
  try {
    for (const glyph of stateGlyphs(record) || []) statusEl.appendChild(glyph);
  } catch {}
  metaEl.appendChild(statusEl);
  li.appendChild(metaEl);

  li.addEventListener("click", (e) => {
    if (e.target.closest("input, button, a, select, textarea, label")) return;
    ctx.onFocusTab(id);
  });
  return li;
}

function setActiveRow(rows, index) {
  const clamped = Math.min(rows.length - 1, Math.max(0, index));
  activeRowIndex = rows.length > 0 ? clamped : 0;
  for (let i = 0; i < rows.length; i++) rows[i].tabIndex = i === clamped ? 0 : -1;
  if (rows[clamped]) {
    rows[clamped].focus();
    rows[clamped].scrollIntoView({ block: "nearest" });
  }
}

export function wireListKeyboard(listEl, handlers) {
  listEl.addEventListener("keydown", (e) => {
    const row = e.target && e.target.closest ? e.target.closest("li[data-id]") : null;
    if (!row) return;
    if (e.key === "Escape") {
      handlers.clearSelection();
      return;
    }
    if (e.target !== row) return;
    const rows = Array.from(listEl.querySelectorAll("li[data-id]"));
    const idx = rows.indexOf(row);
    switch (e.key) {
      case "ArrowDown":
      case "j":
        e.preventDefault();
        setActiveRow(rows, idx + 1);
        break;
      case "ArrowUp":
      case "k":
        e.preventDefault();
        setActiveRow(rows, idx - 1);
        break;
      case "Home":
        e.preventDefault();
        setActiveRow(rows, 0);
        break;
      case "End":
        e.preventDefault();
        setActiveRow(rows, rows.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        handlers.onFocusTab(row.dataset.id);
        break;
      case "x":
      case "X":
        e.preventDefault();
        handlers.toggleSelected(row.dataset.id);
        break;
      default:
        break;
    }
  });
  listEl.addEventListener("focusin", (e) => {
    const row = e.target && e.target.closest ? e.target.closest("li[data-id]") : null;
    if (!row) return;
    const rows = Array.from(listEl.querySelectorAll("li[data-id]"));
    const idx = rows.indexOf(row);
    if (idx === -1) return;
    activeRowIndex = idx;
    for (let i = 0; i < rows.length; i++) rows[i].tabIndex = i === idx ? 0 : -1;
  });
}

export function renderList(listEl, state, ctx) {
  const records = visibleRecords(state);
  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  const fragment = document.createDocumentFragment();
  activeRowIndex = Math.min(activeRowIndex, Math.max(0, records.length - 1));
  records.forEach((record, index) => {
    const row = renderRow(record, {
      selection: state.selection,
      hostGranted: state.hostGranted,
      getURL: ctx.getURL,
      onToggleSelect: ctx.onToggleSelect,
      onFocusTab: ctx.onFocusTab,
      onCorrectTag: ctx.onCorrectTag
    });
    row.tabIndex = index === activeRowIndex ? 0 : -1;
    fragment.appendChild(row);
  });
  listEl.appendChild(fragment);
  const filterKey = JSON.stringify([
    state.filters.query,
    [...state.filters.categories].sort(),
    [...state.filters.states].sort(),
    [...state.filters.windowIds].sort(),
    state.filters.sort
  ]);
  if (filterKey !== lastAnnouncedFilterKey) {
    lastAnnouncedFilterKey = filterKey;
    announce(`${records.length} tab${records.length === 1 ? "" : "s"} shown`);
  }
  return records;
}

let lastAnnouncedFilterKey = "";

export function renderBulkToolbar(container, state, handlers) {
  while (container.firstChild) container.removeChild(container.firstChild);
  const count = state.selection.size;
  if (count === 0) return;
  container.className = "bulk-toolbar";
  const label = elSpan("selected-count", `${count} selected`);
  container.appendChild(label);
  const closeBtn = elButton("btn btn--danger btn--small", "Close selected");
  closeBtn.addEventListener("click", handlers.closeSelected);
  container.appendChild(closeBtn);
  const discardBtn = elButton("btn btn--ghost btn--small", "Discard selected");
  discardBtn.addEventListener("click", handlers.discardSelected);
  container.appendChild(discardBtn);
  const menuWrap = elDiv("menu-wrap");
  const groupBtn = elButton("btn btn--ghost btn--small", "Group selected â–¾");
  groupBtn.setAttribute("aria-haspopup", "true");
  groupBtn.setAttribute("aria-expanded", "false");
  const menu = elDiv("menu");
  menu.hidden = true;
  for (const by of ["category", "domain", "window"]) {
    const item = elButton("menu__item", by.charAt(0).toUpperCase() + by.slice(1));
    item.addEventListener("click", () => {
      menu.hidden = true;
      groupBtn.setAttribute("aria-expanded", "false");
      handlers.groupSelected(by);
    });
    menu.appendChild(item);
  }
  groupBtn.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    groupBtn.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  });
  menuWrap.appendChild(groupBtn);
  menuWrap.appendChild(menu);
  container.appendChild(menuWrap);
  const clearBtn = elButton("btn btn--ghost btn--small", "Clear");
  clearBtn.addEventListener("click", handlers.clearSelection);
  container.appendChild(clearBtn);
}

function section(titleText) {
  const sec = document.createElement("section");
  const heading = document.createElement("h2");
  heading.className = "section-title";
  heading.textContent = titleText;
  sec.appendChild(heading);
  return sec;
}

function checkRow(labelText, checked, count, onChange, ariaLabel) {
  const label = document.createElement("label");
  const input = checkbox(checked, ariaLabel || labelText);
  input.addEventListener("change", () => onChange(input.checked));
  label.appendChild(input);
  label.appendChild(elSpan(null, labelText));
  if (count != null) {
    const countEl = elSpan("count", String(count));
    label.appendChild(countEl);
  }
  return label;
}

function categoryCounts(records) {
  const counts = new Map();
  let other = 0;
  for (const record of records) {
    const tags = Array.isArray(record.tags) ? record.tags : [];
    if (tags.length === 0) {
      other++;
      continue;
    }
    for (const tag of tags) {
      if (!tag || typeof tag.label !== "string") continue;
      counts.set(tag.label, (counts.get(tag.label) || 0) + 1);
    }
  }
  return { counts, other };
}

function stateCounts(records) {
  const counts = { duplicates: 0, audible: 0, discarded: 0, unreadable: 0 };
  for (const record of records) {
    if (record.duplicateOf != null) counts.duplicates++;
    if (record.audible) counts.audible++;
    if (record.discarded) counts.discarded++;
    if (isUnreadable(record)) counts.unreadable++;
  }
  return counts;
}

function windowCounts(records) {
  const counts = new Map();
  for (const record of records) {
    if (!Number.isFinite(record.windowId) || record.windowId < 0) continue;
    counts.set(record.windowId, (counts.get(record.windowId) || 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => a[0] - b[0]));
}

function renderSessionsSection(parent, state, handlers) {
  const sec = section("Sessions");
  const form = elDiv("session-form");
  const nameInput = document.createElement("input");
  nameInput.className = "input js-session-name";
  nameInput.type = "text";
  nameInput.placeholder = "Session name";
  nameInput.value = sessionNameDraft;
  nameInput.setAttribute("aria-label", "Session name");
  nameInput.addEventListener("input", () => {
    sessionNameDraft = nameInput.value;
  });
  form.appendChild(nameInput);
  const closeLabel = document.createElement("label");
  const closeCheck = checkbox(closeAfterDraft, "Close tabs after saving");
  closeCheck.addEventListener("change", () => {
    closeAfterDraft = closeCheck.checked;
  });
  closeLabel.appendChild(closeCheck);
  closeLabel.appendChild(elSpan(null, "Close tabs"));
  form.appendChild(closeLabel);
  const saveBtn = elButton("btn btn--primary btn--small", "Save session");
  saveBtn.addEventListener("click", () => {
    handlers.saveSession(nameInput.value.trim() || "Session", closeAfterDraft);
  });
  form.appendChild(saveBtn);
  sec.appendChild(form);

  const sessions = Array.isArray(state.sessions) ? state.sessions.slice().reverse() : [];
  if (sessions.length === 0) {
    sec.appendChild(elSpan("muted-line", "No saved sessions."));
  }
  for (const session of sessions) {
    const item = elDiv("session-item");
    const nameEl = elSpan("session-name", session.name || "(unnamed)");
    nameEl.dir = "auto";
    nameEl.title = `${session.name || ""} Â· ${(Array.isArray(session.tabs) ? session.tabs.length : 0)} tabs`;
    item.appendChild(nameEl);
    const restoreBtn = elButton("btn btn--ghost btn--small", "Restore", "Open these tabs in background");
    restoreBtn.addEventListener("click", () => handlers.restoreSession(session.id));
    item.appendChild(restoreBtn);
    const deleteBtn = elButton("btn btn--ghost btn--small", "Delete", "Delete this session");
    deleteBtn.addEventListener("click", () => handlers.deleteSession(session.id));
    item.appendChild(deleteBtn);
    sec.appendChild(item);
  }
  parent.appendChild(sec);
}

function renderSettingsSection(parent, state, handlers) {
  const panel = elDiv("settings-panel");
  panel.id = "settings-panel";
  panel.hidden = true;
  const settings = state.settings || {};

  const themeField = elDiv("field");
  const themeLabel = document.createElement("label");
  themeLabel.textContent = "Theme";
  themeLabel.htmlFor = "theme-select";
  themeField.appendChild(themeLabel);
  const themeSelect = document.createElement("select");
  themeSelect.id = "theme-select";
  themeSelect.className = "input";
  for (const [value, text] of [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
    ["high-contrast", "High contrast"]
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    themeSelect.appendChild(opt);
  }
  themeSelect.value = ["system", "light", "dark", "high-contrast"].includes(settings.theme)
    ? settings.theme
    : "system";
  themeSelect.addEventListener("change", () => handlers.setTheme(themeSelect.value));
  themeField.appendChild(themeSelect);
  panel.appendChild(themeField);

  const lenField = elDiv("field");
  lenField.appendChild(elSpan(null, "Summary length"));
  const radioRow = elDiv("radio-row");
  for (const value of ["short", "medium", "long"]) {
    const lab = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "ts-summary-length";
    radio.value = value;
    radio.checked = (settings.summaryLength || "medium") === value;
    radio.addEventListener("change", () => {
      if (radio.checked) handlers.setSummaryLength(value);
    });
    lab.appendChild(radio);
    lab.appendChild(elSpan(null, value.charAt(0).toUpperCase() + value.slice(1)));
    radioRow.appendChild(lab);
  }
  lenField.appendChild(radioRow);
  panel.appendChild(lenField);

  const undoField = elDiv("field");
  const undoLabel = document.createElement("label");
  undoLabel.textContent = "Undo seconds (2â€“60)";
  undoLabel.htmlFor = "undo-input";
  undoField.appendChild(undoLabel);
  const undoInput = document.createElement("input");
  undoInput.id = "undo-input";
  undoInput.className = "input";
  undoInput.type = "number";
  undoInput.min = "2";
  undoInput.max = "60";
  undoInput.step = "1";
  undoInput.value = String(Math.min(60, Math.max(2, Number(settings.undoSeconds) || 8)));
  undoInput.addEventListener("change", () => {
    const value = Math.min(60, Math.max(2, Math.round(Number(undoInput.value) || 8)));
    undoInput.value = String(value);
    handlers.setUndoSeconds(value);
  });
  undoField.appendChild(undoInput);
  panel.appendChild(undoField);

  const exclField = elDiv("field");
  exclField.appendChild(elSpan(null, "Excluded domains"));
  const domainList = elDiv("domain-list");
  const domains = Array.isArray(settings.excludedDomains) ? settings.excludedDomains : [];
  for (const domain of domains) {
    const item = elDiv("domain-item");
    const nameEl = elSpan(null, domain);
    nameEl.dir = "auto";
    item.appendChild(nameEl);
    const removeBtn = elButton("btn btn--ghost btn--small", "Remove", `Stop excluding ${domain}`);
    removeBtn.setAttribute("aria-label", `Stop excluding ${domain}`);
    removeBtn.addEventListener("click", () => handlers.removeExcludedDomain(domain));
    item.appendChild(removeBtn);
    domainList.appendChild(item);
  }
  if (domains.length === 0) domainList.appendChild(elSpan("muted-line", "None excluded."));
  exclField.appendChild(domainList);
  const addRow = elDiv("add-domain");
  const addInput = document.createElement("input");
  addInput.className = "input";
  addInput.type = "text";
  addInput.placeholder = "example.com";
  addInput.value = excludedDraft;
  addInput.setAttribute("aria-label", "Domain to exclude from page reading");
  addInput.addEventListener("input", () => {
    excludedDraft = addInput.value;
  });
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handlers.addExcludedDomain(addInput.value.trim().toLowerCase());
    }
  });
  addRow.appendChild(addInput);
  const addBtn = elButton("btn btn--ghost btn--small", "Add");
  addBtn.addEventListener("click", () => handlers.addExcludedDomain(addInput.value.trim().toLowerCase()));
  addRow.appendChild(addBtn);
  exclField.appendChild(addRow);
  panel.appendChild(exclField);

  const perms = elDiv("perms-card");
  perms.appendChild(
    elSpan(null, state.hostGranted ? "Site access enabled â€” page reading on." : "Page reading is off â€” summaries unavailable.")
  );
  const permBtn = state.hostGranted
    ? elButton("btn btn--danger btn--small", "Remove site access")
    : elButton("btn btn--primary btn--small", "Enable reading");
  permBtn.addEventListener("click", state.hostGranted ? handlers.removeHost : handlers.enableHost);
  perms.appendChild(permBtn);
  panel.appendChild(perms);

  parent.appendChild(panel);
}

export function toggleSettingsPanel(sidebarEl) {
  const panel = sidebarEl.querySelector(".settings-panel");
  if (!panel) return null;
  panel.hidden = !panel.hidden;
  return !panel.hidden;
}

export function focusSessionName(sidebarEl) {
  const input = sidebarEl.querySelector(".js-session-name");
  if (input) input.focus();
}

export function renderSidebar(sidebarEl, state, handlers) {
  while (sidebarEl.firstChild) sidebarEl.removeChild(sidebarEl.firstChild);
  const records = Object.values(state.tabs || {}).filter((r) => r && typeof r === "object");

  const cats = categoryCounts(records);
  const catSec = section("Categories");
  const catList = elDiv("check-list");
  const sorted = [...cats.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [label, count] of sorted) {
    catList.appendChild(
      checkRow(label, state.filters.categories.has(label), count, (on) => handlers.toggleCategory(label, on))
    );
  }
  catList.appendChild(
    checkRow("Other", state.filters.categories.has("__other__"), cats.other, (on) =>
      handlers.toggleCategory("__other__", on)
    )
  );
  catSec.appendChild(catList);
  sidebarEl.appendChild(catSec);

  const stCounts = stateCounts(records);
  const stateSec = section("States");
  const stateList = elDiv("check-list");
  for (const [key, label] of STATE_FILTERS) {
    stateList.appendChild(
      checkRow(label, state.filters.states.has(key), stCounts[key], (on) => handlers.toggleState(key, on))
    );
  }
  stateSec.appendChild(stateList);
  sidebarEl.appendChild(stateSec);

  const wins = windowCounts(records);
  const winSec = section("Windows");
  const winList = elDiv("check-list");
  for (const [winId, count] of wins) {
    winList.appendChild(
      checkRow(`Window ${winId}`, state.filters.windowIds.has(winId), count, (on) =>
        handlers.toggleWindow(winId, on)
      )
    );
  }
  if (wins.size === 0) winList.appendChild(elSpan("muted-line", "No windows."));
  winSec.appendChild(winList);
  sidebarEl.appendChild(winSec);

  renderSessionsSection(sidebarEl, state, handlers);
  renderSettingsSection(sidebarEl, state, handlers);
}

export function renderBanners(container, state, isDismissed, handlers) {
  while (container.firstChild) container.removeChild(container.firstChild);
  const banners = [];
  if (Number(state.quotaPrunedAt) > 0 && !isDismissed("quota")) {
    const banner = elDiv("banner");
    const text = document.createElement("p");
    text.textContent = "Storage full â€” oldest page texts dropped. Summaries kept.";
    banner.appendChild(text);
    const dismiss = elButton("btn btn--ghost btn--small", "Dismiss");
    dismiss.addEventListener("click", () => handlers.dismissBanner("quota"));
    banner.appendChild(dismiss);
    banners.push(banner);
  }
  if (!state.hostGranted && !isDismissed("permission")) {
    const banner = elDiv("banner");
    const text = document.createElement("p");
    text.textContent = "Page reading is off â€” summaries unavailable.";
    banner.appendChild(text);
    const enable = elButton("btn btn--primary btn--small", "Enable");
    enable.addEventListener("click", () => handlers.enableHost());
    banner.appendChild(enable);
    const dismiss = elButton("btn btn--ghost btn--small", "Dismiss");
    dismiss.addEventListener("click", () => handlers.dismissBanner("permission"));
    banner.appendChild(dismiss);
    banners.push(banner);
  }
  for (const banner of banners) container.appendChild(banner);
}

export function renderOnboarding(container, state, handlers) {
  while (container.firstChild) container.removeChild(container.firstChild);
  if (Number(state.settings && state.settings.onboardedAt) !== 0) return;
  const card = elDiv("onboard-card");
  const heading = document.createElement("h2");
  heading.textContent = "Everything stays on this device";
  card.appendChild(heading);
  const p1 = document.createElement("p");
  p1.dir = "auto";
  p1.textContent =
    "The inventory, summaries and tags shown here are computed locally. Nothing leaves this machine â€” there are zero network requests, and favicons come from your browser's own cache.";
  card.appendChild(p1);
  const list = document.createElement("ul");
  for (const line of [
    "Tabs â€” read tab titles and URLs",
    "Tab groups â€” read group names",
    "Storage â€” keep everything on this device",
    "Alarms â€” run the undo timer",
    "Scripting + optional site access â€” page reading, optional, off until enabled"
  ]) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  card.appendChild(list);
  const actions = elDiv("onboard-actions");
  const enable = elButton("btn btn--primary btn--small", "Enable page reading");
  enable.addEventListener("click", () => handlers.enableHost());
  actions.appendChild(enable);
  const gotIt = elButton("btn btn--ghost btn--small", "Got it");
  gotIt.addEventListener("click", () => handlers.onboardDismiss());
  actions.appendChild(gotIt);
  card.appendChild(actions);
  container.appendChild(card);
}

export function renderHeaderBadge(badgeEl, state) {
  const total = Object.keys(state.tabs || {}).length;
  badgeEl.textContent = String(total);
  badgeEl.setAttribute("aria-label", `${total} tabs total`);
}
