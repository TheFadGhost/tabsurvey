import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeChrome, makeManualTimers } from "../fakes/fakeChrome.js";
import { createBrowserApi } from "../../src/background/browserApi.js";
import { createController } from "../../src/background/controller.js";
import { summarize } from "../../src/lib/summarizer.js";
import {
  categorize,
  buildDefaultRules,
  buildDefaultCorrections,
  applyCorrection
} from "../../src/lib/tagger.js";
import { markDuplicates } from "../../src/lib/dedupe.js";
import { MSG, STORAGE_KEYS } from "../../src/lib/schema.js";

const SAMPLE_TEXT =
  "Kubernetes operators encode operational knowledge into reusable controllers. ".repeat(10) +
  "This guide walks through packaging a controller, publishing it, and rolling it out safely across clusters.";

function makeDeps(timers) {
  return {
    summarize,
    categorize,
    buildRules: buildDefaultRules,
    buildCorrections: buildDefaultCorrections,
    applyCorrection,
    markDuplicates,
    timers
  };
}

async function drain(turns = 30) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

test("dashboard-style string tab ids work end-to-end through every mutating message", async () => {
  const fake = makeFakeChrome();
  const timers = makeManualTimers();
  const ctrl = createController(createBrowserApi(fake), makeDeps(timers));
  ctrl.registerAll();

  const n1 = fake.seed({ url: "https://github.com/a/b", title: "Repo" });
  const n2 = fake.seed({ url: "https://github.com/a/b?utm_source=x#frag", title: "Repo copy" });
  const n3 = fake.seed({ url: "https://news.ycombinator.com/item?id=9", title: "HN item" });
  const s1 = String(n1);
  const s2 = String(n2);
  const s3 = String(n3);
  fake.contentResponders[String(n1)] = () => ({ status: "ok", text: SAMPLE_TEXT, headings: ["Guide"], description: "d" });

  await ctrl.handleMessage({ type: MSG.GET_STATE, tabId: undefined }, {});
  const extracted = await ctrl.handleMessage({ type: MSG.CLOSE_TABS, tabIds: [] }, {});

  void extracted;
  await ctrl.handleMessage(
    { type: MSG.SAVE_SESSION, name: "S", tabIds: [s1, s2], closeAfter: false },
    {}
  );

  const focusRes = await ctrl.handleMessage({ type: MSG.FOCUS_TAB, tabId: s1 }, {});
  assert.equal(focusRes.ok, true);

  const corr = await ctrl.handleMessage(
    { type: MSG.CORRECT_TAGS, tabId: s1, op: "remove", label: "Development" },
    {}
  );
  assert.equal(corr.ok, true);

  await drain();
  timers.advance(400);
  await drain();

  const groupRes = await ctrl.handleMessage({ type: MSG.GROUP_TABS, by: "domain", tabIds: [s1, s2, s3] }, {});
  assert.equal(groupRes.ok, true);
  assert.equal(groupRes.groups.length >= 1, true);
  for (const info of fake.callLog.tabsGroup || []) {
    for (const id of info.tabIds) {
      assert.equal(typeof id, "number", `tabs.group received non-number id ${typeof id}`);
    }
  }

  const discardRes = await ctrl.handleMessage({ type: MSG.DISCARD_TABS, tabIds: [s2, s3] }, {});
  assert.equal(discardRes.ok !== false, true);
  for (const id of discardRes.discarded) assert.equal(typeof id, "number");

  const closeRes = await ctrl.handleMessage({ type: MSG.CLOSE_TABS, tabIds: [s2] }, {});
  assert.equal(closeRes.ok, true);
  const pendingName = `${STORAGE_KEYS.PENDING_CLOSE}:${closeRes.batchId}`;
  assert.ok(fake.alarms.map.has(pendingName));

  const storedBatch = fake.storage.local.data.get(STORAGE_KEYS.PENDING_CLOSE)[closeRes.batchId];
  for (const id of storedBatch.tabIds) {
    assert.equal(typeof id, "number", `pendingClose stored non-number id ${typeof id}`);
  }

  assert.equal(fake.fireAlarm(pendingName), true);
  await drain();
  timers.advance(300);
  await drain();

  assert.equal(fake.tabs.tabsMap.has(n2), false, "string-id batch must still close the real numeric tab");
  assert.equal(fake.tabs.tabsMap.has(n1), true);
});
