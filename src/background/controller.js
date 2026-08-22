import {
  LIMITS,
  STORAGE_KEYS,
  MSG,
  FAILURE_REASONS,
  mergeSettings,
  sanitizeText,
  createTabRecord,
  applyTabDelta,
  validateExtractionPayload,
  validateSessionsImport
} from "../lib/schema.js";
import { syncFromTabs, eligibility, pruneForQuota, groupBuckets, GROUP_COLORS } from "./inventory.js";

const VERSION = "0.1.0";
const PERSIST_DEBOUNCE_MS = 250;
const TAG_CAP = 12;
const MAX_SESSIONS = 50;
const HOST_ORIGINS = ["http", "https"].map((scheme) => `${scheme}://*/*`);

const moduleCache = new Map();
function loadModule(specifier) {
  if (!moduleCache.has(specifier)) {
    moduleCache.set(
      specifier,
      import(specifier).catch(() => null)
    );
  }
  return moduleCache.get(specifier);
}

async function defaultSummarize(doc, opts) {
  const m = await loadModule("../lib/summarizer.js");
  return m ? m.summarize(doc, opts) : null;
}
async function defaultCategorize(record, ctx) {
  const m = await loadModule("../lib/tagger.js");
  return m ? m.categorize(record, ctx) : [];
}
async function defaultBuildRules() {
  const m = await loadModule("../lib/tagger.js");
  return m ? m.buildDefaultRules() : [];
}
async function defaultBuildCorrections() {
  const m = await loadModule("../lib/tagger.js");
  return m ? m.buildDefaultCorrections() : [];
}
async function defaultMarkDuplicates(records) {
  const m = await loadModule("../lib/dedupe.js");
  return m ? m.markDuplicates(records) : 0;
}

function normalizeCorrectionsShape(value) {
  if (Array.isArray(value)) {
    const out = { added: [], removed: [] };
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const label = typeof item.label === "string" ? item.label : "";
      if (!label) continue;
      if (item.op === "remove") {
        if (!out.removed.includes(label)) out.removed.push(label);
      } else if (item.op === "add") {
        if (!out.added.includes(label)) out.added.push(label);
      }
    }
    return out;
  }
  if (value && typeof value === "object") {
    return {
      added: Array.isArray(value.added) ? [...value.added] : [],
      removed: Array.isArray(value.removed) ? [...value.removed] : []
    };
  }
  return { added: [], removed: [] };
}

function mergeCorrections(defaults, stored) {
  if (stored === undefined || stored === null) {
    return defaults && typeof defaults === "object" ? defaults : { added: [], removed: [] };
  }
  if (Array.isArray(defaults) && Array.isArray(stored)) {
    const seen = new Set(defaults.map((x) => JSON.stringify(x)));
    return [...defaults, ...stored.filter((x) => !seen.has(JSON.stringify(x)))];
  }
  if (defaults && typeof defaults === "object" && stored && typeof stored === "object" && !Array.isArray(stored)) {
    const out = { ...defaults };
    for (const [key, sv] of Object.entries(stored)) {
      const dv = out[key];
      out[key] = Array.isArray(dv) && Array.isArray(sv) ? [...new Set([...dv, ...sv])] : sv;
    }
    return out;
  }
  return stored;
}

function fallbackApplyCorrection(tags, correction, correctionsValue) {
  const corr = normalizeCorrectionsShape(correctionsValue);
  const label = correction && typeof correction.label === "string" ? correction.label : "";
  if (!label) return { tags: [...tags], corrections: corr };
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tag";
  if (correction.op === "remove") {
    if (!corr.removed.includes(label)) corr.removed.push(label);
    corr.added = corr.added.filter((l) => l !== label);
    return { tags: tags.filter((t) => !(t && t.label === label)), corrections: corr };
  }
  if (!corr.added.includes(label)) corr.added.push(label);
  corr.removed = corr.removed.filter((l) => l !== label);
  return {
    tags: [
      ...tags.filter((t) => !(t && t.label === label)),
      { id: `user-${slug}`, label, source: "user", reason: "manual-correction" }
    ],
    corrections: corr
  };
}

async function defaultApplyCorrection(tags, correction, correctionsValue) {
  const m = await loadModule("../lib/tagger.js");
  if (m && typeof m.applyCorrection === "function") return m.applyCorrection(tags, correction, correctionsValue);
  return fallbackApplyCorrection(tags, correction, correctionsValue);
}

function mapErrorToReason(err) {
  const msg = String((err && err.message) || err || "");
  if (/timeout/i.test(msg)) return FAILURE_REASONS.TIMEOUT;
  if (/cannot access contents|access contents|permission|no host|host permission/i.test(msg))
    return FAILURE_REASONS.NO_HOST;
  if (/paywall|pay wall/i.test(msg)) return FAILURE_REASONS.PAYWALL;
  return FAILURE_REASONS.UNKNOWN;
}

class TimeoutError extends Error {
  constructor(ms) {
    super(`extraction timeout after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function createController(api, deps = {}) {
  const timers =
    deps.timers ||
    {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id)
    };
  const now = deps.now || (() => Date.now());
  const summarizeFn = deps.summarize || defaultSummarize;
  const categorizeFn = deps.categorize || defaultCategorize;
  const buildRulesFn = deps.buildRules || defaultBuildRules;
  const buildCorrectionsFn = deps.buildCorrections || defaultBuildCorrections;
  const applyCorrectionFn = deps.applyCorrection || defaultApplyCorrection;
  const markDuplicatesFn = deps.markDuplicates || defaultMarkDuplicates;
  const searchFn = deps.search || null;

  let tabsMap = {};
  let settings = mergeSettings(undefined);
  let sessions = [];
  let corrections = { added: [], removed: [] };
  let pendingClose = {};
  let cachedRules = [];
  let hostGranted = false;
  let quotaPrunedAt = 0;
  let lastAlarmError = null;
  let lastPersistError = null;
  let hadStoredSettings = false;
  let registeredFlag = false;
  let hydratePromise = null;
  let seq = 0;
  let persistTimer = null;
  let queue = [];
  const extracting = new Set();
  let activeWorkers = 0;
  const counters = { hydrations: 0, extractionsAttempted: 0, extractionsOk: 0 };

  const nextSeq = () => ++seq;
  const pendingClosePrefix = `${STORAGE_KEYS.PENDING_CLOSE}:`;

  function clonePlain(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function stripRecord(record) {
    const copy = clonePlain(record);
    if (copy && copy.extraction && typeof copy.extraction === "object" && "text" in copy.extraction) {
      delete copy.extraction.text;
    }
    return copy;
  }

  function stripMap(map) {
    const out = {};
    for (const [key, record] of Object.entries(map)) out[key] = stripRecord(record);
    return out;
  }

  function cloneSession(session) {
    if (!session || typeof session !== "object") return session;
    const out = { ...session, tabs: Array.isArray(session.tabs) ? session.tabs.map((t) => ({ ...t })) : [] };
    return out;
  }

  function clonePending() {
    const out = {};
    for (const [batchId, entry] of Object.entries(pendingClose)) {
      out[batchId] = {
        batchId: entry.batchId,
        tabIds: [...entry.tabIds],
        snapshot: clonePlain(entry.snapshot) || {},
        deadlineAt: entry.deadlineAt
      };
    }
    return out;
  }

  function sanitizeRecordsMap(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [key, record] of Object.entries(raw)) {
      if (!record || typeof record !== "object" || record.id == null) continue;
      const clean = stripRecord(record);
      clean.url = typeof record.url === "string" ? record.url : "";
      clean.kind = typeof record.kind === "string" ? record.kind : "invalid";
      clean.domain = typeof record.domain === "string" ? record.domain : "";
      clean.title = typeof record.title === "string" ? record.title : "";
      clean.windowId = Number.isFinite(record.windowId) ? record.windowId : -1;
      clean.discarded = Boolean(record.discarded);
      clean.tags = Array.isArray(record.tags) ? record.tags.filter((t) => t && typeof t === "object") : [];
      clean.duplicateOf = record.duplicateOf == null ? null : record.duplicateOf;
      clean.extraction = record.extraction && typeof record.extraction === "object" ? record.extraction : null;
      clean.summary = record.summary && typeof record.summary === "object" ? record.summary : null;
      out[String(key)] = clean;
    }
    return out;
  }

  function schedulePersist() {
    if (persistTimer != null) timers.clearTimeout(persistTimer);
    persistTimer = timers.setTimeout(() => {
      persistTimer = null;
      void persistTabs();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function persistTabs() {
    try {
      await api.storageSet({ [STORAGE_KEYS.TABS]: stripMap(tabsMap) });
      lastPersistError = null;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/quota/i.test(msg)) {
        const result = pruneForQuota(tabsMap);
        tabsMap = result.map;
        quotaPrunedAt = now();
        try {
          await api.storageSet({ [STORAGE_KEYS.TABS]: stripMap(tabsMap) });
          lastPersistError = null;
        } catch (e2) {
          lastPersistError = String((e2 && e2.message) || e2);
        }
      } else {
        lastPersistError = msg;
      }
    }
  }

  async function persistTabsNow() {
    if (persistTimer != null) {
      timers.clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistTabs();
  }

  async function refreshHostPermission() {
    try {
      hostGranted = Boolean(await api.permissionsContains(HOST_ORIGINS));
    } catch {
      hostGranted = false;
    }
    return hostGranted;
  }

  async function doHydrate() {
    counters.hydrations++;
    let data = {};
    try {
      data =
        (await api.storageGet([
          STORAGE_KEYS.TABS,
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.SESSIONS,
          STORAGE_KEYS.CORRECTIONS,
          STORAGE_KEYS.PENDING_CLOSE
        ])) || {};
    } catch {
      data = {};
    }
    const stored = sanitizeRecordsMap(data[STORAGE_KEYS.TABS]);
    for (const [key, record] of Object.entries(tabsMap)) {
      if (!(key in stored)) stored[key] = record;
    }
    tabsMap = stored;
    hadStoredSettings = data[STORAGE_KEYS.SETTINGS] != null && typeof data[STORAGE_KEYS.SETTINGS] === "object";
    settings = mergeSettings(data[STORAGE_KEYS.SETTINGS]);
    sessions = Array.isArray(data[STORAGE_KEYS.SESSIONS])
      ? data[STORAGE_KEYS.SESSIONS].slice(-MAX_SESSIONS).map(cloneSession)
      : [];
    try {
      cachedRules = (await buildRulesFn()) || [];
    } catch {
      cachedRules = [];
    }
    let defaultsCorrections = { added: [], removed: [] };
    try {
      defaultsCorrections = (await buildCorrectionsFn()) || { added: [], removed: [] };
    } catch {
      defaultsCorrections = { added: [], removed: [] };
    }
    corrections = mergeCorrections(defaultsCorrections, data[STORAGE_KEYS.CORRECTIONS]);
    pendingClose =
      data[STORAGE_KEYS.PENDING_CLOSE] && typeof data[STORAGE_KEYS.PENDING_CLOSE] === "object"
        ? data[STORAGE_KEYS.PENDING_CLOSE]
        : {};
    await refreshHostPermission();
  }

  function ensureHydrated() {
    if (!hydratePromise) {
      hydratePromise = doHydrate().catch((e) => {
        hydratePromise = null;
        throw e;
      });
    }
    return hydratePromise;
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timerId = timers.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new TimeoutError(ms));
        }
      }, ms);
      promise.then(
        (v) => {
          if (!settled) {
            settled = true;
            timers.clearTimeout(timerId);
            resolve(v);
          }
        },
        (e) => {
          if (!settled) {
            settled = true;
            timers.clearTimeout(timerId);
            reject(e);
          }
        }
      );
    });
  }

  function enqueueEligible(reason) {
    void reason;
    let added = 0;
    for (const record of Object.values(tabsMap)) {
      if (!record || record.id == null) continue;
      const key = String(record.id);
      if (queue.some((q) => String(q) === key)) continue;
      if (extracting.has(key)) continue;
      if (!eligibility(record, settings, hostGranted)) continue;
      queue.push(record.id);
      added++;
    }
    pump();
    return added;
  }

  function pump() {
    while (activeWorkers < LIMITS.EXTRACT_CONCURRENCY && queue.length > 0) {
      const id = queue.shift();
      activeWorkers++;
      runWorker(id)
        .catch(() => {})
        .finally(() => {
          activeWorkers--;
          pump();
        });
    }
  }

  async function runWorker(id) {
    const key = String(id);
    extracting.add(key);
    counters.extractionsAttempted++;
    const record = tabsMap[key];
    try {
      if (!record) return;
      await api.executeScript(record.id, ["src/content/extractor.js"]);
      const payload = await withTimeout(
        api.sendMessageToTab(record.id, { type: "EXTRACT_NOW" }),
        LIMITS.EXTRACT_TIMEOUT_MS
      );
      const validated = validateExtractionPayload(payload);
      let okStatus = false;
      let rawText = "";
      if (validated.ok) {
        const ex = validated.value;
        rawText = typeof ex.text === "string" ? ex.text : "";
        delete ex.text;
        record.extraction = ex;
        okStatus = ex.status === "ok";
      } else {
        const reasonMap = { "empty-text": FAILURE_REASONS.TOO_LITTLE };
        record.extraction = { status: "failed", reason: reasonMap[validated.error] || FAILURE_REASONS.UNKNOWN };
      }
      if (okStatus) {
        counters.extractionsOk++;
        let sum = null;
        try {
          sum = await summarizeFn(
            { title: record.title || "", headings: record.extraction.headings || [], text: rawText },
            { length: settings.summaryLength || "medium" }
          );
        } catch {
          sum = null;
        }
        record.summary =
          sum && typeof sum.abstract === "string"
            ? {
                abstract: sum.abstract,
                sentences: Array.isArray(sum.sentences)
                  ? sum.sentences.map((s) => (typeof s === "string" ? s : s && s.text)).filter((t) => typeof t === "string")
                  : [],
                confidence: sum.confidence === "high" ? "high" : "low",
                generatedAt: now()
              }
            : null;
      }
      try {
        const tags = await categorizeFn(
          {
            title: record.title || "",
            domain: record.domain || "",
            url: record.url || "",
            extraction: record.extraction && record.extraction.excerpt ? { excerpt: record.extraction.excerpt } : null
          },
          { rules: cachedRules || [], corrections }
        );
        record.tags = [...(Array.isArray(tags) ? tags : [])].slice(0, TAG_CAP);
      } catch {
        record.tags = [];
      }
    } catch (err) {
      if (record) {
        record.extraction = { status: "failed", reason: mapErrorToReason(err) };
      }
    } finally {
      extracting.delete(key);
      try {
        await markDuplicatesFn(Object.values(tabsMap));
      } catch {}
      schedulePersist();
    }
  }

  function onTabCreated(tab) {
    if (!tab || tab.id == null) return;
    const key = String(tab.id);
    if (tabsMap[key]) applyTabDelta(tabsMap[key], tab);
    else tabsMap[key] = createTabRecord(tab);
    schedulePersist();
  }

  function onTabUpdated(tabId, changeInfo, tab) {
    const key = String(tabId);
    const source =
      tab && typeof tab === "object" && Object.keys(tab).length > 0
        ? { ...tab, id: tabId }
        : { id: tabId, ...(changeInfo || {}) };
    if (tabsMap[key]) applyTabDelta(tabsMap[key], source);
    else tabsMap[key] = createTabRecord(source);
    schedulePersist();
  }

  function prunePendingForRemoved(tabId) {
    const keyStr = String(tabId);
    let changed = false;
    for (const [batchId, entry] of Object.entries(pendingClose)) {
      if (!entry || !Array.isArray(entry.tabIds)) continue;
      if (!entry.tabIds.map(String).includes(keyStr)) continue;
      entry.tabIds = entry.tabIds.filter((id) => String(id) !== keyStr);
      changed = true;
      if (entry.tabIds.length === 0) {
        delete pendingClose[batchId];
        const alarmName = pendingClosePrefix + batchId;
        Promise.resolve()
          .then(() => api.alarmsClear(alarmName))
          .catch(() => {});
      }
    }
    if (changed) {
      api.storageSet({ [STORAGE_KEYS.PENDING_CLOSE]: clonePending() }).catch(() => {});
    }
  }

  function onTabRemoved(tabId) {
    const key = String(tabId);
    if (key in tabsMap) delete tabsMap[key];
    queue = queue.filter((id) => String(id) !== key);
    extracting.delete(key);
    prunePendingForRemoved(tabId);
    schedulePersist();
  }

  function onTabReplaced(newTabId, oldTabId) {
    const newKey = String(newTabId);
    const oldKey = String(oldTabId);
    const record = tabsMap[oldKey];
    if (record) {
      delete tabsMap[oldKey];
      record.id = newTabId;
      tabsMap[newKey] = record;
    }
    queue = queue.map((id) => (String(id) === oldKey ? newTabId : id));
    for (const entry of Object.values(pendingClose)) {
      entry.tabIds = entry.tabIds.map((id) => (String(id) === oldKey ? newTabId : id));
      if (entry.snapshot && typeof entry.snapshot === "object" && oldKey in entry.snapshot) {
        entry.snapshot[newKey] = entry.snapshot[oldKey];
        delete entry.snapshot[oldKey];
      }
    }
    schedulePersist();
  }

  function onTabActivated(info) {
    const key = String(info && info.tabId);
    const record = tabsMap[key];
    if (record) {
      record.lastAccessed = now();
      schedulePersist();
    }
  }

  async function finalizeAlarm(name) {
    try {
      const alarmName = String(name == null ? "" : name);
      if (!alarmName.startsWith(pendingClosePrefix)) return;
      const batchId = alarmName.slice(pendingClosePrefix.length);
      await ensureHydrated();
      const entry = pendingClose[batchId];
      if (!entry) return;
      await api.tabsRemove([...entry.tabIds]);
      delete pendingClose[batchId];
      await api.storageSet({ [STORAGE_KEYS.PENDING_CLOSE]: clonePending() });
      lastAlarmError = null;
    } catch (e) {
      lastAlarmError = String((e && e.message) || e);
    }
  }

  async function onInstalled() {
    await ensureHydrated();
    if (!hadStoredSettings) {
      try {
        await api.storageSet({ [STORAGE_KEYS.SETTINGS]: { ...settings } });
      } catch {}
    }
  }

  function registerAll() {
    if (registeredFlag) return;
    registeredFlag = true;
    api.runtimeOnMessage((message, sender) => handleMessage(message, sender));
    api.tabEvents.created.add(onTabCreated);
    api.tabEvents.updated.add(onTabUpdated);
    api.tabEvents.removed.add(onTabRemoved);
    api.tabEvents.replaced.add(onTabReplaced);
    api.tabEvents.activated.add(onTabActivated);
    api.alarmsOnAlarm((name) => {
      void finalizeAlarm(name);
    });
    api.runtimeOnInstalled(() => {
      void onInstalled();
    });
    api.runtimeOnStartup(() => {
      void ensureHydrated().catch(() => {});
    });
  }

  function getStateMessage() {
    return {
      tabs: stripMap(tabsMap),
      settings: { ...settings },
      sessions: sessions.map(cloneSession),
      pendingClose: clonePending(),
      hostGranted,
      quotaPrunedAt,
      version: VERSION
    };
  }

  async function refreshInventory() {
    const tabs = await api.getTabs({});
    const result = syncFromTabs(tabsMap, tabs, settings);
    tabsMap = result.map;
    const queued = enqueueEligible("refresh");
    schedulePersist();
    return {
      ok: true,
      count: Object.keys(tabsMap).length,
      created: result.createdIds.length,
      removed: result.removedIds.length,
      queued
    };
  }

  async function stageCloseBatch(tabIds) {
    const snapshot = {};
    for (const id of tabIds) {
      const record = tabsMap[String(id)];
      if (record) snapshot[String(id)] = stripRecord(record);
    }
    const batchId = `close-${now()}-${nextSeq()}`;
    const deadlineAt = now() + settings.undoSeconds * 1000;
    pendingClose[batchId] = { batchId, tabIds: [...tabIds], snapshot, deadlineAt };
    await api.storageSet({ [STORAGE_KEYS.PENDING_CLOSE]: clonePending() });
    await api.alarmsCreate(pendingClosePrefix + batchId, settings.undoSeconds);
    return { batchId, deadlineAt };
  }

  async function cancelClose(batchId) {
    if (!batchId || !pendingClose[batchId]) return { ok: false, error: "unknown-batch" };
    try {
      await api.alarmsClear(pendingClosePrefix + batchId);
    } catch {}
    delete pendingClose[batchId];
    await api.storageSet({ [STORAGE_KEYS.PENDING_CLOSE]: clonePending() });
    return { ok: true, batchId };
  }

  async function saveSession(message) {
    const ids = Array.isArray(message.tabIds) ? message.tabIds : [];
    const records = ids.map((id) => tabsMap[String(id)]).filter(Boolean);
    const session = {
      id: `ses-${now()}-${nextSeq()}`,
      name: sanitizeText(message.name, 120) || "Session",
      createdAt: now(),
      tabs: records.map((r) => ({ url: r.url, title: r.title }))
    };
    sessions = [...sessions, session].slice(-MAX_SESSIONS);
    await api.storageSet({ [STORAGE_KEYS.SESSIONS]: clonePlain(sessions) });
    let close = null;
    if (message.closeAfter) close = await stageCloseBatch(ids);
    return { ok: true, sessionId: session.id, count: session.tabs.length, ...(close ? { close } : {}) };
  }

  async function restoreSession(sessionId) {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return { ok: false, error: "unknown-session" };
    let opened = 0;
    for (const tab of session.tabs) {
      try {
        await api.tabsCreate({ url: tab.url, active: false });
        opened++;
      } catch {}
    }
    return { ok: true, opened };
  }

  async function deleteSession(sessionId) {
    const index = sessions.findIndex((s) => s.id === sessionId);
    if (index === -1) return { ok: false, error: "unknown-session" };
    sessions.splice(index, 1);
    await api.storageSet({ [STORAGE_KEYS.SESSIONS]: clonePlain(sessions) });
    return { ok: true };
  }

  async function importSessions(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { ok: false, error: "invalid-json" };
    }
    const validated = validateSessionsImport(parsed);
    if (!validated.ok) return { ok: false, error: validated.error };
    const byId = new Map(sessions.map((s) => [s.id, cloneSession(s)]));
    for (const s of validated.sessions) byId.set(s.id, s);
    const merged = [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    while (merged.length > MAX_SESSIONS) merged.shift();
    sessions = merged;
    await api.storageSet({ [STORAGE_KEYS.SESSIONS]: clonePlain(sessions) });
    return { ok: true, imported: validated.sessions.length, count: sessions.length };
  }

  async function setSettings(patch) {
    settings = mergeSettings({ ...settings, ...(patch && typeof patch === "object" ? patch : {}) });
    await api.storageSet({ [STORAGE_KEYS.SETTINGS]: { ...settings } });
    return { ok: true, settings: { ...settings } };
  }

  async function correctTags(message) {
    const record = tabsMap[String(message.tabId)];
    if (!record) return { ok: false, error: "unknown-tab" };
    const correction = { op: message.op, label: message.label };
    const current = Array.isArray(record.tags) ? record.tags.map((t) => ({ ...t })) : [];
    const applied = await applyCorrectionFn(current, correction, corrections);
    record.tags = [...(Array.isArray(applied.tags) ? applied.tags : [])].slice(0, TAG_CAP);
    corrections = applied.corrections || corrections;
    try {
      const fresh = await categorizeFn(
        {
          title: record.title || "",
          domain: record.domain || "",
          url: record.url || "",
          extraction:
            record.extraction && record.extraction.excerpt ? { excerpt: record.extraction.excerpt } : null
        },
        { rules: cachedRules || [], corrections }
      );
      record.tags = [...(Array.isArray(fresh) ? fresh : [])].slice(0, TAG_CAP);
    } catch {}
    await api.storageSet({ [STORAGE_KEYS.CORRECTIONS]: clonePlain(corrections) });
    schedulePersist();
    return { ok: true, tags: record.tags.map((t) => ({ ...t })), corrections: clonePlain(corrections) };
  }

  async function groupTabs(message) {
    const filterIds = Array.isArray(message.tabIds) ? message.tabIds : null;
    const records = Object.values(tabsMap).filter((r) => !filterIds || filterIds.includes(r.id));
    const buckets = groupBuckets(records, message.by, filterIds);
    const groups = [];
    let index = 0;
    for (const [title, ids] of Object.entries(buckets)) {
      const groupId = await api.tabGroup(ids);
      await api.updateGroup(groupId, { title, color: GROUP_COLORS[index % GROUP_COLORS.length] });
      groups.push({ title, size: ids.length });
      index++;
    }
    return { ok: true, groups };
  }

  async function discardTabs(tabIds) {
    const errored = await api.tabsDiscard(tabIds);
    const erroredSet = new Set(errored.map(String));
    const discarded = [];
    for (const id of tabIds) {
      if (erroredSet.has(String(id))) continue;
      const record = tabsMap[String(id)];
      if (record) record.discarded = true;
      discarded.push(id);
    }
    schedulePersist();
    return { ok: true, discarded, errored };
  }

  async function setExcludedDomain(domainRaw, enabled) {
    const domain = String(domainRaw || "")
      .toLowerCase()
      .trim();
    if (!domain) return { ok: false, error: "invalid-domain" };
    const set = new Set(settings.excludedDomains);
    if (enabled) set.add(domain);
    else set.delete(domain);
    settings = mergeSettings({ ...settings, excludedDomains: [...set] });
    if (enabled) {
      for (const record of Object.values(tabsMap)) {
        if (record.domain === domain) {
          record.extraction = null;
          record.summary = null;
          record.tags = [];
        }
      }
    }
    await api.storageSet({ [STORAGE_KEYS.SETTINGS]: { ...settings } });
    schedulePersist();
    return { ok: true, settings: { ...settings } };
  }

  async function focusTab(tabId) {
    const record = tabsMap[String(tabId)];
    await api.tabSetActive(tabId);
    if (record && Number.isFinite(record.windowId) && record.windowId >= 0) {
      await api.windowsUpdate(record.windowId, { focused: true });
    }
    return { ok: true };
  }

  function defaultSearch(query, records) {
    const tokens = String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) return [];
    const scored = [];
    for (const record of records) {
      if (!record) continue;
      const parts = [record.title, record.url, record.domain];
      if (record.summary && typeof record.summary.abstract === "string") parts.push(record.summary.abstract);
      if (Array.isArray(record.tags)) for (const t of record.tags) parts.push(t && t.label);
      const hay = parts.filter(Boolean).join(" ").toLowerCase();
      let score = 0;
      for (const token of tokens) if (hay.includes(token)) score += 1;
      if (score > 0) scored.push({ record, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.record);
  }

  async function handleOmniboxSuggestions(text, addSuggestions) {
    try {
      await ensureHydrated();
      const records = Object.values(tabsMap);
      const results = searchFn ? searchFn(String(text || ""), records) : defaultSearch(String(text || ""), records);
      const top = (Array.isArray(results) ? results : []).slice(0, 6);
      addSuggestions(
        top.map((r) => ({
          content: r.url,
          description: `${r.title || "(untitled)"} — ${r.domain || "local"}`
        }))
      );
    } catch {
      try {
        addSuggestions([]);
      } catch {}
    }
  }

  async function handleOmniboxEntered(text, disposition) {
    void disposition;
    await ensureHydrated();
    const value = String(text || "").trim();
    const bareUrl = !/\s/.test(value) && /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(value);
    if (/^https?:\/\//i.test(value) || bareUrl) {
      await api.tabsCreate({ url: value, active: false });
      return { ok: true, opened: value };
    }
    const base = api.runtimeGetURL("src/dashboard/dashboard.html");
    const url = value ? `${base}?q=${encodeURIComponent(value)}` : base;
    await api.tabsCreate({ url, active: true });
    return { ok: true, opened: url };
  }

  async function handleMessage(message, sender) {
    void sender;
    try {
      if (!message || typeof message.type !== "string") return { ok: false, error: "unknown-message" };
      await ensureHydrated();
      switch (message.type) {
        case MSG.GET_STATE:
          return getStateMessage();
        case MSG.REFRESH_INVENTORY:
          return await refreshInventory();
        case MSG.REQUEST_EXTRACT_ALL: {
          queue.length = 0;
          const queued = enqueueEligible("request-extract-all");
          return { ok: true, queued };
        }
        case MSG.CLOSE_TABS: {
          const staged = await stageCloseBatch(Array.isArray(message.tabIds) ? message.tabIds : []);
          return { ok: true, ...staged };
        }
        case MSG.CANCEL_CLOSE:
          return await cancelClose(message.batchId);
        case MSG.SAVE_SESSION:
          return await saveSession(message);
        case MSG.RESTORE_SESSION:
          return await restoreSession(message.sessionId);
        case MSG.DELETE_SESSION:
          return await deleteSession(message.sessionId);
        case MSG.IMPORT_SESSIONS:
          return await importSessions(message.json);
        case MSG.SET_SETTINGS:
          return await setSettings(message.patch);
        case MSG.CORRECT_TAGS:
          return await correctTags(message);
        case MSG.GROUP_TABS:
          return await groupTabs(message);
        case MSG.DISCARD_TABS:
          return await discardTabs(Array.isArray(message.tabIds) ? message.tabIds : []);
        case MSG.SET_EXCLUDED_DOMAIN:
          return await setExcludedDomain(message.domain, message.enabled);
        case MSG.FOCUS_TAB:
          return await focusTab(message.tabId);
        default:
          return { ok: false, error: "unknown-message" };
      }
    } catch (e) {
      return { ok: false, error: "internal-error", detail: String((e && e.message) || e) };
    }
  }

  function getStateSnapshot() {
    return {
      ...getStateMessage(),
      debug: {
        hydrations: counters.hydrations,
        extractionsAttempted: counters.extractionsAttempted,
        extractionsOk: counters.extractionsOk
      },
      lastAlarmError,
      lastPersistError,
      hadStoredSettings,
      queueSize: queue.length,
      extractingCount: extracting.size
    };
  }

  return {
    registerAll,
    handleMessage,
    hydrate: ensureHydrated,
    getStateSnapshot,
    finalizeAlarm,
    handleOmniboxSuggestions,
    handleOmniboxEntered,
    _internals: {
      get tabs() {
        return tabsMap;
      },
      get queue() {
        return [...queue];
      },
      get extracting() {
        return [...extracting];
      },
      get pendingClose() {
        return pendingClose;
      },
      get corrections() {
        return corrections;
      },
      get settings() {
        return settings;
      },
      get sessions() {
        return sessions;
      },
      get counters() {
        return counters;
      },
      get hostGranted() {
        return hostGranted;
      },
      enqueueEligible,
      persistTabs: persistTabsNow,
      schedulePersist,
      refreshHostPermission,
      finalizeAlarm
    }
  };
}
