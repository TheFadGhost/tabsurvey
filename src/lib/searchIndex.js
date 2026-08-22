function tokenize(query) {
  const raw = query == null ? "" : String(query);
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isWordChar(ch) {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

function startsAnyWord(text, token) {
  let idx = text.indexOf(token);
  while (idx !== -1) {
    if (idx === 0 || !isWordChar(text[idx - 1])) return true;
    idx = text.indexOf(token, idx + 1);
  }
  return false;
}

function numOr0(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function scoreToken(record, token) {
  let best = 0;
  const bump = (s) => {
    if (s > best) best = s;
  };

  const title = lower(record.title);
  if (title && title.includes(token)) bump(startsAnyWord(title, token) ? 8 : 6);

  const domain = lower(record.domain);
  if (domain && domain.includes(token)) bump(startsAnyWord(domain, token) ? 4 : 3);

  const url = lower(record.url);
  if (url && url.includes(token)) bump(2);

  const tags = Array.isArray(record.tags) ? record.tags : [];
  for (const tag of tags) {
    if (!tag) continue;
    const label = lower(tag.label);
    if (!label || !label.includes(token)) continue;
    bump(label === token || label.startsWith(token) ? 5 : 4);
  }

  const summary = record.summary;
  if (summary && typeof summary.abstract === "string" && lower(summary.abstract).includes(token)) bump(2);

  const extraction = record.extraction;
  if (extraction) {
    if (typeof extraction.excerpt === "string" && lower(extraction.excerpt).includes(token)) bump(1);
    const headings = Array.isArray(extraction.headings) ? extraction.headings : [];
    for (const heading of headings) {
      if (typeof heading === "string" && lower(heading).includes(token)) bump(1);
    }
  }

  return best;
}

export function search(records, query) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === "object");
  const tokens = tokenize(query);
  if (tokens.length === 0) return list;

  const scored = [];
  for (const record of list) {
    let total = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const s = scoreToken(record, token);
      if (s === 0) {
        matchedAll = false;
        break;
      }
      total += s;
    }
    if (matchedAll) scored.push({ record, total });
  }

  scored.sort(
    (a, b) =>
      b.total - a.total ||
      numOr0(b.record.lastAccessed) - numOr0(a.record.lastAccessed) ||
      String(a.record.title ?? "").localeCompare(String(b.record.title ?? "")) ||
      numOr0(a.record.id) - numOr0(b.record.id)
  );
  return scored.map((entry) => entry.record);
}
