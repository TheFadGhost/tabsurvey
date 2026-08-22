import { test } from "node:test";
import assert from "node:assert/strict";
import { search } from "../../src/lib/searchIndex.js";

function rec(overrides = {}) {
  return {
    id: 1,
    url: "",
    normalizedUrl: "",
    domain: "",
    title: "",
    kind: "web",
    windowId: -1,
    groupId: null,
    pinned: false,
    audible: false,
    discarded: false,
    lastAccessed: 0,
    duplicateOf: null,
    extraction: null,
    summary: null,
    tags: [],
    ...overrides
  };
}

function excerptRec(id, excerpt, extra = {}) {
  return rec({
    id,
    extraction: { status: "ok", reason: "", excerpt, headings: [], description: "", extractedAt: 0 },
    ...extra
  });
}

test("empty and whitespace queries pass through all records in original order with identity", () => {
  const a = rec({ id: 3, title: "Alpha" });
  const b = rec({ id: 1, title: "Beta" });
  const c = rec({ id: 2, title: "Gamma" });
  for (const q of ["", "   ", "\t\n", null]) {
    const out = search([a, b, c], q);
    assert.equal(out.length, 3);
    assert.ok(out[0] === a && out[1] === b && out[2] === c);
    assert.deepEqual(out, [a, b, c]);
  }
});

test("single token: title prefix hit ranks above excerpt-only hit", () => {
  const t = rec({ id: 1, title: "Kubernetes Basics Guide", lastAccessed: 100 });
  const e = excerptRec(2, "kubernetes cluster notes", { title: "Unrelated", lastAccessed: 500 });
  const out = search([e, t], "kube");
  assert.deepEqual(out, [t, e]);
  assert.ok(out[0] === t);
});

test("multi-token AND excludes partial matches", () => {
  const both = rec({ id: 1, title: "React hooks tutorial" });
  const partial = rec({ id: 2, title: "React guide" });
  const out = search([partial, both], "react hooks");
  assert.equal(out.length, 1);
  assert.ok(out[0] === both);
});

test("tag exact match beats generic field hit", () => {
  const tagged = rec({
    id: 1,
    title: "Some article",
    tags: [{ id: "t1", label: "Development", source: "rule", reason: "domain" }]
  });
  const generic = excerptRec(2, "development of the feature", { title: "Weekly digest" });
  const out = search([generic, tagged], "development");
  assert.ok(out[0] === tagged);
  assert.deepEqual(out, [tagged, generic]);
});

test("unicode titles are searchable through ascii substrings in both directions", () => {
  const u = rec({ id: 1, title: "Überflieger Strategien für Teams" });
  const plain = rec({ id: 2, title: "Totally different" });
  let out = search([plain, u], "berflieg");
  assert.equal(out.length, 1);
  assert.ok(out[0] === u);
  out = search([plain, u], "überflieger");
  assert.equal(out.length, 1);
  assert.ok(out[0] === u);
});

test("search is deterministic across repeated runs including object identity", () => {
  const records = [
    excerptRec(4, "zephyr project notes"),
    rec({ id: 9, title: "Zephyr docs", domain: "docs.example.com" }),
    rec({ id: 2, title: "Random page", url: "https://x.example.com/zephyr" }),
    excerptRec(7, "nothing here")
  ];
  const r1 = search(records, "zephyr");
  const r2 = search(records, "zephyr");
  assert.deepEqual(r1, r2);
  assert.equal(r1.length, r2.length);
  r1.forEach((r, i) => assert.ok(r === r2[i]));
  assert.ok(r1.every((r) => records.includes(r)));
});

test("weights sanity: title match outranks abstract-only match", () => {
  const a = rec({
    id: 1,
    title: "Quarterly report",
    summary: { abstract: "mentions zanzibar twice", sentences: [], confidence: "high" }
  });
  const b = rec({ id: 2, title: "Zanzibar travel guide" });
  const out = search([a, b], "zanzibar");
  assert.deepEqual(out, [b, a]);
});

test("AND works across different fields (title + tag)", () => {
  const f = rec({
    id: 1,
    title: "Invoice portal",
    tags: [{ id: "t", label: "Finance", source: "rule", reason: "url" }]
  });
  assert.deepEqual(search([f], "invoice finance"), [f]);
  assert.deepEqual(search([f], "invoice nomatch"), []);
  assert.deepEqual(search([f], "zzzznothing"), []);
});

test("tie-breaks: lastAccessed desc, then title localeCompare, then id asc", () => {
  const x = rec({ id: 1, title: "Same Title", lastAccessed: 200 });
  const y = rec({ id: 2, title: "Same Title", lastAccessed: 100 });
  let out = search([y, x], "same");
  assert.ok(out[0] === x && out[1] === y);

  const p = rec({ id: 9, title: "Aardvark Facts", lastAccessed: 50 });
  const q = rec({ id: 8, title: "Beta Facts", lastAccessed: 50 });
  out = search([q, p], "facts");
  assert.ok(out[0] === p && out[1] === q);

  const m = rec({ id: 12, title: "Dup Title", lastAccessed: 50 });
  const n = rec({ id: 5, title: "Dup Title", lastAccessed: 50 });
  out = search([m, n], "dup");
  assert.ok(out[0] === n && out[1] === m);
});
