import { test } from "node:test";
import assert from "node:assert/strict";
import { STOPWORDS, tokenize, stemLight, splitSentences } from "../../src/lib/textUtils.js";

test("STOPWORDS is a populated Set of common english stopwords", () => {
  assert.ok(STOPWORDS instanceof Set);
  for (const word of ["the", "of", "and", "is", "with", "because", "until", "s", "t"]) {
    assert.ok(STOPWORDS.has(word), `expected stopword ${word}`);
  }
  assert.ok(STOPWORDS.size >= 90);
});

test("stemLight strips ing and undoubles final consonant", () => {
  assert.equal(stemLight("running"), "run");
  assert.equal(stemLight("getting"), "get");
  assert.equal(stemLight("processing"), "process");
});

test("stemLight maps studies to study and handles plurals", () => {
  assert.equal(stemLight("studies"), "study");
  assert.equal(stemLight("cities"), "city");
  assert.equal(stemLight("dogs"), "dog");
  assert.equal(stemLight("classes"), "class");
  assert.equal(stemLight("boxes"), "box");
});

test("stemLight leaves short and unsuffixed words alone", () => {
  assert.equal(stemLight("gas"), "gas");
  assert.equal(stemLight("cats"), "cat");
  assert.equal(stemLight("policy"), "policy");
});

test("tokenize lowercases, stems, drops stopwords and numbers", () => {
  assert.deepEqual(tokenize("The running dogs"), ["run", "dog"]);
  assert.deepEqual(tokenize("studies show growth"), ["study", "show", "growth"]);
});

test("tokenize drops pure numbers, empty fragments, and 1-char tokens", () => {
  assert.deepEqual(tokenize("42 cats and 7 dogs!"), ["cat", "dog"]);
  assert.deepEqual(tokenize("a I b 5 x-ray"), ["ray"]);
});

test("tokenize returns empty array for empty and non-string input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(42), []);
});

test("splitSentences keeps abbreviations intact", () => {
  const out = splitSentences("Dr. Smith arrived.");
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Dr. Smith arrived.");
  assert.equal(out[0].index, 0);
});

test("splitSentences keeps decimals intact", () => {
  const out = splitSentences("The value 3.14 is pi exactly.");
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "The value 3.14 is pi exactly.");
});

test("splitSentences splits on stacked punctuation", () => {
  const out = splitSentences("Really?! Yes.");
  assert.deepEqual(out.map((s) => s.text), ["Really?!", "Yes."]);
});

test("splitSentences returns empty array for empty input", () => {
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences(null), []);
});

test("splitSentences treats paragraph breaks as hard boundaries", () => {
  const out = splitSentences("First one here.\n\nSecond one there.");
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "First one here.");
  assert.equal(out[1].index, 1);
});

test("splitSentences never returns empty entries", () => {
  const out = splitSentences("Hello world.   .\n\n\n   !!!   Done now.");
  for (const s of out) {
    assert.ok(s.text.trim().length > 0);
    assert.ok(/[a-z0-9]/i.test(s.text));
  }
  assert.deepEqual(out.map((s) => s.text), ["Hello world.", "Done now."]);
});

test("splitSentences breaks before bullet lines without terminal punctuation", () => {
  const out = splitSentences("Intro line.\n- Added: one thing\n- Fixed: another thing");
  assert.ok(out.length >= 3);
  assert.equal(out[0].text, "Intro line.");
});
