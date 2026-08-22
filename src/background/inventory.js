import { createTabRecord, applyTabDelta, URL_KIND, FAILURE_REASONS } from "../lib/schema.js";

export function syncFromTabs(existingMap, tabs, settings) {
  const source = existingMap && typeof existingMap === "object" ? existingMap : {};
  const map = {};
  const createdIds = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab || tab.id == null) continue;
    const key = String(tab.id);
    const existing = source[key];
    if (existing) {
      const clone = { ...existing };
      applyTabDelta(clone, tab);
      map[key] = clone;
    } else {
      map[key] = createTabRecord(tab);
      createdIds.push(tab.id);
    }
  }
  const removedIds = [];
  for (const key of Object.keys(source)) {
    if (!(key in map)) removedIds.push(key);
  }
  return { map, createdIds, removedIds };
}

export function eligibility(record, settings, hostGranted) {
  if (!record || record.kind !== URL_KIND.WEB) return false;
  if (!settings || !Array.isArray(settings.excludedDomains)) return false;
  if (settings.excludedDomains.includes(record.domain)) return false;
  if (!hostGranted) return false;
  if (record.discarded) return false;
  if (record.extraction) return false;
  return true;
}

export function pruneForQuota(map) {
  const out = { ...(map || {}) };
  const KEEP = 40;
  const entries = Object.values(map || {})
    .filter((r) => r && r.id != null)
    .map((r) => ({
      r,
      t: r.extraction && Number.isFinite(r.extraction.extractedAt) ? r.extraction.extractedAt : -Infinity
    }))
    .sort((a, b) => a.t - b.t);
  const prunedIds = [];
  const cutoff = Math.max(0, entries.length - KEEP);
  for (let i = 0; i < cutoff; i++) {
    const rec = entries[i].r;
    if (rec.extraction) {
      out[rec.id] = { ...rec, extraction: { status: "failed", reason: FAILURE_REASONS.UNKNOWN } };
      prunedIds.push(rec.id);
    }
  }
  return { map: out, prunedIds };
}

export function groupBuckets(records, by, tabIdFilter) {
  const filterSet = Array.isArray(tabIdFilter) ? new Set(tabIdFilter) : null;
  const buckets = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.id == null) continue;
    if (filterSet && !filterSet.has(record.id)) continue;
    let key;
    if (by === "category") {
      const tag = Array.isArray(record.tags)
        ? record.tags.find((t) => t && t.source === "rule" && typeof t.label === "string" && t.label.length > 0)
        : null;
      key = tag ? tag.label : "Other";
    } else if (by === "window") {
      key = String(record.windowId);
    } else {
      key = record.domain || "(none)";
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record.id);
  }
  const out = {};
  for (const k of [...buckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[k] = buckets.get(k);
  }
  return out;
}

export const GROUP_COLORS = ["blue", "cyan", "green", "grey", "orange", "pink", "purple", "red", "yellow"];
