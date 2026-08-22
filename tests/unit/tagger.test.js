import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultRules,
  buildDefaultCorrections,
  categorize,
  applyCorrection,
  mergeCorrections
} from "../../src/lib/tagger.js";

function rec(overrides = {}) {
  return {
    title: "",
    domain: "",
    url: "",
    extraction: null,
    ...overrides
  };
}

test("buildDefaultRules returns deeply frozen rules with expected categories", () => {
  const rules = buildDefaultRules();
  assert.ok(Array.isArray(rules));
  assert.ok(rules.length >= 10);
  assert.ok(Object.isFrozen(rules));
  for (const rule of rules) {
    assert.ok(Object.isFrozen(rule));
    assert.ok(Object.isFrozen(rule.domains));
    assert.ok(Object.isFrozen(rule.titleTerms));
    assert.ok(Object.isFrozen(rule.urlPatterns));
    assert.equal(typeof rule.priority, "number");
    assert.equal(typeof rule.minSignals, "number");
    assert.equal(typeof rule.id, "string");
    assert.equal(typeof rule.label, "string");
  }
  const labels = rules.map((r) => r.label);
  for (const expected of [
    "Development", "Docs", "Design", "Shopping", "News",
    "Social", "Video", "Email", "Finance", "Travel"
  ]) {
    assert.ok(labels.includes(expected), `missing ${expected}`);
  }
});

test("buildDefaultCorrections returns frozen empty shape", () => {
  const c = buildDefaultCorrections();
  assert.deepEqual(c, { removed: {}, added: {} });
  assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(c.removed));
  assert.ok(Object.isFrozen(c.added));
});

test("github tab gets Development tag with domain reason", () => {
  const record = rec({
    title: "React pull request",
    domain: "github.com",
    url: "https://github.com/facebook/react/pull/12345"
  });
  const tags = categorize(record);
  const dev = tags.find((t) => t.label === "Development");
  assert.ok(dev, "Development tag missing");
  assert.equal(dev.source, "rule");
  assert.equal(dev.id, "rule:development");
  assert.equal(dev.reason, "domain github.com matches github.com");
  assert.equal(tags[0].label, "Development");
});

test("title-only evidence matches Development then Docs by priority", () => {
  const record = rec({ title: "Kubernetes quick start", domain: "unknown.example", url: "" });
  const tags = categorize(record);
  const labels = tags.filter((t) => t.source === "rule").map((t) => t.label);
  assert.deepEqual(labels, ["Development", "Docs"]);
  const dev = tags[0];
  assert.equal(dev.reason, 'title contains "kubernetes"');
  const docs = tags[1];
  assert.equal(docs.reason, 'title contains "quick start"');
});

test("cap of 3 rule labels keeps highest priorities among four matching categories", () => {
  const record = rec({
    title: "Bundle page",
    domain: "www.example.com",
    url:
      "https://www.example.com/dp/BABCDEFGH1/item/99/products/youtu.be/dQw4/status/555/comments/abc/billing"
  });
  const tags = categorize(record);
  const ruleTags = tags.filter((t) => t.source === "rule");
  assert.deepEqual(
    ruleTags.map((t) => t.label),
    ["Social", "Video", "Finance"]
  );
  assert.ok(!ruleTags.some((t) => t.label === "Shopping"));
});

test("removal learning suppresses Development even on github domain", () => {
  const record = rec({
    title: "React pull request",
    domain: "github.com",
    url: "https://github.com/facebook/react/pull/12345"
  });
  const first = categorize(record);
  assert.ok(first.some((t) => t.label === "Development"));
  const second = categorize(record, {
    corrections: { removed: { Development: 1 }, added: {} }
  });
  assert.ok(!second.some((t) => t.label === "Development"));
});

test("added labels appear first with tag-you-added reason", () => {
  const record = rec({
    title: "React pull request",
    domain: "github.com",
    url: "https://github.com/facebook/react/pull/12345"
  });
  const tags = categorize(record, {
    corrections: { removed: {}, added: { research: 1 } }
  });
  assert.equal(tags[0].id, "added:research");
  assert.equal(tags[0].label, "research");
  assert.equal(tags[0].source, "rule");
  assert.equal(tags[0].reason, "tag you added");
});

test("applyCorrection remove -> merge -> recategorize full loop is pure", () => {
  const record = rec({
    title: "React pull request",
    domain: "github.com",
    url: "https://github.com/facebook/react/pull/12345"
  });
  const recordSnapshot = structuredClone(record);

  const base = categorize(record);
  assert.deepEqual(record, recordSnapshot);
  assert.ok(base.some((t) => t.label === "Development"));
  const baseSnapshot = structuredClone(base);

  const fresh = buildDefaultCorrections();
  const { tags: filtered, corrections: c1 } = applyCorrection(base, { op: "remove", label: "Development" }, fresh);
  assert.ok(!filtered.some((t) => t.label === "Development"));
  assert.equal(c1.removed.Development, 1);
  assert.deepEqual(c1.added, {});
  assert.deepEqual(fresh, { removed: {}, added: {} });
  assert.deepEqual(base, baseSnapshot);

  const merged = mergeCorrections(c1, buildDefaultCorrections());
  assert.equal(merged.removed.Development, 1);
  assert.deepEqual(merged.added, {});
  const mergedSnapshot = structuredClone(merged);

  const again = categorize(record, { corrections: merged });
  assert.ok(!again.some((t) => t.label === "Development"));

  const { tags: withAdd, corrections: c2 } = applyCorrection(again, { op: "add", label: "research" }, merged);
  const last = withAdd[withAdd.length - 1];
  assert.equal(last.id, "added:research");
  assert.equal(last.label, "research");
  assert.equal(last.source, "rule");
  assert.equal(last.reason, "tag you added");
  assert.equal(c2.added.research, 1);
  assert.equal(c2.removed.Development, 1);
  assert.deepEqual(merged, mergedSnapshot);
  assert.deepEqual(base, baseSnapshot);

  const finalTags = categorize(record, { corrections: c2 });
  assert.equal(finalTags[0].id, "added:research");
  assert.equal(finalTags[0].reason, "tag you added");
  assert.ok(!finalTags.some((t) => t.label === "Development"));
  assert.ok(withAdd.every((t) => typeof t.reason === "string"));
});

test("keyword fallback emits frequent-term tags when no rules match", () => {
  const record = rec({
    title: "Zanzibar zanzibar notes",
    domain: "personal.example",
    url: "https://personal.example/notes",
    extraction: { excerpt: "zanzibar travel memories zanzibar beach" }
  });
  const tags = categorize(record);
  assert.ok(tags.length >= 2);
  assert.equal(tags[0].source, "keyword");
  assert.equal(tags[0].id, "kw:zanzibar");
  assert.equal(tags[0].label, "zanzibar");
  assert.equal(tags[0].reason, 'frequent term "zanzibar"');
  assert.equal(tags[1].id, "kw:notes");
  assert.equal(tags[1].reason, 'frequent term "notes"');
});

test("invalid urlPattern in custom rule is skipped without throwing", () => {
  const rules = [
    {
      id: "bad",
      label: "Weird",
      priority: 100,
      domains: [],
      titleTerms: [],
      urlPatterns: ["(["],
      minSignals: 1
    },
    {
      id: "mixed",
      label: "Mixed",
      priority: 90,
      domains: [],
      titleTerms: [],
      urlPatterns: ["([", "/hit/"],
      minSignals: 1
    },
    {
      id: "good",
      label: "Good",
      priority: 50,
      domains: ["example.com"],
      titleTerms: [],
      urlPatterns: [],
      minSignals: 1
    }
  ];
  const record = rec({
    title: "plain title here",
    domain: "example.com",
    url: "https://example.com/hit/page"
  });
  let tags;
  assert.doesNotThrow(() => {
    tags = categorize(record, { rules });
  });
  const labels = tags.map((t) => t.label);
  assert.ok(!labels.includes("Weird"));
  assert.ok(labels.includes("Good"));
  const mixed = tags.find((t) => t.label === "Mixed");
  assert.ok(mixed, "valid pattern after invalid one should still match");
  assert.equal(mixed.reason, "url matches /hit/");
});

test("categorize is deterministic for identical inputs", () => {
  const record = rec({
    title: "Best deals and breaking news video roundup",
    domain: "news.ycombinator.com",
    url: "https://news.ycombinator.com/item?id=42/status/99",
    extraction: { excerpt: "deal trailer episode report" }
  });
  const ctxRules = buildDefaultRules();
  const ctxCorr = buildDefaultCorrections();
  const a = categorize(record, { rules: ctxRules, corrections: ctxCorr });
  const b = categorize(record, { rules: ctxRules, corrections: ctxCorr });
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
});

test("tags never exceed four across varied synthetic records", () => {
  const records = [
    rec(),
    rec({ title: "", domain: "", url: "", extraction: null }),
    rec({ title: "React pull request", domain: "github.com", url: "https://github.com/facebook/react/pull/9" }),
    rec({ title: "How do I parse JSON in Python?", domain: "stackoverflow.com", url: "https://stackoverflow.com/questions/123/x" }),
    rec({ title: "left-pad", domain: "npmjs.com", url: "https://www.npmjs.com/package/left-pad" }),
    rec({ title: "Array prototype guide", domain: "developer.mozilla.org", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript" }),
    rec({ title: "Project manual", domain: "docs.python.org", url: "https://docs.python.org/3/tutorial/" }),
    rec({ title: "Design system mockup", domain: "figma.com", url: "https://figma.com/file/abc" }),
    rec({ title: "Wireless headphones deal", domain: "amazon.co.uk", url: "https://www.amazon.co.uk/dp/B08N5WRWNW" }),
    rec({ title: "Collectible listing", domain: "ebay.de", url: "https://www.ebay.de/item/9876543210" }),
    rec({ title: "Ask HN thread", domain: "news.ycombinator.com", url: "https://news.ycombinator.com/comments/abcdef" }),
    rec({ title: "Lo-fi study mix", domain: "youtube.com", url: "https://www.youtube.com/watch?v=abc" }),
    rec({ title: "Compose email", domain: "mail.google.com", url: "https://mail.google.com/u/0" }),
    rec({ title: "Portfolio payment receipt", domain: "paypal.com", url: "https://paypal.com/billing/invoices" }),
    rec({ title: "Hotel reservation confirmation", domain: "booking.com", url: "https://www.booking.com/hotel/x" }),
    rec({ title: "Breaking report from the capital", domain: "bbc.co.uk", url: "https://www.bbc.co.uk/news/2024/03/" }),
    rec({ title: "Discussion about the announcement", domain: "reddit.com", url: "https://www.reddit.com/r/x/comments/abc1/details" }),
    rec({ title: "Posting a thought", domain: "x.com", url: "https://x.com/user/status/1456789012345" }),
    rec({
      title: "digitize your workflow with regular updates",
      domain: "blog.example",
      url: "https://blog.example/posts/digitize?utm_source=x&ref=y#frag"
    }),
    rec({
      title: "\u0007Control\u0008 chars   spaced   out title",
      domain: "weird.example",
      url: "not a real url at all",
      extraction: { excerpt: "repeated repeated repeated tokens tokens everywhere" }
    }),
    rec({ title: "Flight itinerary boarding pass", domain: "airbnb.io", url: "https://airbnb.io/rooms/123", extraction: { excerpt: "" } }),
    rec({ title: "A".repeat(500), domain: "long.example", url: "https://long.example/" + "x".repeat(2000), extraction: { excerpt: "word ".repeat(300) } })
  ];
  for (const record of records) {
    const tags = categorize(record);
    assert.ok(Array.isArray(tags));
    assert.ok(tags.length <= 4, `too many tags: ${tags.length}`);
    const seen = new Set();
    for (const tag of tags) {
      assert.equal(typeof tag.id, "string");
      assert.equal(typeof tag.label, "string");
      assert.equal(typeof tag.reason, "string");
      assert.ok(tag.source === "rule" || tag.source === "keyword");
      assert.ok(!seen.has(tag.id));
      seen.add(tag.id);
      assert.ok(Array.from(tag.label).length <= 33, `label too long: ${tag.label}`);
      assert.ok(Array.from(tag.reason).length <= 121, `reason too long: ${tag.reason}`);
    }
  }
});

test("whole-word title terms do not match substrings inside words", () => {
  const tags = categorize(rec({ title: "digitize everything", domain: "misc.example", url: "" }));
  assert.ok(!tags.some((t) => t.label === "Development"));
});
