import { validateSessionsImport } from "./schema.js";

const STATE_ORDER = [
  ["audible", (r) => r.audible === true],
  ["discarded", (r) => r.discarded === true],
  ["duplicate", (r) => r.duplicateOf != null],
  ["pinned", (r) => r.pinned === true]
];

function linkTarget(url) {
  if (/[\s()]/.test(url)) return `(<${url}>)`;
  return `(${url})`;
}

function bullet(record) {
  const title = String(record.title ?? "");
  const target = linkTarget(String(record.url ?? ""));
  const segments = [];
  if (record.domain) segments.push(String(record.domain));
  const labels = (Array.isArray(record.tags) ? record.tags : [])
    .map((t) => (t && typeof t.label === "string" ? t.label : ""))
    .filter((l) => l.length > 0);
  if (labels.length > 0) segments.push(labels.join(", "));
  const states = STATE_ORDER.filter(([, has]) => has(record)).map(([name]) => name);
  if (states.length > 0) segments.push(states.join(", "));
  const head = `- [${title}]${target}`;
  return segments.length > 0 ? `${head} — ${segments.join(" · ")}` : head;
}

export function inventoryMarkdown(records, meta = {}) {
  const list = Array.isArray(records) ? records.filter((r) => r && typeof r === "object") : [];
  const stamp = meta.generatedAt ?? new Date().toISOString();
  const lines = ["# Tabsurvey inventory", "", `Generated ${stamp}`, `${list.length} tabs`, ""];

  const buckets = new Map();
  for (const record of list) {
    const tags = Array.isArray(record.tags) ? record.tags : [];
    const ruleTag = tags.find((t) => t && t.source === "rule" && typeof t.label === "string" && t.label.length > 0);
    const name = ruleTag ? ruleTag.label : "Other";
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(record);
  }

  const orderedNames = [...buckets.keys()].filter((n) => n !== "Other").sort((a, b) => a.localeCompare(b));
  if (buckets.has("Other")) orderedNames.push("Other");

  orderedNames.forEach((name, index) => {
    const members = buckets.get(name).slice().sort(
      (a, b) =>
        String(a.domain ?? "").localeCompare(String(b.domain ?? "")) ||
        String(a.title ?? "").localeCompare(String(b.title ?? ""))
    );
    if (index > 0) lines.push("");
    lines.push(`## ${name} (${members.length})`);
    for (const record of members) {
      lines.push(bullet(record));
      const abstract = record.summary && typeof record.summary.abstract === "string" ? record.summary.abstract : "";
      if (abstract) lines.push(`  > ${abstract}`);
      const extraction = record.extraction;
      if (extraction && extraction.status === "failed") {
        lines.push(`  > not readable (${extraction.reason})`);
      }
    }
  });

  return lines.join("\n") + "\n";
}

export function sessionsToJson(sessions) {
  return JSON.stringify(
    { version: 1, exportedAt: new Date().toISOString(), sessions: Array.isArray(sessions) ? sessions : [] },
    null,
    2
  );
}

export function parseSessionsJson(text) {
  try {
    return validateSessionsImport(JSON.parse(text));
  } catch {
    return { ok: false, error: "invalid-json" };
  }
}
