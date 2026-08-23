import { MSG } from "../lib/schema.js";
import { message } from "../shared/uiCommon.js";
import { inventoryMarkdown, sessionsToJson } from "../lib/exporters.js";

const toNumberIds = (tabIds) =>
  (Array.isArray(tabIds) ? tabIds : [])
    .map(Number)
    .filter((n) => Number.isFinite(n));

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function stampName(base, ext) {
  const d = new Date();
  return `${base}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(
    d.getMinutes()
  )}.${ext}`;
}

export function downloadBlob(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createActions(ui) {
  async function closeWithUndo(tabIds) {
    const ids = toNumberIds(tabIds);
    if (ids.length === 0) return null;
    let res = null;
    try {
      res = await message(MSG.CLOSE_TABS, { tabIds: ids });
    } catch {
      res = null;
    }
    if (!res || res.ok === false) {
      ui.toast("Could not stage closing tabs", "error");
      return null;
    }
    if (typeof ui.showUndoToast === "function") {
      ui.showUndoToast({
        batchId: res.batchId,
        count: ids.length,
        deadlineAt: Number(res.deadlineAt) || Date.now() + 8000
      });
    }
    return res;
  }

  async function discardSelected(tabIds) {
    const ids = toNumberIds(tabIds);
    if (ids.length === 0) return null;
    let res = null;
    try {
      res = await message(MSG.DISCARD_TABS, { tabIds: ids });
    } catch {
      res = null;
    }
    const discarded = res && Array.isArray(res.discarded) ? res.discarded.length : 0;
    if (discarded > 0) ui.toast(`Discarded ${discarded} tab${discarded === 1 ? "" : "s"}`);
    else ui.toast("Could not discard tabs", "error");
    return res;
  }

  async function groupSelected(by, tabIds) {
    let res = null;
    try {
      res = await message(MSG.GROUP_TABS, { by, tabIds: Array.isArray(tabIds) ? tabIds : undefined });
    } catch {
      res = null;
    }
    const groups = res && Array.isArray(res.groups) ? res.groups.length : 0;
    if (res && res.ok !== false && groups > 0) ui.toast(`Grouped into ${groups} group${groups === 1 ? "" : "s"}`);
    else ui.toast("Nothing to group", "error");
    return res;
  }

  async function saveSessionFlow({ name, tabIds, closeAfter }) {
    let res = null;
    try {
      res = await message(MSG.SAVE_SESSION, {
        name: String(name || "Session").slice(0, 120),
        tabIds: toNumberIds(tabIds),
        closeAfter: Boolean(closeAfter)
      });
    } catch {
      res = null;
    }
    if (!res || res.ok === false) {
      ui.toast("Could not save session", "error");
      return null;
    }
    ui.toast(`Saved session with ${res.count || 0} tab${(res.count || 0) === 1 ? "" : "s"}`);
    if (closeAfter && res.close && typeof ui.showUndoToast === "function") {
      ui.showUndoToast({
        batchId: res.close.batchId,
        count: Array.isArray(tabIds) ? tabIds.length : 0,
        deadlineAt: Number(res.close.deadlineAt) || Date.now() + 8000
      });
    }
    return res;
  }

  function exportInventory(records) {
    const list = Array.isArray(records) ? records : [];
    const markdown = inventoryMarkdown(list, { generatedAt: new Date().toISOString() });
    downloadBlob(markdown, stampName("tabsurvey", "md"), "text/markdown;charset=utf-8");
    ui.toast("Markdown exported");
  }

  function exportSessions(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    downloadBlob(
      sessionsToJson(list),
      stampName("tabsurvey-sessions", "json"),
      "application/json;charset=utf-8"
    );
    ui.toast("Sessions exported");
  }

  async function importSessions(fileText) {
    let res = null;
    try {
      res = await message(MSG.IMPORT_SESSIONS, { json: String(fileText || "") });
    } catch {
      res = null;
    }
    if (res && res.ok) ui.toast(`Imported ${res.imported || 0} session${(res.imported || 0) === 1 ? "" : "s"}`);
    else ui.toast(`Import failed${res && res.error ? `: ${res.error}` : ""}`, "error");
    return res;
  }

  async function restoreSession(sessionId) {
    let res = null;
    try {
      res = await message(MSG.RESTORE_SESSION, { sessionId });
    } catch {
      res = null;
    }
    if (res && res.ok) ui.toast(`Restored ${res.opened || 0} tab${(res.opened || 0) === 1 ? "" : "s"}`);
    else ui.toast("Could not restore session", "error");
    return res;
  }

  async function deleteSession(sessionId) {
    let res = null;
    try {
      res = await message(MSG.DELETE_SESSION, { sessionId });
    } catch {
      res = null;
    }
    if (res && res.ok) ui.toast("Session deleted", "info");
    else ui.toast("Could not delete session", "error");
    return res;
  }

  return {
    closeWithUndo,
    discardSelected,
    groupSelected,
    saveSessionFlow,
    exportInventory,
    exportSessions,
    importSessions,
    restoreSession,
    deleteSession
  };
}
