import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeChrome, makeManualTimers } from "../fakes/fakeChrome.js";
import { createBrowserApi } from "../../src/background/browserApi.js";
import { createController } from "../../src/background/controller.js";
import { eligibility, groupBuckets, GROUP_COLORS } from "../../src/background/inventory.js";
import {
  STORAGE_KEYS,
  MSG,
  LIMITS,
  DEFAULT_SETTINGS,
  mergeSettings,
  createTabRecord,
  FAILURE_REASONS
} from "../../src/lib/schema.js";

let realSummarizer = null;
let realTagger = null;
let realDedupe = null;
try {
  realSummarizer = await import("../../src/lib/summarizer.js");
} catch {
  realSummarizer = null;
}
try {
  realTagger = await import("../../src/lib/tagger.js");
} catch {
  realTagger = null;
}
try {
  realDedupe = await import("../../src/lib/dedupe.js");
} catch {
  realDedupe = null;
}

const LIB_MODE = {
  summarizer: "real",
  tagger: "real",
  dedupe: "real"
};
console.log(`[lifecycle] lib mode: ${JSON.stringify(LIB_MODE)}`);


function makeDeps(timers, overrides = {}) {
  return {
    summarize: realSummarizer.summarize,
    categorize: realTagger.categorize,
    buildRules: realTagger.buildDefaultRules,
    buildCorrections: realTagger.buildDefaultCorrections,
    applyCorrection: realTagger.applyCorrection,
    markDuplicates: realDedupe.markDuplicates,
    timers,
    ...overrides
  };
}

async function flush(turns = 40) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

const SAMPLE_TEXT =
  "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega. ".repeat(
    7
  );

function firstRuleLabel(record) {
  const tag = (record.tags || []).find((t) => t && t.source === "rule");
  return tag ? tag.label : "Other";
}

test("1. fresh install seeds DEFAULT_SETTINGS into storage", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  ctrl.registerAll();
  assert.equal(fake.runtime.onMessage.listeners.length, 1);
  assert.equal(fake.runtime.onInstalled.listeners.length, 1);
  fake.runtime.onInstalled.fire({ reason: "install" });
  await flush();
  const storedSettings = fake.storage.local.data.get(STORAGE_KEYS.SETTINGS);
  assert.deepEqual(storedSettings, mergeSettings(undefined));
  assert.deepEqual(storedSettings, { ...DEFAULT_SETTINGS });
});

test("2. refresh inventory records all tabs and eligibility filters pdf/internal/excluded", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const urls = [
    "https://github.com/facebook/react",
    "https://en.wikipedia.org/wiki/Cat",
    "https://www.nytimes.com/2026/01/01/tech/ai.html",
    "chrome://version/",
    "https://docs.site.test/papers/report.pdf",
    "https://forum.excluded.test/thread/123"
  ];
  const ids = fake.seed(urls.map((url, i) => ({ url, title: `Tab ${i}` })));
  const settingsResp = await ctrl.handleMessage(
    { type: MSG.SET_SETTINGS, patch: { excludedDomains: ["excluded.test"] } },
    {}
  );
  assert.equal(settingsResp.ok, true);
  const resp = await ctrl.handleMessage({ type: MSG.REFRESH_INVENTORY }, {});
  assert.equal(resp.ok, true);
  assert.equal(resp.count, 6);
  const state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  assert.equal(Object.keys(state.tabs).length, 6);
  assert.equal(state.tabs[String(ids[0])].kind, "web");
  assert.equal(state.tabs[String(ids[3])].kind, "internal");
  assert.equal(state.tabs[String(ids[4])].kind, "pdf");
  assert.equal(eligibility(state.tabs[String(ids[0])], state.settings, true), true);
  assert.equal(eligibility(state.tabs[String(ids[1])], state.settings, true), true);
  assert.equal(eligibility(state.tabs[String(ids[2])], state.settings, true), true);
  assert.equal(eligibility(state.tabs[String(ids[3])], state.settings, true), false);
  assert.equal(eligibility(state.tabs[String(ids[4])], state.settings, true), false);
  assert.equal(eligibility(state.tabs[String(ids[5])], state.settings, true), false);
  assert.equal(eligibility(state.tabs[String(ids[0])], state.settings, false), false);
});

test("3. extraction happy path: payload stored, text stripped, summary, tags, duplicates", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const id1 = fake.seed({ url: "https://github.com/x/y", title: "Repo X" });
  const id2 = fake.seed({ url: "https://github.com/x/y", title: "Repo X again" });
  const id3 = fake.seed({ url: "https://developer.zzz.test/docs", title: "Docs" });
  fake.contentResponders[String(id1)] = () => ({
    status: "ok",
    text: SAMPLE_TEXT,
    headings: ["Alpha"],
    description: "x"
  });
  await ctrl.handleMessage({ type: MSG.REQUEST_EXTRACT_ALL }, {});
  await flush();
  timers.advance(LIMITS.EXTRACT_TIMEOUT_MS + 10);
  await flush();
  timers.advance(300);
  await flush();

  const state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  const rec1 = state.tabs[String(id1)];
  const rec2 = state.tabs[String(id2)];
  assert.equal(rec1.extraction.status, "ok");
  assert.ok(!("text" in rec1.extraction));
  assert.equal(typeof rec1.extraction.excerpt, "string");
  assert.ok(rec1.extraction.excerpt.length > 0);
  assert.ok(rec1.extraction.byteLength > 0);
  assert.equal(typeof rec1.summary.abstract, "string");
  assert.ok(rec1.summary.abstract.length > 0);
  assert.ok(["high", "low"].includes(rec1.summary.confidence));
  assert.ok(Array.isArray(rec1.summary.sentences));
  assert.ok(rec1.summary.sentences.every((s) => typeof s === "string"));
  assert.equal(typeof rec1.summary.generatedAt, "number");
  if (LIB_MODE.tagger === "real") {
    assert.ok(rec1.tags.some((t) => t.source === "rule"), `expected rule tag, got ${JSON.stringify(rec1.tags)}`);
  } else {
    assert.ok(rec1.tags.some((t) => t.label === "Development"));
  }
  assert.equal(rec1.duplicateOf, null);
  assert.ok(rec2.duplicateOf != null);
  assert.equal(String(rec2.duplicateOf), String(id1));

  const snapshot = ctrl.getStateSnapshot();
  assert.ok(snapshot.debug.extractionsAttempted >= 3, `attempted ${snapshot.debug.extractionsAttempted} (includes transient retries for tabs without responders)`);
  assert.equal(snapshot.debug.extractionsOk, 1);
  assert.equal(snapshot.quotaPrunedAt, 0);

  const storedTabs = fake.storage.local.data.get(STORAGE_KEYS.TABS);
  assert.ok(!("text" in storedTabs[String(id1)].extraction));
  assert.ok(storedTabs[String(id1)].extraction.excerpt.length > 0);
});

test("4. extraction timeout marks record failed with reason timeout", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const id = fake.seed({ url: "https://slow.site.test/article", title: "Slow" });
  fake.contentResponders[String(id)] = () => new Promise(() => {});
  const resp = await ctrl.handleMessage({ type: MSG.REQUEST_EXTRACT_ALL }, {});
  assert.equal(resp.queued, 1);
  await flush();
  timers.advance(LIMITS.EXTRACT_TIMEOUT_MS);
  await flush();
  timers.advance(300);
  await flush();
  const state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  assert.equal(state.tabs[String(id)].extraction.status, "failed");
  assert.equal(state.tabs[String(id)].extraction.reason, FAILURE_REASONS.TIMEOUT);
});

test("5. worker death: new controller over same storage restores state and alarm still closes", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const id1 = fake.seed({ url: "https://github.com/a/b", title: "AB" });
  const id2 = fake.seed({ url: "https://plain.site.test/page", title: "Plain" });
  const id3 = fake.seed({ url: "https://another.site.test/x", title: "Another" });
  fake.contentResponders[String(id1)] = () => ({
    status: "ok",
    text: SAMPLE_TEXT,
    headings: ["Alpha"],
    description: "x"
  });
  await ctrl.handleMessage({ type: MSG.REQUEST_EXTRACT_ALL }, {});
  await flush();
  timers.advance(LIMITS.EXTRACT_TIMEOUT_MS + 10);
  await flush();

  const sessionResp = await ctrl.handleMessage(
    { type: MSG.SAVE_SESSION, name: "Research", tabIds: [id1, id2] },
    {}
  );
  assert.equal(sessionResp.ok, true);
  const closeResp = await ctrl.handleMessage({ type: MSG.CLOSE_TABS, tabIds: [id2] }, {});
  assert.equal(closeResp.ok, true);
  const removedLabel = firstRuleLabel((await ctrl.handleMessage({ type: MSG.GET_STATE }, {})).tabs[String(id1)]);
  const corrResp = await ctrl.handleMessage(
    { type: MSG.CORRECT_TAGS, tabId: id1, op: "remove", label: removedLabel },
    {}
  );
  assert.equal(corrResp.ok, true);

  timers.advance(400);
  await flush();

  const beforeState = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  const beforeCorrections = structuredClone(ctrl._internals.corrections);
  const storedCorrectionsBefore = structuredClone(fake.storage.local.data.get(STORAGE_KEYS.CORRECTIONS));
  const pendingName = `${STORAGE_KEYS.PENDING_CLOSE}:${closeResp.batchId}`;
  assert.ok(fake.alarms.map.has(pendingName));
  assert.ok(fake.storage.local.data.get(STORAGE_KEYS.PENDING_CLOSE)[closeResp.batchId]);

  const timers2 = makeManualTimers();
  const ctrl2 = createController(createBrowserApi(fake), makeDeps(timers2));
  ctrl2.registerAll();
  const afterState = await ctrl2.handleMessage({ type: MSG.GET_STATE }, {});

  assert.deepEqual(afterState.tabs, beforeState.tabs);
  assert.deepEqual(afterState.settings, beforeState.settings);
  assert.deepEqual(afterState.sessions, beforeState.sessions);
  assert.deepEqual(afterState.pendingClose, beforeState.pendingClose);
  assert.deepEqual(structuredClone(ctrl2._internals.corrections), beforeCorrections);
  assert.deepEqual(structuredClone(fake.storage.local.data.get(STORAGE_KEYS.CORRECTIONS)), storedCorrectionsBefore);

  assert.equal(fake.fireAlarm(pendingName), true);
  await flush();
  timers2.advance(300);
  await flush();

  assert.equal(fake.tabs.tabsMap.has(id2), false);
  assert.equal(fake.tabs.tabsMap.has(id1), true);
  assert.equal(fake.tabs.tabsMap.has(id3), true);
  const pendingAfter = fake.storage.local.data.get(STORAGE_KEYS.PENDING_CLOSE) || {};
  assert.ok(!(closeResp.batchId in pendingAfter));
});

test("6. quota failure triggers prune of oldest 40+ extractions and retry succeeds", async () => {
  const fake = makeFakeChrome({ quotaFailFirst: 1 });
  const pre = {};
  for (let i = 1; i <= 46; i++) {
    const rec = createTabRecord({
      id: i,
      url: `https://site${i}.test/page`,
      title: `Site ${i}`,
      windowId: 1,
      index: i
    });
    const text = "meaningful content word ".repeat(30);
    rec.extraction = {
      status: "ok",
      reason: "",
      text,
      excerpt: text.slice(0, 1200),
      headings: [],
      description: "",
      extractedAt: i * 1000,
      byteLength: text.length
    };
    rec.summary = { abstract: "meaningful", sentences: ["meaningful"], confidence: "low", generatedAt: i * 1000 };
    pre[String(i)] = rec;
  }
  fake.storage.local.data.set(STORAGE_KEYS.TABS, structuredClone(pre));
  for (let i = 1; i <= 46; i++) {
    fake.seed({ id: i, url: `https://site${i}.test/page`, title: `Site ${i}`, windowId: 1, index: i - 1 });
  }

  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  const focusResp = await ctrl.handleMessage({ type: MSG.FOCUS_TAB, tabId: 1 }, {});
  assert.equal(focusResp.ok, true);
  timers.advance(300);
  await flush();

  const snapshot = ctrl.getStateSnapshot();
  assert.ok(snapshot.quotaPrunedAt > 0);
  const stored = fake.storage.local.data.get(STORAGE_KEYS.TABS);
  assert.equal(Object.keys(stored).length, 46);
  const failed = Object.values(stored).filter(
    (r) => r.extraction && r.extraction.status === "failed" && r.extraction.reason === "unknown"
  );
  assert.equal(failed.length, 6);
  for (let i = 1; i <= 6; i++) {
    assert.equal(stored[String(i)].extraction.status, "failed");
    assert.equal(stored[String(i)].summary.abstract, "meaningful");
  }
  assert.equal(stored["46"].extraction.status, "ok");
});

test("7. undo cancel: alarm cleared, entry gone, tabs never removed", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const id1 = fake.seed({ url: "https://a.one.test/1", title: "A1" });
  const id2 = fake.seed({ url: "https://b.two.test/2", title: "B2" });
  const id3 = fake.seed({ url: "https://c.three.test/3", title: "C3" });
  await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  timers.advance(300);
  await flush();

  const closeResp = await ctrl.handleMessage({ type: MSG.CLOSE_TABS, tabIds: [id2] }, {});
  assert.equal(closeResp.ok, true);
  const alarmName = `${STORAGE_KEYS.PENDING_CLOSE}:${closeResp.batchId}`;
  assert.ok(fake.alarms.map.has(alarmName));

  const cancelResp = await ctrl.handleMessage({ type: MSG.CANCEL_CLOSE, batchId: closeResp.batchId }, {});
  assert.equal(cancelResp.ok, true);
  assert.equal(fake.alarms.map.has(alarmName), false);
  const storedPending = fake.storage.local.data.get(STORAGE_KEYS.PENDING_CLOSE) || {};
  assert.ok(!(closeResp.batchId in storedPending));
  assert.equal(fake.callLog.tabsRemove.length, 0);
  assert.equal(fake.tabs.tabsMap.size, 3);
  assert.equal(fake.fireAlarm(alarmName), false);
  assert.equal(fake.tabs.tabsMap.size, 3);
  assert.ok([id1, id2, id3].every((id) => fake.tabs.tabsMap.has(id)));
});

test("8. sessions roundtrip through controller messages", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const id1 = fake.seed({ url: "https://docs.one.test/guide", title: "Guide" });
  const id2 = fake.seed({ url: "https://shop.two.test/item", title: "Item" });
  await ctrl.handleMessage({ type: MSG.GET_STATE }, {});

  const saveResp = await ctrl.handleMessage(
    { type: MSG.SAVE_SESSION, name: "Research", tabIds: [id1, id2], closeAfter: false },
    {}
  );
  assert.equal(saveResp.ok, true);
  let state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].name, "Research");
  assert.deepEqual(
    state.sessions[0].tabs.map((t) => t.url),
    ["https://docs.one.test/guide", "https://shop.two.test/item"]
  );

  const badDelete = await ctrl.handleMessage({ type: MSG.DELETE_SESSION, sessionId: "nope" }, {});
  assert.deepEqual(badDelete, { ok: false, error: "unknown-session" });
  state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  assert.equal(state.sessions.length, 1);

  const invalidJson = await ctrl.handleMessage({ type: MSG.IMPORT_SESSIONS, json: "{oops" }, {});
  assert.deepEqual(invalidJson, { ok: false, error: "invalid-json" });
  const unsupported = await ctrl.handleMessage(
    { type: MSG.IMPORT_SESSIONS, json: JSON.stringify({ version: 9, sessions: [] }) },
    {}
  );
  assert.deepEqual(unsupported, { ok: false, error: "unsupported-format" });

  const importResp = await ctrl.handleMessage(
    {
      type: MSG.IMPORT_SESSIONS,
      json: JSON.stringify({
        version: 1,
        sessions: [
          { id: "imp-1", name: "Imported A", tabs: [{ url: "https://import.a.test/", title: "IA" }] },
          { id: "imp-2", name: "Imported B", tabs: [{ url: "https://import.b.test/", title: "IB" }] }
        ]
      })
    },
    {}
  );
  assert.equal(importResp.ok, true);
  assert.equal(importResp.imported, 2);
  state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  assert.equal(state.sessions.length, 3);

  const delResp = await ctrl.handleMessage(
    { type: MSG.DELETE_SESSION, sessionId: saveResp.sessionId },
    {}
  );
  assert.equal(delResp.ok, true);
  state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  assert.equal(state.sessions.length, 2);
  const restored = await ctrl.handleMessage({ type: MSG.RESTORE_SESSION, sessionId: "imp-1" }, {});
  assert.equal(restored.opened, 1);
});

test("9. rapid tab updates debounce to exactly one storage write for tabs", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const id = fake.seed({ url: "https://debounce.site.test/", title: "Start" });
  await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  timers.advance(300);
  await flush();

  let tabsWrites = 0;
  const local = fake.storage.local;
  const originalSet = local.set.bind(local);
  local.set = async (obj) => {
    if (Object.prototype.hasOwnProperty.call(obj, STORAGE_KEYS.TABS)) tabsWrites++;
    return originalSet(obj);
  };

  for (let i = 0; i < 10; i++) {
    fake.tabs.onUpdated.fire(id, { title: `T ${i}` }, { ...fake.tabs.tabsMap.get(id), title: `T ${i}` });
  }
  timers.advance(300);
  await flush();

  assert.equal(tabsWrites, 1);
  const storedTabs = fake.storage.local.data.get(STORAGE_KEYS.TABS);
  assert.equal(storedTabs[String(id)].title, "T 9");
});

test("10. omnibox suggestions and entered open urls or dashboard", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  fake.seed({ url: "https://github.com/facebook/react", title: "React hooks guide" });
  fake.seed({ url: "https://kitchen.recipes.test/pasta", title: "Cooking pasta" });
  await ctrl.handleMessage({ type: MSG.GET_STATE }, {});

  let suggestions = null;
  await ctrl.handleOmniboxSuggestions("react", (arr) => {
    suggestions = arr;
  });
  assert.ok(Array.isArray(suggestions));
  assert.ok(suggestions.length >= 1);
  assert.equal(suggestions[0].content, "https://github.com/facebook/react");
  assert.ok(suggestions[0].description.includes("React hooks guide"));
  assert.ok(suggestions[0].description.includes("—"));

  await ctrl.handleOmniboxSuggestions("", (arr) => {
    suggestions = arr;
  });
  assert.deepEqual(suggestions, []);

  await ctrl.handleOmniboxEntered("https://example.org/post", { disposition: "newForegroundTab" });
  const openedUrls = [...fake.tabs.tabsMap.values()].map((t) => t.url);
  assert.ok(openedUrls.includes("https://example.org/post"));

  await ctrl.handleOmniboxEntered("hooks docs", { disposition: "newForegroundTab" });
  const dashboardBase = createBrowserApi(fake).runtimeGetURL("src/dashboard/dashboard.html");
  const afterUrls = [...fake.tabs.tabsMap.values()].map((t) => t.url);
  assert.ok(afterUrls.includes(`${dashboardBase}?q=${encodeURIComponent("hooks docs")}`));
});
