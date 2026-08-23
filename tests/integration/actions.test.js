import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeChrome, makeManualTimers } from "../fakes/fakeChrome.js";
import { createBrowserApi } from "../../src/background/browserApi.js";
import { createController } from "../../src/background/controller.js";
import { GROUP_COLORS } from "../../src/background/inventory.js";
import { STORAGE_KEYS, MSG, LIMITS } from "../../src/lib/schema.js";


async function loadReal(mod) {
  try {
    return await import(`../../src/lib/${mod}`);
  } catch {
    return null;
  }
}
const realTagger = await loadReal("tagger.js");
const realSummarizer = await loadReal("summarizer.js");
const realDedupe = await loadReal("dedupe.js");
if (!realTagger || !realSummarizer || !realDedupe) throw new Error("real libs must be present");
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

test("1. GROUP_TABS by domain creates one group per domain with cycling colors", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  fake.seed({ url: "https://portal.a.test/x", title: "A1" });
  fake.seed({ url: "https://portal.a.test/y", title: "A2" });
  fake.seed({ url: "https://news.b.test/n", title: "B" });
  fake.seed({ url: "https://c.test/page", title: "C" });
  await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  await ctrl.handleMessage({ type: MSG.REFRESH_INVENTORY }, {});

  const resp = await ctrl.handleMessage({ type: MSG.GROUP_TABS, by: "domain" }, {});
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.groups, [
    { title: "a.test", size: 2 },
    { title: "b.test", size: 1 },
    { title: "c.test", size: 1 }
  ]);
  assert.equal(fake.callLog.tabsGroup.length, 3);
  const metas = Object.values(fake.groupMeta);
  assert.deepEqual(
    metas.map((m) => m.title),
    ["a.test", "b.test", "c.test"]
  );
  assert.deepEqual(
    metas.map((m) => m.color),
    [GROUP_COLORS[0], GROUP_COLORS[1], GROUP_COLORS[2]]
  );
});

test("2. GROUP_TABS by category buckets extracted tabs by rule tag", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const ghId = fake.seed({ url: "https://github.com/x/y", title: "Repo" });
  const ytId = fake.seed({ url: "https://www.youtube.com/watch?v=abc", title: "Clip" });
  fake.contentResponders[String(ghId)] = () => ({
    status: "ok",
    text: SAMPLE_TEXT,
    headings: ["Alpha"],
    description: "x"
  });
  fake.contentResponders[String(ytId)] = () => ({
    status: "ok",
    text: SAMPLE_TEXT,
    headings: ["Beta"],
    description: "y"
  });
  await ctrl.handleMessage({ type: MSG.REQUEST_EXTRACT_ALL }, {});
  await flush();
  timers.advance(LIMITS.EXTRACT_TIMEOUT_MS + 10);
  await flush();
  timers.advance(300);
  await flush();

  const state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  const ghLabel = firstRuleLabel(state.tabs[String(ghId)]);
  const ytLabel = firstRuleLabel(state.tabs[String(ytId)]);
  assert.notEqual(ghLabel, "");
  assert.notEqual(ytLabel, "");

  const resp = await ctrl.handleMessage({ type: MSG.GROUP_TABS, by: "category" }, {});
  assert.equal(resp.ok, true);
  const titles = resp.groups.map((g) => g.title).sort();
  const expected = [...new Set([ghLabel, ytLabel])].sort();
  assert.deepEqual(titles, expected);
  for (const g of resp.groups) assert.equal(g.size, 1);
  const metas = Object.values(fake.groupMeta);
  assert.deepEqual(
    metas.map((m) => m.color),
    [GROUP_COLORS[0], GROUP_COLORS[1]]
  );
});

test("3. DISCARD_TABS tolerates invalid ids and updates records", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const vid = fake.seed({ url: "https://valid.site.test/1", title: "V" });
  fake.seed({ url: "https://other.site.test/2", title: "O" });
  await ctrl.handleMessage({ type: MSG.GET_STATE }, {});

  const resp = await ctrl.handleMessage({ type: MSG.DISCARD_TABS, tabIds: [vid, 99999] }, {});
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.discarded, [vid]);
  assert.deepEqual(resp.errored, [99999]);
  assert.equal(fake.tabs.tabsMap.get(vid).discarded, true);
  const state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  assert.equal(state.tabs[String(vid)].discarded, true);
});

test("4. FOCUS_TAB activates the tab and focuses its window", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const id = fake.seed({ url: "https://focus.site.test/1", title: "F", windowId: 7 });
  await ctrl.handleMessage({ type: MSG.GET_STATE }, {});

  const resp = await ctrl.handleMessage({ type: MSG.FOCUS_TAB, tabId: id }, {});
  assert.equal(resp.ok, true);
  assert.deepEqual(fake.callLog.tabsUpdate, [[id, { active: true }]]);
  assert.equal(fake.windowsStore[7].focused, true);
});

test("5. duplicate close flow: alarm fires and removes only the duplicate", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const id1 = fake.seed({ url: "https://dupe.site.test/article", title: "D1" });
  const id2 = fake.seed({ url: "https://dupe.site.test/article", title: "D1 copy" });
  await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  await ctrl.handleMessage({ type: MSG.REFRESH_INVENTORY }, {});
  timers.advance(300);
  await flush();

  let state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  const dupRecord = state.tabs[String(id2)];
  assert.ok(dupRecord.duplicateOf != null, "expected duplicate to be marked");
  assert.equal(state.tabs[String(id1)].duplicateOf, null);

  const closeResp = await ctrl.handleMessage({ type: MSG.CLOSE_TABS, tabIds: [id2] }, {});
  assert.equal(closeResp.ok, true);
  const alarmName = `${STORAGE_KEYS.PENDING_CLOSE}:${closeResp.batchId}`;
  assert.ok(fake.alarms.map.has(alarmName));

  assert.equal(fake.fireAlarm(alarmName), true);
  await flush();
  timers.advance(300);
  await flush();

  assert.equal(fake.tabs.tabsMap.has(id2), false);
  assert.equal(fake.tabs.tabsMap.has(id1), true);
  const storedPending = fake.storage.local.data.get(STORAGE_KEYS.PENDING_CLOSE) || {};
  assert.ok(!(closeResp.batchId in storedPending));
});

test("6. CORRECT_TAGS remove round-trip persists and recategorization respects it", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();
  const ghId = fake.seed({ url: "https://github.com/x/y", title: "Repo" });
  fake.contentResponders[String(ghId)] = () => ({
    status: "ok",
    text: SAMPLE_TEXT,
    headings: ["Alpha"],
    description: "x"
  });
  await ctrl.handleMessage({ type: MSG.REQUEST_EXTRACT_ALL }, {});
  await flush();
  timers.advance(300);
  await flush();

  let state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  assert.ok(state.tabs[String(ghId)].tags.some((t) => t.label === "Development"));

  const corrResp = await ctrl.handleMessage(
    { type: MSG.CORRECT_TAGS, tabId: ghId, op: "remove", label: "Development" },
    {}
  );
  assert.equal(corrResp.ok, true);
  state = await ctrl.handleMessage({ type: MSG.GET_STATE }, {});
  assert.ok(!state.tabs[String(ghId)].tags.some((t) => t.label === "Development"));
  const storedCorrections = fake.storage.local.data.get(STORAGE_KEYS.CORRECTIONS);
  assert.ok(Number(storedCorrections.removed.Development) >= 1);

  const timers2 = makeManualTimers();
  const ctrl2 = createController(createBrowserApi(fake), makeDeps(timers2));
  ctrl2.registerAll();
  await ctrl2.handleMessage({ type: MSG.GET_STATE }, {});
  assert.ok(Number(ctrl2._internals.corrections.removed.Development) >= 1);

  const excludeOn = await ctrl2.handleMessage(
    { type: MSG.SET_EXCLUDED_DOMAIN, domain: "github.com", enabled: true },
    {}
  );
  assert.equal(excludeOn.ok, true);
  let state2 = await ctrl2.handleMessage({ type: MSG.GET_STATE }, {});
  assert.equal(state2.tabs[String(ghId)].extraction, null);
  assert.equal(state2.tabs[String(ghId)].summary, null);

  const excludeOff = await ctrl2.handleMessage(
    { type: MSG.SET_EXCLUDED_DOMAIN, domain: "github.com", enabled: false },
    {}
  );
  assert.equal(excludeOff.ok, true);

  const extractResp = await ctrl2.handleMessage({ type: MSG.REQUEST_EXTRACT_ALL }, {});
  assert.equal(extractResp.queued, 1);
  await flush();
  timers2.advance(LIMITS.EXTRACT_TIMEOUT_MS + 10);
  await flush();
  timers2.advance(300);
  await flush();

  state2 = await ctrl2.handleMessage({ type: MSG.GET_STATE }, {});
  const labels = state2.tabs[String(ghId)].tags.map((t) => t.label);
  assert.ok(!labels.includes("Development"));
  const finalCorrections = structuredClone(fake.storage.local.data.get(STORAGE_KEYS.CORRECTIONS));
  assert.ok(Number(finalCorrections.removed.Development) >= 1);
  assert.deepEqual(finalCorrections.added, {});
});