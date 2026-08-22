import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../../src/content/extractor.js", import.meta.url), "utf8");
const context = vm.createContext({ module: { exports: {} }, chrome: undefined, document: undefined, console });
vm.runInContext(source, context, { filename: "extractor.js" });
const api = context.module.exports;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function loadFixture(name) {
  const html = readFileSync(new URL(`../fixtures/html/${name}`, import.meta.url), "utf8");
  return new JSDOM(html, { url: `https://example.test/${name}` }).window.document;
}

test("extractor exposes its public surface", () => {
  assert.equal(typeof api.classifySkip, "function");
  assert.equal(typeof api.extractFromDom, "function");
  assert.equal(context.TabsurveyExtractor, api);
});

test("classifySkip routes unreadable destinations", () => {
  const table = [
    ["chrome://settings", "internal"],
    ["edge://version", "internal"],
    ["about:blank", "internal"],
    ["chrome-extension://abc/popup.html", "internal"],
    ["view-source:https://x.test/a", "internal"],
    ["file:///x.txt", "file"],
    ["https://x.test/y.pdf", "pdf"],
    ["https://x.test/deep/report.PDF", "pdf"],
    ["https://x.test/page?download=a.PDF", "pdf"],
    ["https://x.test/page?download=a.pdf&x=1", "pdf"],
    ["https://x.test/page", null],
    ["https://x.test/page?q=notes.txt", null],
    ["::::", "internal"],
    ["not a url %%%", "internal"],
    ["", "internal"],
    [null, "internal"]
  ];
  for (const [input, expected] of table) {
    assert.equal(api.classifySkip(input), expected, `classifySkip(${JSON.stringify(input)})`);
  }
});

const EXPECTED = {
  "article-clean.html": {
    status: "ok",
    include: ["quantum barnacle drift", "seawater batteries", "slack water"],
    exclude: ["COOKIE PREFS", "RELATED ARTICLES", "ALL RIGHTS RESERVED", "SUBSCRIBE NOW", "analytics-placeholder"],
    heading: "Grid Storage Below The Surface",
    description: "quantum barnacle drift"
  },
  "article-noisy.html": {
    status: "ok",
    include: ["mirage calendar", "boundary layer", "flat-shimmer window"],
    exclude: ["ADVERTISEMENT", "SOCIAL LINKS", "COOKIE PREFS", "RELATED ARTICLES", "ALL RIGHTS RESERVED", "DUNE for a free lens cloth"],
    heading: "Reading The Horizon Clock",
    description: "mirage calendar"
  },
  "spa-shell.html": { status: "failed", reason: "too-little-text" },
  "image-only.html": { status: "failed", reason: "image-only" },
  "paywall-stub.html": { status: "failed", reason: "paywall-stub" },
  "minimal-text.html": { status: "failed", reason: "too-little-text" },
  "hostile-markup.html": {
    status: "ok",
    include: ["harbor bazaar", "Spice Row", "rope sellers"],
    exclude: [],
    heading: "Ledgers And Loud Voices"
  },
  "interview.html": {
    status: "ok",
    include: ["salt marsh", "glasswing ferry", "Marta Vell"],
    exclude: [],
    heading: "Marta Vell",
    description: "oral history"
  }
};

for (const [name, exp] of Object.entries(EXPECTED)) {
  test(`fixture ${name} extracts with ${exp.status === "ok" ? "status ok" : exp.reason}`, () => {
    const doc = loadFixture(name);
    let result;
    assert.doesNotThrow(() => {
      result = api.extractFromDom(doc);
    });
    assert.equal(result.status, exp.status);
    if (exp.status === "failed") {
      assert.equal(result.reason, exp.reason);
      assert.equal(result.text, undefined);
      assert.deepEqual(Object.keys(result).sort(), ["reason", "status"]);
      return;
    }
    assert.ok(typeof result.text === "string");
    for (const marker of exp.include) {
      assert.ok(result.text.includes(marker), `text missing marker: ${marker}`);
    }
    for (const marker of exp.exclude) {
      assert.ok(!result.text.includes(marker), `text leaked marker: ${marker}`);
    }
    const charCount = Array.from(result.text).length;
    assert.ok(charCount >= 280, `expected at least 280 chars, got ${charCount}`);
    assert.ok(charCount <= 20000, `expected at most 20000 chars, got ${charCount}`);
    assert.ok(Array.isArray(result.headings));
    assert.ok(result.headings.length <= 12);
    if (exp.heading) {
      assert.ok(result.headings.includes(exp.heading), `headings missing: ${exp.heading} (got ${JSON.stringify(result.headings)})`);
    }
    if (exp.description) {
      assert.ok(result.description.includes(exp.description), `description missing: ${exp.description}`);
      assert.ok(Array.from(result.description).length <= 300);
    }
    assert.equal(typeof result.title, "string");
    assert.ok(Array.from(result.title).length <= 300);
    assert.equal(result.url, `https://example.test/${name}`);
  });
}

test("extraction is deterministic across repeated runs", () => {
  for (const name of ["article-clean.html", "article-noisy.html", "hostile-markup.html", "interview.html"]) {
    const doc = loadFixture(name);
    const first = api.extractFromDom(doc);
    const second = api.extractFromDom(doc);
    assert.deepStrictEqual(first, second, name);
  }
});

test("hostile markup never leaks scripts or control characters", () => {
  const doc = loadFixture("hostile-markup.html");
  let result;
  assert.doesNotThrow(() => {
    result = api.extractFromDom(doc);
  });
  assert.equal(result.status, "ok");
  assert.ok(!CONTROL_RE.test(result.text), "control character found in text");
  for (const heading of result.headings) {
    assert.ok(!CONTROL_RE.test(heading), `control character in heading: ${heading}`);
  }
  assert.ok(!result.text.includes("alert(1)"), "attribute payload alert(1) leaked into text");
  assert.ok(!result.text.includes("alert(2)"), "attribute payload alert(2) leaked into text");
  assert.ok(!result.text.includes("<script"), "raw script tag leaked into text");
});

test("extractFromDom leaves the source document untouched", () => {
  for (const name of ["article-clean.html", "article-noisy.html", "hostile-markup.html", "paywall-stub.html"]) {
    const doc = loadFixture(name);
    const before = doc.body.innerHTML;
    api.extractFromDom(doc);
    assert.strictEqual(doc.body.innerHTML, before, `${name} body mutated`);
  }
});
