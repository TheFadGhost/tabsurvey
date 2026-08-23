import {
  LIMITS,
  STORAGE_KEYS,
  MSG,
  URL_KIND,
  FAILURE_REASONS,
  mergeSettings,
  sanitizeText,
  createTabRecord,
  applyTabDelta,
  validateExtractionPayload,
  validateSessionsImport
} from "../lib/schema.js";
import { syncFromTabs, eligibility, pruneForQuota, groupBuckets, GROUP_COLORS } from "./inventory.js";
import { summarize } from "../lib/summarizer.js";
import { buildDefaultRules, buildDefaultCorrections, categorize, applyCorrection, mergeCorrections as mergeTaggerCorrections } from "../lib/tagger.js";
import { markDuplicates } from "../lib/dedupe.js";

const VERSION = "0.1.0";
const PERSIST_DEBOUNCE_MS = 250;
const TAG_CAP = 12;
const MAX_SESSIONS = 50;
const HOST_ORIGINS = ["http", "https"].map((scheme) => `${scheme}://*/*`);

function emptyCorrections() {
  return { removed: {}, added: {} };
}

function defaultSummarize(doc, opts) {
  return summarize(doc, opts);
}
function defaultCategorize(record, ctx) {
  return categorize(record, ctx);
}
function defaultBuildRules() {
  return buildDefaultRules();
}
function defaultBuildCorrections() {
  return buildDefaultCorrections();
}
function defaultMarkDuplicates(records) {
  return markDuplicates(records) || 0;
}

function normalizeCorrectionsShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyCorrections();
  const map = (v) => {
    const out = {};
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, n] of Object.entries(v)) {
        if (typeof k === "string" && k && Number.isFinite(Number(n))) out[k] = Number(n);
      }
    }
    return out;
  };
  return { removed: map(value.removed), added: map(value.added) };
}

function mergeCorrections(defaults, stored) {
  const base = normalizeCorrectionsShape(defaults);
  const extra = normalizeCorrectionsShape(stored);
  const out = emptyCorrections();
  for (const key of ["removed", "added"]) {
    const merged = { ...base[key] };
    for (const [label, n] of Object.entries(extra[key])) {
      merged[label] = (Number(merged[label]) || 0) + Number(n);
    }
    out[key] = merged;
  }
  return out;
}

function fallbackApplyCorrection(tags, correction, correctionsValue) {
  const corr = normalizeCorrectionsShape(correctionsValue);
  const label = correction && typeof correction.label === "string" ? correction.label : "";
  if (!label) return { tags: [...tags], corrections: corr };
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tag";
  if (correction.op === "remove") {
    corr.removed[label] = (Number(corr.removed[label]) || 0) + 1;
    delete corr.added[label];
    return { tags: tags.filter((t) => !(t && t.label === label)), corrections: corr };
  }
  corr.added[label] = (Number(corr.added[label]) || 0) + 1;
  delete corr.removed[label];
  return {
    tags: [
      ...tags.filter((t) => !(t && t.label === label)),
      { id: `user-${slug}`, label, source: "user", reason: "manual-correction" }
    ],
    corrections: corr
  };
}

function defaultApplyCorrection(tags, correction, correctionsValue) {
  try {
    return applyCorrection(tags, correction, correctionsValue);
  } catch {
    return fallbackApplyCorrection(tags, correction, correctionsValue);
  }
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
  let corrections = emptyCorrections();
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
  const extractAttempts = new Map();
  const EXTRACT_MAX_ATTEMPTS = 4;
  let activeWorkers = 0;
  const counters = { hydrations: 0, extractionsAttempted: 0, extractionsOk: 0, lastExtractError: "", lastSummarySkip: "" };

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
    let defaultsCorrections = emptyCorrections();
    try {
      defaultsCorrections = normalizeCorrectionsShape((await buildCorrectionsFn()) || null);
    } catch {
      defaultsCorrections = emptyCorrections();
    }
    corrections = mergeCorrections(defaultsCorrections, data[STORAGE_KEYS.CORRECTIONS]);
    const rawPending = data[STORAGE_KEYS.PENDING_CLOSE];
    const sanitizedPending = {};
    if (rawPending && typeof rawPending === "object" && !Array.isArray(rawPending)) {
      for (const [batchId, entry] of Object.entries(rawPending)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (typeof batchId !== "string" || batchId.length === 0 || batchId.length > 128) continue;
        const tabIds = Array.isArray(entry.tabIds)
          ? entry.tabIds.map(Number).filter((n) => Number.isInteger(n))
          : null;
        if (!tabIds || tabIds.length === 0) continue;
        const deadlineAt = Number(entry.deadlineAt);
        sanitizedPending[batchId] = {
          batchId,
          tabIds,
          deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : now(),
          snapshot:
            entry.snapshot && typeof entry.snapshot === "object" && !Array.isArray(entry.snapshot)
              ? entry.snapshot
              : {}
        };
      }
    }
    pendingClose = sanitizedPending;
    await refreshHostPermission();
  }

  function ensureHydrated() {
    if (!hydratePromise) {
      hydratePromise = doHydrate()
        .then(async (value) => {
          try {
            const tabs = await api.getTabs({});
            const result = syncFromTabs(tabsMap, tabs, settings);
            tabsMap = result.map;
          } catch {}
          return value;
        })
        .catch((e) => {
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

  async function ingestExtractionPayload(record, payload) {
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
        if (!sum) counters.lastSummarySkip = "summarizer-returned-null";
      } catch (e) {
        counters.lastSummarySkip = String(e && e.message).slice(0, 200);
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
  }

  async function runWorker(id) {
    const key = String(id);
    extracting.add(key);
    counters.extractionsAttempted++;
    const record = tabsMap[key];
    try {
      if (!record) return;
      const live = await api.getTab(record.id).catch(() => null);
      if (!live) {
        record.extraction = { status: "failed", reason: FAILURE_REASONS.UNKNOWN };
        return;
      }
      extractAttempts.set(key, (extractAttempts.get(key) || 0) + 1);
      if (live.status === "loading") {
        record.extraction = null;
        record.summary = null;
        if (extractAttempts.get(key) < EXTRACT_MAX_ATTEMPTS) {
          scheduleExtractRetry(record.id, extractAttempts.get(key));
        } else {
          extractAttempts.set(key, 0);
          record.extraction = { status: "failed", reason: FAILURE_REASONS.TIMEOUT };
        }
        return;
      }
      await api.executeScript(record.id, ["src/content/extractor.js"]);
      const response = await withTimeout(
        api.sendMessageToTab(record.id, { type: "EXTRACT_NOW" }),
        LIMITS.EXTRACT_TIMEOUT_MS
      );
      const payload =
        response && typeof response === "object" && !Array.isArray(response) && "payload" in response
          ? response.payload
          : response;
      await ingestExtractionPayload(record, payload);
      extractAttempts.set(key, 0);
    } catch (err) {
      counters.lastExtractError = String(err && err.message).slice(0, 200);
      if (record) {
        const attempts = Math.max(1, extractAttempts.get(key) || 1);
        const transient =
          attempts < EXTRACT_MAX_ATTEMPTS &&
          /Cannot access|Receiving end does not exist|Frame with ID|No tab with id|cannot be scripted|document not ready|loading/i.test(
            String(err && err.message)
          );
        if (transient) {
          record.extraction = null;
          record.summary = null;
          scheduleExtractRetry(record.id, attempts);
        } else {
          extractAttempts.set(key, 0);
          record.extraction = { status: "failed", reason: mapErrorToReason(err) };
        }
      }
    } finally {
      extracting.delete(key);
      try {
        await markDuplicatesFn(Object.values(tabsMap));
      } catch {}
      schedulePersist();
    }
  }

  function scheduleExtractRetry(id, attempts) {
    timers.setTimeout(
      () => {
        const rec = tabsMap[String(id)];
        if (!rec || extracting.has(String(id))) return;
        if (!eligibility(rec, settings, hostGranted)) return;
        queue.push(id);
        pump();
      },
      Math.min(8000, 1200 * attempts)
    );
  }

  function maybeEnqueueRecord(record) {
    if (!record || record.id == null) return;
    const key = String(record.id);
    if (queue.some((q) => String(q) === key) || extracting.has(key)) return;
    if (!eligibility(record, settings, hostGranted)) return;
    queue.push(record.id);
    pump();
  }

  function onTabCreated(tab) {
    if (!tab || tab.id == null) return;
    const key = String(tab.id);
    if (tabsMap[key]) applyTabDelta(tabsMap[key], tab);
    else tabsMap[key] = createTabRecord(tab);
    maybeEnqueueRecord(tabsMap[key]);
    schedulePersist();
  }

  function onTabUpdated(tabId, changeInfo, tab) {
    const key = String(tabId);
    const record = tabsMap[key];
    const prevUrl = record ? record.url : null;
    const source =
      tab && typeof tab === "object" && Object.keys(tab).length > 0
        ? { ...tab, id: tabId }
        : { id: tabId, ...(changeInfo || {}) };
    if (tabsMap[key]) applyTabDelta(tabsMap[key], source);
    else tabsMap[key] = createTabRecord(source);
    const nextRecord = tabsMap[key];
    const urlChanged = prevUrl != null && nextRecord.url !== prevUrl;
    const navigated = urlChanged || changeInfo?.status === "complete";
    if (urlChanged) {
      nextRecord.extraction = null;
      nextRecord.summary = null;
      nextRecord.tags = [];
      extractAttempts.delete(key);
    }
    if (navigated) maybeEnqueueRecord(nextRecord);
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
    try {
      api.runtimeOnSuspend(() => {
        persistTabsNow().catch(() => {});
      });
    } catch {}
    try {
      api.permissionsOnRemoved(() => {
        hostGranted = false;
        queue.length = 0;
        void refreshHostPermission().catch(() => {});
      });
    } catch {}
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
    try {
      if (!message || typeof message.type !== "string") return { ok: false, error: "unknown-message" };
      if (message.type === "TABSURVEY_EXTRACTION") {
        const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
        if (tabId == null || !message.payload) return { ok: false, error: "no-tab" };
        await ensureHydrated();
        const record = tabsMap[String(tabId)];
        if (!record || extracting.has(String(tabId))) return { ok: true, ignored: true };
        try {
          await ingestExtractionPayload(record, message.payload);
        } catch {}
        schedulePersist();
        return { ok: true };
      }
      if (typeof message.type !== "string") return { ok: false, error: "unknown-message" };
      await ensureHydrated();
      const numericIds = (value) =>
        Array.isArray(value) ? value.map(Number).filter((n) => Number.isFinite(n)) : [];
      message = { ...message };
      if ("tabId" in message) {
        const n = Number(message.tabId);
        if (Number.isFinite(n)) message.tabId = n;
      }
      if ("tabIds" in message) message.tabIds = numericIds(message.tabIds);
      if ("sessionId" in message && typeof message.sessionId !== "string") {
        return { ok: false, error: "unknown-message" };
      }
      switch (message.type) {
        case MSG.GET_STATE: {
          if (queue.length === 0 && extracting.size === 0) {
            Promise.resolve()
              .then(() => enqueueEligible("get-state"))
              .catch(() => {});
          }
          return getStateMessage();
        }
        case MSG.REFRESH_INVENTORY:
          return await refreshInventory();
        case MSG.REQUEST_EXTRACT_ALL: {
          await refreshHostPermission().catch(() => {});
          queue.length = 0;
          for (const record of Object.values(tabsMap)) {
            if (!record || record.kind !== URL_KIND.WEB) continue;
            if (record.extraction && record.extraction.status === "failed") {
              if (settings.excludedDomains.includes(record.domain)) continue;
              record.extraction = null;
              record.summary = null;
            }
          }
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
        extractionsOk: counters.extractionsOk,
        lastSummarySkip: counters.lastSummarySkip || ""
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
