(function () {
  "use strict";

  const MAX_CHARS = 20000;
  const MAX_HEADINGS = 12;
  const MIN_TOTAL_CHARS = 280;
  const IMAGE_ONLY_MAX_CHARS = 80;
  const PAYWALL_MAX_CHARS = 600;
  const MIN_BLOCK_CHARS = 25;
  const DIV_DIRECT_MIN = 40;
  const ACCRUE_DEPTH = 4;
  const ROOT_MIN_SHARE = 0.45;
  const HEADING_MAX_CHARS = 200;
  const META_MAX_CHARS = 300;

  const INTERNAL_SCHEMES = [
    "chrome:", "edge:", "about:", "chrome-extension:", "moz-extension:",
    "devtools:", "view-source:", "browser:", "opera:", "vivaldi:", "brave:"
  ];
  const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
  const PDF_TAIL_RE = /\.pdf$/i;
  const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  const NOISE_RE = /(cookie|consent|gdpr|cmp|newsletter|subscribe|subscription|paywall|premium-wall|promo|advert|ads?[-_]|social[-_]share|share[-_]buttons|breadcrumb|related[-_]?posts|comments?[-_]?section|sidebar|banner|modal|overlay|popup|tooltip)/i;
  const PAYWALL_RE = /paywall|premium-wall/i;
  const PRUNE_SELECTOR = "script,style,noscript,template,svg,canvas,iframe,object,embed,form,button,select,input,textarea,nav,footer,aside";
  const PRUNE_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED",
    "FORM", "BUTTON", "SELECT", "INPUT", "TEXTAREA", "NAV", "FOOTER", "ASIDE"
  ]);
  const HARVEST_SELECTOR = "p,blockquote,li,pre,div";
  const BLOCK_CHILD_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIV", "DL", "DT", "DD",
    "FIGURE", "FIGCAPTION", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
    "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "UL"
  ]);
  const ROOT_SELECTORS = ["article", "main", '[role="main"]', "#content", ".post", ".article"];

  function collapse(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function stripControls(value) {
    return String(value == null ? "" : value).replace(CONTROL_RE, "");
  }

  function clean(value) {
    return collapse(stripControls(value));
  }

  function capChars(value, max) {
    const chars = Array.from(value);
    if (chars.length <= max) return value;
    return chars.slice(0, max).join("");
  }

  function classifySkip(url) {
    if (typeof url !== "string" || url.length === 0) return "internal";
    const trimmed = url.trim();
    const match = SCHEME_RE.exec(trimmed);
    if (!match) return "internal";
    const scheme = match[1].toLowerCase() + ":";
    if (INTERNAL_SCHEMES.includes(scheme)) return "internal";
    if (scheme === "file:") return "file";
    if (scheme === "http:" || scheme === "https:") {
      const rest = trimmed.slice(match[0].length);
      const hashIndex = rest.indexOf("#");
      const beforeHash = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
      const queryIndex = beforeHash.indexOf("?");
      const path = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
      const query = queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1);
      if (PDF_TAIL_RE.test(path)) return "pdf";
      if (query.length > 0) {
        const pairs = query.split("&");
        for (let i = 0; i < pairs.length; i++) {
          const eq = pairs[i].indexOf("=");
          const value = eq === -1 ? "" : pairs[i].slice(eq + 1);
          if (PDF_TAIL_RE.test(value)) return "pdf";
        }
      }
      return null;
    }
    return null;
  }

  function markOf(el) {
    const cls = typeof el.className === "string" ? el.className : "";
    return cls + " " + (el.id || "");
  }

  function hasOwnHeading(el) {
    return Boolean(el.querySelector("h1,h2,h3"));
  }

  function prune(clone) {
    const doomed = [];
    const tagged = clone.querySelectorAll(PRUNE_SELECTOR);
    for (let i = 0; i < tagged.length; i++) doomed.push(tagged[i]);
    const all = clone.querySelectorAll("*");
    for (let j = 0; j < all.length; j++) {
      const el = all[j];
      const tag = el.tagName;
      if (PRUNE_TAGS.has(tag)) continue;
      if (tag === "HEADER") {
        if (NOISE_RE.test(markOf(el)) || !hasOwnHeading(el)) doomed.push(el);
        continue;
      }
      if (NOISE_RE.test(markOf(el))) doomed.push(el);
    }
    for (let k = 0; k < doomed.length; k++) {
      const el = doomed[k];
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    const remaining = clone.querySelectorAll("*");
    for (let m = remaining.length - 1; m >= 0; m--) {
      const el = remaining[m];
      if (!el.parentNode) continue;
      if (collapse(el.textContent).length === 0 && el.parentNode) el.parentNode.removeChild(el);
    }
  }

  function isHarvestableDiv(el) {
    let direct = 0;
    const children = el.childNodes;
    let node;
    for (let i = 0; i < children.length; i++) {
      node = children[i];
      if (node.nodeType === 3) direct += collapse(node.nodeValue).length;
    }
    if (direct <= DIV_DIRECT_MIN) return false;
    for (let j = 0; j < children.length; j++) {
      node = children[j];
      if (node.nodeType === 1 && BLOCK_CHILD_TAGS.has(node.tagName)) return false;
    }
    return true;
  }

  function scoreBlock(el, text) {
    let linked = 0;
    const anchors = el.getElementsByTagName("a");
    for (let i = 0; i < anchors.length; i++) linked += collapse(anchors[i].textContent).length;
    const density = text.length > 0 ? Math.min(1, linked / text.length) : 1;
    let commas = 0;
    for (const ch of text) {
      if (ch === ",") commas++;
    }
    return text.length * (1 - density) * (1 - density) + Math.min(commas, 6) * 0.5;
  }

  function harvest(clone, state) {
    const candidates = clone.querySelectorAll(HARVEST_SELECTOR);
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const tag = el.tagName;
      if (tag === "DIV") {
        if (!isHarvestableDiv(el)) continue;
      } else if (tag === "LI" && el.querySelector("ul,ol")) {
        continue;
      }
      const text = clean(el.textContent);
      if (text.length < MIN_BLOCK_CHARS) continue;
      if (state.seen.has(text)) continue;
      const score = scoreBlock(el, text);
      state.blocks.push({ el, text, score });
      state.seen.add(text);
      let node = el.parentElement;
      for (let depth = 0; depth < ACCRUE_DEPTH && node; depth++) {
        state.scores.set(node, (state.scores.get(node) || 0) + score);
        node = node.parentElement;
      }
    }
  }

  function subtreeScore(rootEl, blocks) {
    let sum = 0;
    for (const block of blocks) {
      if (rootEl.contains(block.el)) sum += block.score;
    }
    return sum;
  }

  function chooseRoot(clone, state) {
    let total = 0;
    for (const block of state.blocks) total += block.score;
    if (!(total > 0)) return null;
    for (const selector of ROOT_SELECTORS) {
      let found = null;
      try {
        found = clone.querySelector(selector);
      } catch (error) {
        found = null;
      }
      if (found && subtreeScore(found, state.blocks) >= total * ROOT_MIN_SHARE) return found;
    }
    let best = null;
    let bestScore = 0;
    state.scores.forEach((value, key) => {
      if (value > bestScore) {
        bestScore = value;
        best = key;
      }
    });
    return best;
  }

  function joinText(scopeEl, blocks) {
    const parts = [];
    for (const block of blocks) {
      if (scopeEl.contains(block.el)) parts.push(block.text);
    }
    if (parts.length === 0) {
      for (const block of blocks) parts.push(block.text);
    }
    return capChars(stripControls(parts.join("\n\n")), MAX_CHARS);
  }

  function collectHeadings(scopeEl, title) {
    const out = [];
    if (!scopeEl) return out;
    const nodes = scopeEl.querySelectorAll("h1,h2,h3");
    const seen = new Set();
    for (let i = 0; i < nodes.length && out.length < MAX_HEADINGS; i++) {
      const value = capChars(clean(nodes[i].textContent), HEADING_MAX_CHARS);
      if (!value) continue;
      if (title && value === title) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }

  function findDescription(doc) {
    const metas = doc.querySelectorAll("meta");
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      const name = (meta.getAttribute("name") || "").toLowerCase();
      const property = (meta.getAttribute("property") || "").toLowerCase();
      if (name === "description" || property === "og:description") {
        return capChars(clean(meta.getAttribute("content")), META_MAX_CHARS);
      }
    }
    return "";
  }

  function hasPaywallSignal(doc) {
    const nodes = doc.querySelectorAll("[class],[id]");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const cls = typeof el.className === "string" ? el.className : "";
      if (PAYWALL_RE.test(cls) || PAYWALL_RE.test(el.id || "")) return true;
    }
    return false;
  }

  function extractFromDom(doc) {
    if (!doc) return { status: "failed", reason: "unknown" };
    const title = capChars(clean(doc.title), META_MAX_CHARS);
    const description = findDescription(doc);
    const clone = doc.body ? doc.body.cloneNode(true) : null;
    if (clone) prune(clone);
    const state = { scores: new Map(), blocks: [], seen: new Set() };
    if (clone) harvest(clone, state);
    const root = chooseRoot(clone, state);
    const scopeEl = root || clone;
    const text = scopeEl ? joinText(scopeEl, state.blocks) : "";
    const headings = collectHeadings(scopeEl, title);
    const totalChars = Array.from(text).length;

    if (hasPaywallSignal(doc) && totalChars < PAYWALL_MAX_CHARS) {
      return { status: "failed", reason: "paywall-stub" };
    }
    if (totalChars < IMAGE_ONLY_MAX_CHARS && doc.getElementsByTagName("img").length >= 2) {
      return { status: "failed", reason: "image-only" };
    }
    if (totalChars < MIN_TOTAL_CHARS) {
      return { status: "failed", reason: "too-little-text" };
    }
    return {
      status: "ok",
      reason: "",
      text,
      headings,
      description,
      title,
      url: doc.location ? capChars(stripControls(String(doc.location.href)), 4096) : ""
    };
  }

  const api = { classifySkip, extractFromDom, INTERNAL_SCHEMES };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== "undefined") {
    globalThis.TabsurveyExtractor = api;
  }
  if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
    const runOnce = () => {
      try {
        return extractFromDom(document);
      } catch (error) {
        return { status: "failed", reason: "unknown" };
      }
    };
    try {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.type !== "EXTRACT_NOW") return undefined;
        Promise.resolve().then(runOnce).then(
          (result) => { try { sendResponse({ type: "TABSURVEY_EXTRACTION", payload: result }); } catch (e) {} },
          () => { try { sendResponse({ type: "TABSURVEY_EXTRACTION", payload: { status: "failed", reason: "unknown" } }); } catch (e) {} }
        );
        return true;
      });
    } catch (error) {}
    try {
      chrome.runtime.sendMessage({ type: "TABSURVEY_EXTRACTION", payload: runOnce() });
    } catch (error) {}
  }
})();
