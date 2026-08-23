import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { INTERNAL_SCHEMES, URL_KIND, classifyUrl } from "../../src/lib/schema.js";

const extractorPath = path.resolve(import.meta.dirname, "../../src/content/extractor.js");
const source = readFileSync(extractorPath, "utf8");
const sandbox = { module: { exports: {} }, console, chrome: undefined, document: undefined };
vm.runInNewContext(source, sandbox, { filename: extractorPath });
const extractor = sandbox.module.exports;

test("extractor and schema agree on internal schemes", () => {
  assert.ok(Array.isArray(extractor.INTERNAL_SCHEMES));
  const extSet = new Set(extractor.INTERNAL_SCHEMES);
  for (const scheme of INTERNAL_SCHEMES) {
    assert.ok(extSet.has(scheme), `extractor missing scheme ${scheme}`);
  }
  assert.equal(extSet.size, INTERNAL_SCHEMES.length, "extractor declares extra schemes");
});

test("classifySkip and classifyUrl agree on every scheme class", () => {
  const urls = [
    "chrome://settings/",
    "edge://version",
    "about:blank",
    "chrome-extension://abc/x.html",
    "devtools://devtools/bundled/x.html",
    "view-source:https://example.com/",
    "file:///C:/x.txt",
    "https://example.com/doc.pdf",
    "https://example.com/page?file=a.PDF",
    "https://example.com/page"
  ];
  for (const url of urls) {
    const skip = extractor.classifySkip(url);
    const cls = classifyUrl(url).kind;
    if (skip === null) {
      assert.equal(cls, URL_KIND.WEB, `${url}: skip=null but classify=${cls}`);
    } else {
      assert.notEqual(cls, URL_KIND.WEB, `${url}: skip=${skip} but classify=${cls}`);
    }
  }
});
