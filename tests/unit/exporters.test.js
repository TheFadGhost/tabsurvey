import { test } from "node:test";
import assert from "node:assert/strict";
import { inventoryMarkdown, sessionsToJson, parseSessionsJson } from "../../src/lib/exporters.js";

function base(overrides = {}) {
  return {
    id: 1,
    url: "",
    normalizedUrl: "",
    domain: "",
    title: "",
    kind: "web",
    windowId: -1,
    groupId: null,
    index: 0,
    pinned: false,
    audible: false,
    discarded: false,
    favIconUrl: "",
    lastAccessed: 0,
    duplicateOf: null,
    extraction: null,
    summary: null,
    tags: [],
    ...overrides
  };
}

const GOLDEN_RECORDS = [
  base({
    id: 1,
    url: "https://github.com/facebook/react",
    normalizedUrl: "https://github.com/facebook/react",
    domain: "github.com",
    title: "React Repo",
    pinned: true,
    tags: [{ id: "t1", label: "Development", source: "rule", reason: "domain github.com" }]
  }),
  base({
    id: 2,
    url: "https://gitlab.com/gitlab-org/gitlab",
    normalizedUrl: "https://gitlab.com/gitlab-org/gitlab",
    domain: "gitlab.com",
    title: "GitLab Project",
    audible: true,
    summary: { abstract: "Open source dev platform.", sentences: ["Open source dev platform."], confidence: "medium" },
    tags: [{ id: "t2", label: "Development", source: "rule", reason: "domain gitlab.com" }]
  }),
  base({
    id: 3,
    url: "https://research.example.net/report (draft).pdf",
    normalizedUrl: "https://research.example.net/report (draft).pdf",
    domain: "example.net",
    kind: "pdf",
    title: "Draft Report",
    discarded: true,
    duplicateOf: 1
  })
];

const GOLDEN_EXPECTED =
  [
    "# Tabsurvey inventory",
    "",
    "Generated 2026-08-23T10:00:00.000Z",
    "3 tabs",
    "",
    "## Development (2)",
    "- [React Repo](https://github.com/facebook/react) — github.com · Development · pinned",
    "- [GitLab Project](https://gitlab.com/gitlab-org/gitlab) — gitlab.com · Development · audible",
    "  > Open source dev platform.",
    "",
    "## Other (1)",
    "- [Draft Report](<https://research.example.net/report (draft).pdf>) — example.net · discarded, duplicate"
  ].join("\n") + "\n";

test("inventoryMarkdown golden structure: exact string equality for hand-computed set", () => {
  const out = inventoryMarkdown(GOLDEN_RECORDS, { generatedAt: "2026-08-23T10:00:00.000Z" });
  assert.equal(out, GOLDEN_EXPECTED);
});

test("failed extraction renders indented not-readable note (exact string)", () => {
  const records = [
    base({
      url: "https://news.example.com/paywall",
      normalizedUrl: "https://news.example.com/paywall",
      domain: "example.com",
      title: "Paywalled Article",
      extraction: { status: "failed", reason: "paywall-stub" }
    })
  ];
  const expected =
    [
      "# Tabsurvey inventory",
      "",
      "Generated 2026-01-02T03:04:05.000Z",
      "1 tabs",
      "",
      "## Other (1)",
      "- [Paywalled Article](https://news.example.com/paywall) — example.com",
      "  > not readable (paywall-stub)"
    ].join("\n") + "\n";
  assert.equal(inventoryMarkdown(records, { generatedAt: "2026-01-02T03:04:05.000Z" }), expected);
});

test("groups sort alphabetically with Other always last; default timestamp is ISO", () => {
  const records = [
    base({ id: 1, domain: "z.example.com", title: "B tab", tags: [{ id: "a", label: "Zeta", source: "rule", reason: "r" }] }),
    base({ id: 2, domain: "a.example.com", title: "A tab", tags: [{ id: "b", label: "Alpha", source: "rule", reason: "r" }] }),
    base({ id: 3, domain: "o.example.com", title: "O tab" })
  ];
  const out = inventoryMarkdown(records);
  const iAlpha = out.indexOf("## Alpha (1)");
  const iZeta = out.indexOf("## Zeta (1)");
  const iOther = out.indexOf("## Other (1)");
  assert.ok(iAlpha !== -1 && iZeta !== -1 && iOther !== -1);
  assert.ok(iAlpha < iZeta && iZeta < iOther);
  assert.match(out, /^Generated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/m);
  assert.ok(out.endsWith("\n"));
});

test("sessionsToJson → parseSessionsJson round-trips to the original sessions", () => {
  const sessions = [
    {
      id: "s1",
      name: "Research burst",
      createdAt: 1724000000000,
      tabs: [
        { url: "https://a.example.com/x", title: "A doc", savedAt: 1724000000100 },
        { url: "https://b.example.org/y?q=1", title: "B page", savedAt: 1724000000200 }
      ]
    },
    {
      id: "s2",
      name: "Reading later",
      createdAt: 1724000005000,
      tabs: [{ url: "https://c.example.net/", title: "C", savedAt: 1724000006000 }]
    }
  ];
  const json = sessionsToJson(sessions);
  const parsed = JSON.parse(json);
  assert.equal(parsed.version, 1);
  assert.match(parsed.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(parsed.sessions, sessions);

  const result = parseSessionsJson(json);
  assert.equal(result.ok, true);
  assert.deepEqual(result.sessions, sessions);
});

test("invalid JSON yields ok:false error invalid-json", () => {
  assert.deepEqual(parseSessionsJson("{not json"), { ok: false, error: "invalid-json" });
  assert.deepEqual(parseSessionsJson(""), { ok: false, error: "invalid-json" });
});

test("unsupported version or shape yields unsupported-format", () => {
  assert.deepEqual(parseSessionsJson(JSON.stringify({ version: 2, sessions: [] })), {
    ok: false,
    error: "unsupported-format"
  });
  assert.deepEqual(parseSessionsJson(JSON.stringify({ version: 1, sessions: "nope" })), {
    ok: false,
    error: "unsupported-format"
  });
});
