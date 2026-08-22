import { URL_KIND } from "./schema.js";

const GROUPABLE_KINDS = new Set([URL_KIND.WEB, URL_KIND.FILE, URL_KIND.PDF]);

function numericId(id) {
  const n = Number(id);
  return Number.isFinite(n) ? n : Infinity;
}

function collectGroups(records) {
  const groups = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.normalizedUrl !== "string" || record.normalizedUrl.length === 0) continue;
    if (!GROUPABLE_KINDS.has(record.kind)) continue;
    const bucket = groups.get(record.normalizedUrl);
    if (bucket) bucket.push(record);
    else groups.set(record.normalizedUrl, [record]);
  }
  return groups;
}

export function markDuplicates(records) {
  const groups = collectGroups(records);
  let marked = 0;
  for (const members of groups.values()) {
    let primary = null;
    for (const member of members) {
      member.duplicateOf = null;
      if (!primary || numericId(member.id) < numericId(primary.id)) primary = member;
    }
    if (members.length < 2) continue;
    for (const member of members) {
      if (member === primary) continue;
      member.duplicateOf = primary.id;
      marked++;
    }
  }
  return marked;
}

export function duplicateSets(records) {
  const sets = [];
  for (const members of collectGroups(records).values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => numericId(a.id) - numericId(b.id));
    sets.push({ primaryId: ordered[0].id, ids: ordered.map((m) => m.id) });
  }
  sets.sort((a, b) => numericId(a.primaryId) - numericId(b.primaryId));
  return sets;
}
