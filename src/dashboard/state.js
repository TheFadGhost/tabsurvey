import { STORAGE_KEYS, MSG, mergeSettings } from "../lib/schema.js";
import { message } from "../shared/uiCommon.js";

export function createStore(initial) {
  let state = {
    tabs: {},
    settings: mergeSettings(undefined),
    sessions: [],
    pendingClose: {},
    hostGranted: false,
    quotaPrunedAt: 0,
    filters: { query: "", categories: new Set(), states: new Set(), windowIds: new Set(), sort: "recent" },
    selection: new Set(),
    busy: false,
    lastBatch: null,
    ...(initial && typeof initial === "object" ? initial : {})
  };
  const subscribers = new Set();
  const notify = () => {
    for (const fn of Array.from(subscribers)) {
      try {
        fn(state);
      } catch {}
    }
  };
  return {
    get() {
      return state;
    },
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    patch(partial) {
      if (partial && typeof partial === "object") state = { ...state, ...partial };
      notify();
    }
  };
}

function cleanTabs(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, record] of Object.entries(raw)) {
    if (record && typeof record === "object") out[String(key)] = record;
  }
  return out;
}

function cleanSessions(raw) {
  return Array.isArray(raw) ? raw.filter((s) => s && typeof s === "object") : [];
}

function cleanPending(raw) {
  return raw && typeof raw === "object" ? raw : {};
}

export function initFromStorage(store) {
  const api = typeof globalThis.chrome !== "undefined" ? globalThis.chrome : null;
  const hasLocal = Boolean(api && api.storage && api.storage.local && api.storage.onChanged);
  const applyPartial = (partial) => {
    if (partial && Object.keys(partial).length > 0) store.patch(partial);
  };
  const digest = (data) => {
    const partial = {};
    if (!data || typeof data !== "object") return partial;
    if (STORAGE_KEYS.TABS in data) partial.tabs = cleanTabs(data[STORAGE_KEYS.TABS]);
    if (STORAGE_KEYS.SETTINGS in data) partial.settings = mergeSettings(data[STORAGE_KEYS.SETTINGS]);
    if (STORAGE_KEYS.SESSIONS in data) partial.sessions = cleanSessions(data[STORAGE_KEYS.SESSIONS]);
    if (STORAGE_KEYS.PENDING_CLOSE in data) partial.pendingClose = cleanPending(data[STORAGE_KEYS.PENDING_CLOSE]);
    return partial;
  };
  if (hasLocal) {
    try {
      Promise.resolve(
        api.storage.local.get([
          STORAGE_KEYS.TABS,
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.SESSIONS,
          STORAGE_KEYS.PENDING_CLOSE
        ])
      )
        .then((data) => applyPartial(digest(data)))
        .catch(() => {});
    } catch {}
    try {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes || typeof changes !== "object") return;
        const scoped = {};
        for (const key of [
          STORAGE_KEYS.TABS,
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.SESSIONS,
          STORAGE_KEYS.PENDING_CLOSE
        ]) {
          if (key in changes) scoped[key] = changes[key] ? changes[key].newValue : undefined;
        }
        applyPartial(digest(scoped));
      });
    } catch {}
  }
  const refresh = async () => {
    try {
      const snapshot = await message(MSG.GET_STATE);
      if (!snapshot || typeof snapshot !== "object") return;
      store.patch({
        tabs: cleanTabs(snapshot.tabs),
        settings: mergeSettings(snapshot.settings),
        sessions: cleanSessions(snapshot.sessions),
        pendingClose: cleanPending(snapshot.pendingClose),
        hostGranted: Boolean(snapshot.hostGranted),
        quotaPrunedAt: Number(snapshot.quotaPrunedAt) || 0
      });
    } catch {}
  };
  void refresh();
  return { refresh };
}
