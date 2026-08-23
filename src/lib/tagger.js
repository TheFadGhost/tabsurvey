import { sanitizeText } from "./schema.js";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "while", "with", "without",
  "from", "to", "of", "in", "on", "at", "by", "for", "about", "into", "over", "under", "again",
  "further", "once", "here", "there", "all", "any", "both", "each", "few", "more", "most", "other",
  "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "can",
  "will", "just", "should", "now", "is", "are", "was", "were", "be", "been", "being", "have",
  "has", "had", "having", "do", "does", "did", "doing", "would", "could", "might", "must", "shall",
  "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they", "them", "his",
  "her", "its", "our", "your", "their", "what", "which", "who", "whom", "how", "why", "where",
  "www", "http", "https", "com", "org", "net", "html", "htm", "php", "aspx", "index", "page",
  "site", "home"
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const DEFAULT_RULE_DATA = [
  {
    id: "email", label: "Email", priority: 95,
    domains: ["mail.google.com", "outlook.live.com", "outlook.office.com"],
    titleTerms: ["inbox", "compose"], urlPatterns: [], minSignals: 1
  },
  {
    id: "development", label: "Development", priority: 90,
    domains: ["github.com", "gitlab.com", "stackoverflow.com", "stackexchange.com", "npmjs.com", "developer.mozilla.org"],
    titleTerms: ["npm", "webpack", "kubernetes", "docker", "typescript", "javascript", "python", "unit test", "api", "regex", "git"],
    urlPatterns: ["github\\.com/.+/.+", "/pull/\\d+", "stackoverflow\\.com/questions/", "npmjs\\.com/package/"],
    minSignals: 1
  },
  {
    id: "social", label: "Social", priority: 85,
    domains: ["twitter.com", "x.com", "reddit.com", "linkedin.com", "facebook.com", "instagram.com", "mastodon.", "threads.net", "news.ycombinator.com"],
    titleTerms: [],
    urlPatterns: ["/status/\\d+", "/comments/[a-z0-9]+"],
    minSignals: 1
  },
  {
    id: "video", label: "Video", priority: 80,
    domains: ["youtube.com", "youtu.be", "vimeo.com", "twitch.tv", "netflix.com"],
    titleTerms: ["video", "episode", "trailer"],
    urlPatterns: ["youtube\\.com/watch", "youtu\\.be/"],
    minSignals: 1
  },
  {
    id: "finance", label: "Finance", priority: 78,
    domains: ["paypal.com", "stripe.com", "coinbase.com", "robinhood.com", "finance.yahoo.com"],
    titleTerms: ["invoice", "payment", "receipt", "portfolio", "stock"],
    urlPatterns: ["/billing", "/invoices?", "/checkout/pay"],
    minSignals: 1
  },
  {
    id: "shopping", label: "Shopping", priority: 75,
    domains: ["amazon.", "ebay.", "etsy.com", "aliexpress.com", "bestbuy.com"],
    titleTerms: ["cart", "checkout", "price", "add to cart", "deal", "coupon"],
    urlPatterns: ["/dp/B[A-Z0-9]{9}", "/item/\\d+", "/products/"],
    minSignals: 1
  },
  {
    id: "design", label: "Design", priority: 70,
    domains: ["figma.com", "dribbble.com", "behance.net", "fonts.google.com", "coolors.co"],
    titleTerms: ["figma", "typography", "design system", "mockup", "wireframe", "palette"],
    urlPatterns: [],
    minSignals: 1
  },
  {
    id: "travel", label: "Travel", priority: 65,
    domains: ["booking.com", "airbnb.", "expedia.", "kayak.com", "ryanair.com", "amtrak.com"],
    titleTerms: ["flight", "hotel", "itinerary", "boarding", "reservation"],
    urlPatterns: [],
    minSignals: 1
  },
  {
    id: "docs", label: "Docs", priority: 60,
    domains: ["docs.", "readthedocs.io", "wiki."],
    titleTerms: ["documentation", "guide", "reference", "tutorial", "cheatsheet", "quick start"],
    urlPatterns: ["^https?://[^/]*docs\\.", "/docs?/"],
    minSignals: 1
  },
  {
    id: "news", label: "News", priority: 55,
    domains: ["nytimes.com", "bbc.", "reuters.com", "theguardian.com", "arstechnica.com", "techcrunch.com", "news.ycombinator.com"],
    titleTerms: ["breaking", "report", "news", "opinion"],
    urlPatterns: ["/\\d{4}/\\d{2}/"],
    minSignals: 1
  }
];

let frozenRules = null;
let frozenCorrections = null;

export function buildDefaultRules() {
  if (!frozenRules) {
    frozenRules = deepFreeze(DEFAULT_RULE_DATA.map((rule) => ({
      id: rule.id,
      label: rule.label,
      priority: rule.priority,
      domains: [...rule.domains],
      titleTerms: [...rule.titleTerms],
      urlPatterns: [...rule.urlPatterns],
      minSignals: rule.minSignals
    })));
  }
  return frozenRules;
}

export function buildDefaultCorrections() {
  if (!frozenCorrections) {
    frozenCorrections = deepFreeze({ removed: {}, added: {} });
  }
  return frozenCorrections;
}

function defaultTokenize(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegex(term) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}($|[^a-z0-9])`, "i");
}

function domainMatches(recordDomain, ruleDomain) {
  const rd = String(recordDomain || "").toLowerCase();
  if (!rd) return false;
  const raw = String(ruleDomain || "").toLowerCase();
  const wildcard = /\.+$/.test(raw);
  const stem = raw.replace(/\.+$/, "");
  if (!stem) return false;
  if (rd === stem) return true;
  if (rd.endsWith("." + stem)) return true;
  if (wildcard && rd.startsWith(stem + ".")) return true;
  return false;
}

function removedHas(corrections, label) {
  const removed = corrections.removed || {};
  const low = String(label).toLowerCase();
  for (const key of Object.keys(removed)) {
    if ((Number(removed[key]) || 0) >= 1 && key.toLowerCase() === low) return true;
  }
  return false;
}

function evaluateRule(rule, record, tokenize) {
  const title = typeof record.title === "string" ? record.title : "";
  const url = typeof record.url === "string" ? record.url : "";
  const domain = typeof record.domain === "string" ? record.domain : "";
  const excerpt =
    record.extraction && typeof record.extraction.excerpt === "string" ? record.extraction.excerpt : "";

  let domainHit = false;
  let firstDomain = "";
  for (const entry of rule.domains) {
    if (domainMatches(domain, entry)) {
      domainHit = true;
      firstDomain = entry;
      break;
    }
  }

  let titleTermHits = 0;
  let matchedTitleTerm = "";
  for (const term of rule.titleTerms) {
    if (term.length > 0 && termRegex(term).test(title)) {
      titleTermHits += 1;
      if (!matchedTitleTerm) matchedTitleTerm = term;
    }
  }

  let urlPatternHits = 0;
  let matchedPattern = "";
  for (const pattern of rule.urlPatterns) {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      continue;
    }
    if (re.test(url)) {
      urlPatternHits += 1;
      if (!matchedPattern) matchedPattern = pattern;
    }
  }

  const excerptTokens = new Set(tokenize(excerpt));
  let excerptTermHits = 0;
  let matchedExcerptTerm = "";
  for (const term of rule.titleTerms) {
    const parts = tokenize(term);
    if (parts.length > 0 && parts.every((part) => excerptTokens.has(part))) {
      excerptTermHits += 1;
      if (!matchedExcerptTerm) matchedExcerptTerm = term;
    }
  }

  const signalCount = (domainHit ? 1 : 0) + titleTermHits + urlPatternHits + 0.5 * excerptTermHits;
  const threshold = Math.max(rule.minSignals, 2);
  const matched =
    domainHit || titleTermHits > 0 || urlPatternHits > 0 || signalCount >= threshold;

  let reasonKind = "";
  let reasonValue = "";
  if (domainHit) {
    reasonKind = "domain";
    reasonValue = rule.domains[0] != null ? rule.domains[0] : firstDomain;
  } else if (matchedTitleTerm) {
    reasonKind = "title";
    reasonValue = matchedTitleTerm;
  } else if (matchedPattern) {
    reasonKind = "url";
    reasonValue = matchedPattern;
  } else if (matchedExcerptTerm) {
    reasonKind = "excerpt";
    reasonValue = matchedExcerptTerm;
  }

  return { rule, matched, signalCount, reasonKind, reasonValue };
}

function keywordTags(tags, title, excerpt, corrections, tokenize) {
  if (tags.length >= 2) return;
  const freq = new Map();
  const bump = (token, weight) => {
    freq.set(token, (freq.get(token) || 0) + weight);
  };
  for (const token of tokenize(title)) bump(token, 2);
  for (const token of tokenize(excerpt)) bump(token, 1);

  const existing = new Set(tags.map((tag) => String(tag.label).toLowerCase()));
  const removedLower = new Set(
    Object.keys(corrections.removed || {})
      .filter((key) => (Number(corrections.removed[key]) || 0) >= 1)
      .map((key) => key.toLowerCase())
  );

  const candidates = [...freq.entries()]
    .filter(
      ([token]) =>
        token.length >= 4 &&
        /[^\d]/.test(token) &&
        (token.match(/[\p{L}]{3,}/gu) !== null) &&
        !STOPWORDS.has(token) &&
        !existing.has(token) &&
        !removedLower.has(token)
    )
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, Math.max(0, Math.min(2, 4 - tags.length)));

  for (const [token] of candidates) {
    tags.push({
      id: `kw:${token}`,
      label: sanitizeText(token, 32),
      source: "keyword",
      reason: sanitizeText(`frequent term "${token}"`, 120)
    });
  }
}

export function categorize(record, ctx = {}) {
  const rec = record && typeof record === "object" ? record : {};
  const rules = ctx.rules != null ? ctx.rules : buildDefaultRules();
  const corrections = ctx.corrections != null ? ctx.corrections : buildDefaultCorrections();
  const tokenize = typeof ctx.tokenize === "function" ? ctx.tokenize : defaultTokenize;
  const removed = corrections && corrections.removed ? corrections.removed : {};
  const added = corrections && corrections.added ? corrections.added : {};

  const title = typeof rec.title === "string" ? rec.title : "";
  const excerpt =
    rec.extraction && typeof rec.extraction.excerpt === "string" ? rec.extraction.excerpt : "";

  const tags = [];

  for (const key of Object.keys(added)) {
    if ((Number(added[key]) || 0) < 1) continue;
    tags.push({
      id: `added:${sanitizeText(key, 32).toLowerCase()}`,
      label: sanitizeText(key, 32),
      source: "rule",
      reason: sanitizeText("tag you added", 120)
    });
  }

  const evaluated = [];
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      evaluated.push(evaluateRule(rule, rec, tokenize));
    }
  }
  evaluated.sort(
    (a, b) =>
      b.rule.priority - a.rule.priority ||
      (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0)
  );

  const picked = [];
  for (const entry of evaluated) {
    if (picked.length >= 3) break;
    if (!entry.matched) continue;
    if (picked.some((p) => p.rule.label === entry.rule.label)) continue;
    picked.push(entry);
  }

  for (const entry of picked) {
    if (removedHas(corrections, entry.rule.label)) continue;
    let reason;
    if (entry.reasonKind === "domain") {
      reason = `domain ${rec.domain} matches ${entry.reasonValue}`;
    } else if (entry.reasonKind === "title") {
      reason = `title contains "${entry.reasonValue}"`;
    } else if (entry.reasonKind === "url") {
      reason = `url matches ${entry.reasonValue}`;
    } else {
      reason = `excerpt contains "${entry.reasonValue}"`;
    }
    tags.push({
      id: `rule:${entry.rule.id}`,
      label: sanitizeText(entry.rule.label, 32),
      source: "rule",
      reason: sanitizeText(reason, 120)
    });
  }

  keywordTags(tags, title, excerpt, { removed }, tokenize);

  return tags;
}

function sumCounts(a, b) {
  const out = {};
  for (const key of Object.keys(a || {})) out[key] = (out[key] || 0) + (Number(a[key]) || 0);
  for (const key of Object.keys(b || {})) out[key] = (out[key] || 0) + (Number(b[key]) || 0);
  return out;
}

export function mergeCorrections(a, b) {
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  return {
    removed: sumCounts(left.removed, right.removed),
    added: sumCounts(left.added, right.added)
  };
}

export function applyCorrection(tags, correction, corrections) {
  const base = corrections && typeof corrections === "object" ? corrections : buildDefaultCorrections();
  const list = Array.isArray(tags) ? tags : [];
  const op = correction && correction.op;
  const label = correction && typeof correction.label === "string" ? correction.label : "";
  const low = label.toLowerCase();
  const removed = { ...(base.removed || {}) };
  const added = { ...(base.added || {}) };

  if (op === "remove" && low) {
    return {
      tags: list.filter((tag) => String((tag && tag.label) || "").toLowerCase() !== low),
      corrections: (() => {
        removed[label] = (Number(removed[label]) || 0) + 1;
        return { removed, added };
      })()
    };
  }

  if (op === "add" && low) {
    const present = list.some((tag) => String((tag && tag.label) || "").toLowerCase() === low);
    if (present) {
      return { tags: [...list], corrections: { removed, added } };
    }
    for (const key of Object.keys(removed)) {
      if (key.toLowerCase() === low) delete removed[key];
    }
    added[label] = (Number(added[label]) || 0) + 1;
    return {
      tags: [
        ...list,
        {
          id: `added:${low}`,
          label: sanitizeText(label, 32),
          source: "rule",
          reason: sanitizeText("tag you added", 120)
        }
      ],
      corrections: { removed, added }
    };
  }

  return { tags: [...list], corrections: { removed, added } };
}
