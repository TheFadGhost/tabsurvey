import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeChrome, makeManualTimers } from "../fakes/fakeChrome.js";
import { createBrowserApi } from "../../src/background/browserApi.js";
import { createController } from "../../src/background/controller.js";
import { GROUP_COLORS } from "../../src/background/inventory.js";
import { STORAGE_KEYS, MSG, LIMITS } from "../../src/lib/schema.js";

let realTagger = null;
try {
  realTagger = await import("../../src/lib/tagger.js");
} catch {
  realTagger = null;
}
let realSummarizer = null;
try {
  realSummarizer = await import("../../src/lib/summarizer.js");
} catch {
  realSummarizer = null;
}

const LIB_MODE = { tagger: realTagger ? "real" : "stub" };
console.log(`[actions] lib mode: ${JSON.stringify(LIB_MODE)}`);

const STUB_RULES = [
  { label: "Development", domains: ["github.com", "gitlab.com", "stackoverflow.com"] },
  { label: "Video", domains: ["youtube.com", "vimeo.com", "netflix.com"] }
];

function normalizeStubCorrections(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      added: Array.isArray(value.added) ? [...value.added] : [],
      removed: Array.isArray(value.removed) ? [...value.removed] : []
    };
  }
  return { added: [], removed: [] };
}

function stubSummarize(doc, opts) {
  const length = opts && opts.length ? opts.length : "medium";
  const count = { short: 2, medium: 3, long: 4 }[length] || 3;
  const sentences = String(doc.text || "")
    .split(/(?<=[.!?])\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, count)
    .map((t, i) => ({ text: t, score: 1 / (i + 1) }));
  let abstract = sentences.map((s) => s.text).join(" ");
  if (abstract.length > 320) abstract = abstract.slice(0, 320);
  return { abstract, sentences, confidence: String(doc.text || "").length > 500 ? "high" : "low" };
}

function stubCategorize(record, ctx) {
  const corr = normalizeStubCorrections(ctx && ctx.corrections);
  const rules = ctx && Array.isArray(ctx.rules) && ctx.rules.length > 0 ? ctx.rules : STUB_RULES;
  const tags = [];
  for (const rule of rules) {
    if (!rule || typeof rule.label !== "string") continue;
    if (corr.removed.includes(rule.label)) continue;
    if (record.domain && Array.isArray(rule.domains) && rule.domains.includes(record.domain)) {
      tags.push({
        id: `rule-${rule.label.toLowerCase()}`,
        label: rule.label,
        source: "rule",
        reason: `domain:${record.domain}`
      });
    }
  }
  if (tags.length === 0 && !corr.removed.includes("Other")) {
    tags.push({ id: "rule-other", label: "Other", source: "rule", reason: "fallback" });
  }
  for (const label of corr.added) {
    tags.push({ id: `user-${label.toLowerCase()}`, label, source: "user", reason: "manual-correction" });
  }
  return tags;
}

function stubApplyCorrection(tags, correction, correctionsValue) {
  const corr = normalizeStubCorrections(correctionsValue);
  const label = correction && typeof correction.label === "string" ? correction.label : "";
  if (!label) return { tags: [...tags], corrections: corr };
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
      { id: `user-${label.toLowerCase()}`, label, source: "user", reason: "manual-correction" }
    ],
    corrections: corr
  };
}

function stubMarkDuplicates(records) {
  let marked = 0;
  const byUrl = new Map();
  for (const record of records) {
    const key = record.normalizedUrl || record.url;
    if (byUrl.has(key)) {
      record.duplicateOf = byUrl.get(key);
      marked++;
    } else {
      byUrl.set(key, String(record.id));
    }
  }
  return marked;
}

function makeDeps(timers, overrides = {}) {
  return {
    summarize: realSummarizer ? realSummarizer.summarize : stubSummarize,
    categorize: realTagger ? realTagger.categorize : stubCategorize,
    buildRules: realTagger ? realTagger.buildDefaultRules : () => STUB_RULES,
    buildCorrections: realTagger ? realTagger.buildDefaultCorrections : () => ({ added: [], removed: [] }),
    applyCorrection: realTagger && realTagger.applyCorrection ? realTagger.applyCorrection : stubApplyCorrection,
    markDuplicates: stubMarkDuplicates,
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
  const deps = { ...makeDeps(timers) };
  deps.categorize = stubCategorize;
  deps.buildRules = () => STUB_RULES;
  deps.buildCorrections = () => ({ added: [], removed: [] });
  deps.applyCorrection = stubApplyCorrection;
  const ctrl = createController(createBrowserApi(fake), deps);
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
  assert.ok(storedCorrections.removed.includes("Development"));

  const timers2 = makeManualTimers();
  const deps2 = {
    summarize: stubSummarize,
    categorize: stubCategorize,
    buildRules: () => STUB_RULES,
    buildCorrections: () => ({ added: [], removed: [] }),
    applyCorrection: stubApplyCorrection,
    markDuplicates: stubMarkDuplicates,
    timers: timers2
  };
  const ctrl2 = createController(createBrowserApi(fake), deps2);
  ctrl2.registerAll();
  await ctrl2.handleMessage({ type: MSG.GET_STATE }, {});
  assert.ok(ctrl2._internals.corrections.removed.includes("Development"));

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
  assert.deepEqual(structuredClone(fake.storage.local.data.get(STORAGE_KEYS.CORRECTIONS)), {
    added: [],
    removed: ["Development"]
  });
});
