export const STOPWORDS = new Set([
  "the", "of", "and", "a", "an", "to", "in", "is", "it", "for", "on", "with",
  "as", "at", "by", "from", "or", "be", "this", "that", "are", "was", "were",
  "been", "has", "have", "had", "not", "but", "its", "their", "they", "we",
  "you", "he", "she", "his", "her", "our", "your", "i", "do", "does", "did",
  "will", "would", "can", "could", "should", "may", "might", "must", "shall",
  "than", "then", "there", "here", "what", "which", "who", "whom", "when",
  "where", "why", "how", "all", "any", "both", "each", "more", "most",
  "other", "some", "such", "no", "nor", "only", "own", "same", "so", "too",
  "very", "s", "t", "just", "also", "about", "into", "over", "under",
  "again", "further", "once", "because", "while", "during", "before",
  "after", "above", "below", "up", "down", "out", "off", "if", "until"
]);

const DECIMAL_GUARD = "\u0001";
const ABBREV_GUARD = "\u0002";

const ABBREVIATIONS = [
  "Mr.", "Mrs.", "Dr.", "Prof.", "vs.", "e.g.", "i.e.", "etc.", "Inc.",
  "Ltd.", "Jr.", "Sr.", "St.", "Fig.", "No.", "Vol.", "pp.", "p.",
  "Sept.", "Jan.", "Feb.", "Mar.", "Apr.", "Jun.", "Jul.", "Aug.", "Sep.",
  "Oct.", "Nov.", "Dec."
].sort((a, b) => b.length - a.length);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskAmbiguousPeriods(text) {
  let masked = text.replace(/(\d)\.(\d)/g, `$1${DECIMAL_GUARD}$2`);
  for (const abbr of ABBREVIATIONS) {
    const stem = abbr.slice(0, -1);
    const re = new RegExp(`(^|[^A-Za-z])${escapeRegExp(abbr)}`, "g");
    masked = masked.replace(re, (match, prefix) => `${prefix}${stem}${ABBREV_GUARD}`);
  }
  return masked;
}

function unmask(text) {
  return text
    .split(DECIMAL_GUARD)
    .join(".")
    .split(ABBREV_GUARD)
    .join(".");
}

function splitChunk(chunk) {
  const pieces = [];
  let buffer = "";
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];
    buffer += ch;
    if (ch === "." || ch === "!" || ch === "?") {
      let j = i;
      while (
        j + 1 < chunk.length &&
        (chunk[j + 1] === "." || chunk[j + 1] === "!" || chunk[j + 1] === "?")
      ) {
        j += 1;
        buffer += chunk[j];
      }
      const next = chunk[j + 1];
      if (next === undefined || /\s/.test(next)) {
        pieces.push(buffer);
        buffer = "";
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }
  if (buffer.trim().length > 0) pieces.push(buffer);
  return pieces.filter((p) => /[a-z0-9]/i.test(p));
}

export function splitSentences(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const source = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const out = [];
  let index = 0;
  const paragraphs = source.split(/\n[ \t]*\n+/);
  for (const para of paragraphs) {
    const chunks = para.split(
      /\n(?=[ \t]*(?:[-*\u2022\u2023\u2013\u2014]|\d+[.)])[ \t])/
    );
    for (const chunk of chunks) {
      const pieces = splitChunk(maskAmbiguousPeriods(chunk));
      for (const piece of pieces) {
        const clean = unmask(piece).replace(/\s+/g, " ").trim();
        if (clean.length > 0) {
          out.push({ text: clean, index });
          index += 1;
        }
      }
    }
  }
  return out;
}

function undouble(word) {
  if (word.length >= 3) {
    const last = word[word.length - 1];
    const prev = word[word.length - 2];
    if (last === prev && !"ssllffzz".includes(last)) return word.slice(0, -1);
  }
  return word;
}

export function stemLight(word) {
  let w = typeof word === "string" ? word.toLowerCase() : "";
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith("ing")) return undouble(w.slice(0, -3));
  if (w.length > 4 && w.endsWith("ed")) return undouble(w.slice(0, -2));
  if (w.length > 5 && w.endsWith("ly")) return w.slice(0, -2);
  return w;
}

export function tokenize(text) {
  if (typeof text !== "string") return [];
  const parts = text.toLowerCase().split(/[^a-z0-9]+/);
  const out = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (/^\d+$/.test(part)) continue;
    if (STOPWORDS.has(part)) continue;
    const stem = stemLight(part);
    if (stem.length < 2 || STOPWORDS.has(stem)) continue;
    out.push(stem);
  }
  return out;
}
