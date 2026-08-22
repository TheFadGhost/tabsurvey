import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../../src/lib/summarizer.js";
import { tokenize } from "../../src/lib/textUtils.js";

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "corpus");

function loadFixtures() {
  const files = readdirSync(corpusDir).filter((f) => f.endsWith(".json"));
  const byId = new Map();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(corpusDir, file), "utf8"));
    byId.set(raw.id, raw);
  }
  return byId;
}

const fixtures = loadFixtures();

function toDoc(fixture) {
  return {
    title: fixture.title,
    headings: fixture.headings,
    text: fixture.text
  };
}

function termBag(tokens) {
  const bag = new Map();
  for (const token of tokens) bag.set(token, (bag.get(token) || 0) + 1);
  return bag;
}

function unigramF1(hypothesisTokens, referenceTokens) {
  const hyp = termBag(hypothesisTokens);
  const ref = termBag(referenceTokens);
  let matches = 0;
  let hypTotal = 0;
  let refTotal = 0;
  for (const count of hyp.values()) hypTotal += count;
  for (const [token, count] of ref) {
    refTotal += count;
    matches += Math.min(hyp.get(token) || 0, count);
  }
  if (hypTotal === 0 || refTotal === 0) return 0;
  const precision = matches / hypTotal;
  const recall = matches / refTotal;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

test("summarize is deterministic across repeated runs for every fixture", () => {
  assert.ok(fixtures.size >= 6);
  for (const [id, fixture] of fixtures) {
    const first = summarize(toDoc(fixture));
    const second = summarize(toDoc(fixture));
    assert.deepStrictEqual(first, second, `nondeterministic output for ${id}`);
  }
});

test("unigram F1 vs reference clears floors on substantive fixtures", () => {
  const substantive = ["news-energy", "howto-podcast", "release-notes", "product-blender", "long-policy"];
  const scores = [];
  for (const id of substantive) {
    const fixture = fixtures.get(id);
    assert.ok(fixture, `missing fixture ${id}`);
    const result = summarize(toDoc(fixture), { length: "medium" });
    assert.ok(result, `expected summary for ${id}`);
    const f1 = unigramF1(tokenize(result.abstract), tokenize(fixture.reference));
    scores.push({ id, f1 });
    assert.ok(
      f1 >= 0.18,
      `fixture ${id} F1 ${f1.toFixed(3)} below individual floor 0.18; abstract: ${result.abstract}`
    );
  }
  const mean = scores.reduce((acc, s) => acc + s.f1, 0) / scores.length;
  assert.ok(mean >= 0.30, `mean F1 ${mean.toFixed(3)} below floor 0.30: ${JSON.stringify(scores.map((s) => ({ id: s.id, f1: Number(s.f1.toFixed(3)) })))}`);
});

test("meeting-short yields null or low confidence without throwing", () => {
  const fixture = fixtures.get("meeting-short");
  const result = summarize(toDoc(fixture));
  if (result !== null) {
    assert.equal(result.confidence, "low");
  }
});

test("empty and whitespace-only text returns null", () => {
  assert.equal(summarize({ title: "", headings: [], text: "" }), null);
  assert.equal(summarize({ title: "", headings: [], text: "   \n\t  \n " }), null);
  assert.equal(summarize(null), null);
});

test("short length produces a shorter abstract than long length", () => {
  const doc = toDoc(fixtures.get("long-policy"));
  const short = summarize(doc, { length: "short" });
  const long = summarize(doc, { length: "long" });
  assert.ok(short, "short summary missing");
  assert.ok(long, "long summary missing");
  assert.ok(short.abstract.length < long.abstract.length);
});

test("abstract preserves original sentence order", () => {
  const fixture = fixtures.get("long-policy");
  const doc = toDoc(fixture);
  const result = summarize(doc, { length: "medium" });
  const positions = result.sentences.map((s) => doc.text.indexOf(s.text));
  for (let i = 0; i < positions.length; i += 1) {
    assert.ok(positions[i] >= 0, `sentence not found in source at ${i}`);
    if (i > 0) {
      assert.ok(positions[i] > positions[i - 1], "selected sentences out of original order");
    }
  }
});

test("all sentence scores are finite non-NaN numbers", () => {
  for (const [id, fixture] of fixtures) {
    const result = summarize(toDoc(fixture), { length: "long" });
    if (!result) continue;
    for (const s of result.sentences) {
      assert.equal(typeof s.score, "number", `${id} score not a number`);
      assert.ok(Number.isFinite(s.score), `${id} score not finite`);
      assert.ok(!Number.isNaN(s.score), `${id} score is NaN`);
      assert.equal(typeof s.text, "string");
      assert.ok(s.text.length > 0);
    }
    assert.ok(["low", "high"].includes(result.confidence), `${id} bad confidence`);
  }
});
