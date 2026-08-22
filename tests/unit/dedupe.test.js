import { test } from "node:test";
import assert from "node:assert/strict";
import { createTabRecord } from "../../src/lib/schema.js";
import { markDuplicates, duplicateSets } from "../../src/lib/dedupe.js";

function tab(id, url, extra = {}) {
  return { ...createTabRecord({ id, url }), ...extra };
}

test("tracking-param variants normalize to duplicates, distinct id stays separate", () => {
  const a = tab(1, "https://shop.example.com/item?id=5");
  const b = tab(2, "https://shop.example.com/item?id=5&utm_source=news&fbclid=zz");
  const c = tab(3, "https://shop.example.com/item?id=7");
  assert.equal(markDuplicates([a, b, c]), 1);
  assert.equal(a.duplicateOf, null);
  assert.equal(b.duplicateOf, 1);
  assert.equal(c.duplicateOf, null);
});

test("fragment variants are duplicates; trailing slash variants are duplicates", () => {
  const f1 = tab(10, "https://docs.example.com/start#intro");
  const f2 = tab(11, "https://docs.example.com/start#api");
  assert.equal(markDuplicates([f1, f2]), 1);
  assert.equal(f2.duplicateOf, 10);

  const s1 = tab(20, "https://blog.example.com/posts");
  const s2 = tab(21, "https://blog.example.com/posts/");
  assert.equal(markDuplicates([s1, s2]), 1);

  const root1 = tab(30, "https://blog.example.com/");
  const root2 = tab(31, "https://blog.example.com");
  assert.equal(markDuplicates([root1, root2]), 1);
});

test("host case is normalized but scheme difference is NOT a duplicate", () => {
  const g1 = tab(40, "http://GitHub.com/x");
  const g2 = tab(41, "http://github.com/x");
  assert.equal(g1.normalizedUrl, g2.normalizedUrl);
  assert.equal(markDuplicates([g1, g2]), 1);
  assert.equal(g2.duplicateOf, 40);

  const sc1 = tab(50, "http://secure.example.com/p");
  const sc2 = tab(51, "https://secure.example.com/p");
  assert.notEqual(sc1.normalizedUrl, sc2.normalizedUrl);
  assert.equal(markDuplicates([sc1, sc2]), 0);
  assert.equal(sc1.duplicateOf, null);
  assert.equal(sc2.duplicateOf, null);
});

test("cross-window identical urls group with lowest numeric id as primary", () => {
  const w1 = tab(42, "https://same.example.com/dup", { windowId: 1 });
  const w2 = tab(7, "https://same.example.com/dup", { windowId: 2 });
  const w3 = tab(100, "https://same.example.com/dup", { windowId: 3 });
  assert.equal(markDuplicates([w1, w2, w3]), 2);
  assert.equal(w1.duplicateOf, 7);
  assert.equal(w2.duplicateOf, null);
  assert.equal(w3.duplicateOf, 7);
});

test("internal and invalid records are never grouped even with non-empty normalizedUrl", () => {
  const garbage = tab(60, "this is not a url");
  assert.equal(garbage.kind, "invalid");
  assert.ok(garbage.normalizedUrl.length > 0);
  const chromeA = tab(61, "chrome://settings");
  const chromeB = tab(62, "chrome://settings/");
  const emptyUrl = tab(63, "");
  assert.equal(chromeA.kind, "internal");
  assert.equal(emptyUrl.normalizedUrl, "");
  assert.equal(markDuplicates([garbage, chromeA, chromeB, emptyUrl]), 0);
  for (const r of [garbage, chromeA, chromeB, emptyUrl]) assert.equal(r.duplicateOf, null);
});

test("mixed set returns exact duplicate count", () => {
  const recs = [
    tab(1, "https://a.example.com/page?utm_campaign=x"),
    tab(2, "https://a.example.com/page"),
    tab(3, "https://b.example.com/one#top"),
    tab(4, "https://b.example.com/one"),
    tab(5, "https://b.example.com/one#other"),
    tab(6, "https://c.example.com/solo")
  ];
  assert.equal(markDuplicates(recs), 3);
  assert.deepEqual(
    recs.map((r) => r.duplicateOf),
    [null, 1, null, 3, 3, null]
  );
});

test("duplicateSets returns sorted sets with primary first and does not mutate", () => {
  const recs = [
    tab(42, "https://dup.example.org/a"),
    tab(7, "https://dup.example.org/a"),
    tab(100, "https://dup.example.org/a"),
    tab(5, "https://solo.example.org/b")
  ];
  const sets = duplicateSets(recs);
  assert.deepEqual(sets, [{ primaryId: 7, ids: [7, 42, 100] }]);
  for (const r of recs) assert.equal(r.duplicateOf, null);

  const multi = [
    tab(9, "https://x.example.com/1"),
    tab(8, "https://x.example.com/1"),
    tab(30, "https://y.example.com/2"),
    tab(20, "https://y.example.com/2")
  ];
  const sets2 = duplicateSets(multi);
  assert.deepEqual(sets2, [
    { primaryId: 8, ids: [8, 9] },
    { primaryId: 20, ids: [20, 30] }
  ]);
});

test("rerun clears stale marks when a member is removed", () => {
  const a = tab(1, "https://rerun.example.com/z");
  const b = tab(2, "https://rerun.example.com/z");
  const c = tab(3, "https://rerun.example.com/z");
  assert.equal(markDuplicates([a, b, c]), 2);
  assert.equal(a.duplicateOf, null);
  assert.equal(b.duplicateOf, 1);
  assert.equal(c.duplicateOf, 1);

  assert.equal(markDuplicates([b, c]), 1);
  assert.equal(b.duplicateOf, null);
  assert.equal(c.duplicateOf, 2);

  assert.equal(markDuplicates([c]), 0);
  assert.equal(c.duplicateOf, null);
});
