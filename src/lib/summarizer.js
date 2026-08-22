import { splitSentences, tokenize } from "./textUtils.js";
import { LIMITS, SUMMARY_SENTENCES, SUMMARY_MAXCHARS } from "./schema.js";

const LENGTHS = new Set(["short", "medium", "long"]);

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function sentenceScore(tokens, idfOf) {
  const localTf = new Map();
  for (const token of tokens) {
    localTf.set(token, (localTf.get(token) || 0) + 1);
  }
  let sum = 0;
  for (const [token, count] of localTf) {
    sum += count * idfOf(token) * count;
  }
  const base = tokens.length === 0 ? 0 : sum / Math.sqrt(tokens.length);
  return base;
}

export function summarize(doc, opts = {}) {
  const length = opts && LENGTHS.has(opts.length) ? opts.length : "medium";
  const title = doc && typeof doc.title === "string" ? doc.title : "";
  const headings =
    doc && Array.isArray(doc.headings)
      ? doc.headings.filter((h) => typeof h === "string")
      : [];
  const text = doc && typeof doc.text === "string" ? doc.text : "";

  if (text.trim().length < LIMITS.MIN_TEXT_CHARS * 0.5) return null;
  const sentences = splitSentences(text);
  if (sentences.length === 0) return null;

  const n = sentences.length;
  const sentTokens = sentences.map((s) => tokenize(s.text));
  const sentSets = sentTokens.map((tokens) => new Set(tokens));

  const df = new Map();
  for (const tokens of sentTokens) {
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }
  const idfCache = new Map();
  const idfOf = (token) => {
    if (!idfCache.has(token)) {
      idfCache.set(token, Math.log(1 + n / (1 + (df.get(token) || 0))));
    }
    return idfCache.get(token);
  };

  const focusSet = new Set([
    ...tokenize(title),
    ...headings.flatMap((h) => tokenize(h))
  ]);

  const scores = sentences.map((sentence, i) => {
    const base = sentenceScore(sentTokens[i], idfOf);
    const positionBonus = Math.max(1, 1.15 * Math.pow(0.97, i));
    let overlapHits = 0;
    if (focusSet.size > 0) {
      for (const token of focusSet) {
        if (sentSets[i].has(token)) overlapHits += 1;
      }
    }
    const headingOverlap =
      focusSet.size === 0 ? 0 : (overlapHits / focusSet.size) * 0.35;
    return base + positionBonus + headingOverlap;
  });

  const k = SUMMARY_SENTENCES[length];
  const charBudget = SUMMARY_MAXCHARS[length];
  const pool = new Set(sentences.map((_, i) => i));
  const chosen = [];
  let usedChars = 0;
  while (chosen.length < k && pool.size > 0) {
    let bestIndex = -1;
    let bestValue = -Infinity;
    for (const i of pool) {
      let maxOverlap = 0;
      for (const j of chosen) {
        const jac = jaccard(sentSets[i], sentSets[j]);
        if (jac > maxOverlap) maxOverlap = jac;
      }
      const value = scores[i] * (1 - 0.9 * maxOverlap);
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    const candidateLength = sentences[bestIndex].text.length;
    const totalCost =
      chosen.length === 0
        ? candidateLength
        : usedChars + 1 + candidateLength;
    pool.delete(bestIndex);
    if (totalCost > charBudget) continue;
    chosen.push(bestIndex);
    usedChars = totalCost;
  }

  chosen.sort((a, b) => a - b);
  const abstract = chosen.map((i) => sentences[i].text).join(" ");
  const selected = chosen.map((i) => ({
    text: sentences[i].text,
    score: round4(scores[i])
  }));
  const confidence =
    Array.from(text).length < LIMITS.MIN_TEXT_CHARS || n < 4 ? "low" : "high";

  return { abstract, sentences: selected, confidence };
}
