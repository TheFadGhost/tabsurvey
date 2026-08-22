export const THEME_BOOTSTRAP_SNIPPET =
  '(function(){var t=null;try{t=localStorage.getItem("tabsurvey.themeMirror")}catch(e){}if(t!=="light"&&t!=="dark"&&t!=="high-contrast"){try{t=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light"}catch(e){t="light"}}try{document.documentElement.dataset.theme=t}catch(e){}})();';

export function resolveTheme(storedSetting) {
  if (storedSetting === "light" || storedSetting === "dark" || storedSetting === "high-contrast") {
    return storedSetting;
  }
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {}
  return "light";
}

export function applyResolvedTheme(theme) {
  try {
    const concrete = theme === "dark" || theme === "high-contrast" ? theme : "light";
    document.documentElement.dataset.theme = concrete;
  } catch {}
}

export function watchSystemTheme(cb) {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => cb(mq.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => {
      try {
        mq.removeEventListener("change", handler);
      } catch {}
    };
  } catch {}
  return () => {};
}

export function applyThemeSetting(theme) {
  applyResolvedTheme(resolveTheme(theme));
  if (theme === "system") {
    return watchSystemTheme((concrete) => {
      try {
        localStorage.setItem("tabsurvey.themeMirror", concrete);
      } catch {}
      applyResolvedTheme(concrete);
    });
  }
  return () => {};
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    switch (key) {
      case "class":
      case "className":
        node.className = String(value);
        continue;
      case "id":
        node.id = String(value);
        continue;
      case "type":
        node.type = String(value);
        continue;
      case "href":
        node.href = String(value);
        continue;
      case "title":
        node.title = String(value);
        continue;
      case "dir":
        node.dir = String(value);
        continue;
      case "tabIndex":
        node.tabIndex = Number(value);
        continue;
      case "ariaLabel":
        node.setAttribute("aria-label", String(value));
        continue;
      case "dataset":
        for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
        continue;
      case "style":
        for (const [sk, sv] of Object.entries(value)) node.style[sk] = sv;
        continue;
      default:
        break;
    }
    if (key.length > 2 && key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    if (value === true) {
      node.setAttribute(key, "");
      continue;
    }
    if (key in node) {
      try {
        node[key] = value;
      } catch {
        node.setAttribute(key, String(value));
      }
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
      continue;
    }
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
}

export function truncateMiddle(value, max = 64, tailKeep = 18) {
  const text = String(value == null ? "" : value);
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const keep = Math.max(0, Math.min(tailKeep, max - 1));
  const headLen = Math.max(1, max - keep - 1);
  return (
    chars.slice(0, headLen).join("") + "\u2026" + chars.slice(chars.length - keep).join("")
  );
}

export function formatRelative(ts, now = Date.now()) {
  const time = Number(ts);
  if (!Number.isFinite(time) || time <= 0) return "";
  const diff = Math.max(0, now - time);
  if (diff < 60000) return "now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;
  return new Date(time).toISOString().slice(0, 10);
}

export function hashDotIndex(value) {
  const s = String(value == null ? "" : value);
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash % 12) + 1;
}

function tileLetter(source) {
  const chars = Array.from(String(source == null ? "" : source));
  for (const ch of chars) {
    if (/[a-z0-9]/i.test(ch)) return ch.toUpperCase();
  }
  return "?";
}

export function faviconEl(runtimeGetURL, record, size = 16) {
  const rec = record || {};
  const seed = rec.domain || rec.url || "";
  const makeTile = () => {
    const tile = el("div", {
      className: "tile",
      title: rec.domain || "",
      style: {
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.max(8, Math.round(size * 0.55))}px`,
        background: `var(--dot-${hashDotIndex(seed)})`
      }
    });
    tile.setAttribute("aria-hidden", "true");
    tile.textContent = tileLetter(rec.domain || rec.url);
    return tile;
  };
  if (!rec.favIconUrl || typeof runtimeGetURL !== "function") return makeTile();
  let src = "";
  try {
    src = `${runtimeGetURL("/_favicon/")}?pageUrl=${encodeURIComponent(
      String(rec.url || "")
    )}&size=${size}`;
  } catch {
    src = "";
  }
  if (!src) return makeTile();
  const img = el("img", {
    src,
    alt: "",
    width: size,
    height: size,
    decoding: "async",
    draggable: "false"
  });
  img.addEventListener("error", () => img.replaceWith(makeTile()));
  return img;
}

const GLYPH_PATHS = {
  audible: [
    "M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z",
    "M15 9.2a4 4 0 0 1 0 5.6",
    "M17.6 7a7.2 7.2 0 0 1 0 10"
  ],
  discarded: ["M20.4 13.2A8.4 8.4 0 1 1 10.8 3.6a6.6 6.6 0 0 0 9.6 9.6"],
  duplicate: [
    "M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
    "M5 15c-.6 0-1-.4-1-1V5c0-.6.4-1 1-1h9c.6 0 1 .4 1 1"
  ],
  pinned: [
    "M12 16.5V21",
    "M8.5 3h7l-.8 6.4 2.8 2.8V14H6.5v-1.8l2.8-2.8L8.5 3z"
  ]
};

const SVG_NS = "http://www.w3.org/2000/svg";

function glyphSvg(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of GLYPH_PATHS[kind]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

export function stateGlyphs(record) {
  const out = [];
  try {
    if (typeof document === "undefined") return out;
    const rec = record || {};
    const marks = [];
    if (rec.audible) marks.push(["audible", "Audible tab"]);
    if (rec.discarded) marks.push(["discarded", "Discarded tab"]);
    if (rec.duplicateOf != null) marks.push(["duplicate", "Duplicate tab"]);
    if (rec.pinned) marks.push(["pinned", "Pinned tab"]);
    if (marks.length === 0) return out;
    const holder = el("span", { className: "row__glyphs" });
    for (const [kind, label] of marks) {
      const glyph = el("span", { className: "row__glyph", title: label });
      glyph.appendChild(glyphSvg(kind));
      glyph.appendChild(el("span", { className: "visually-hidden" }, label.toLowerCase()));
      holder.appendChild(glyph);
    }
    out.push(holder);
  } catch {}
  return out;
}

let liveRegion = null;
let liveTimer = 0;

export function announce(text) {
  try {
    if (typeof document === "undefined" || !document.body) return;
    if (!liveRegion || !liveRegion.isConnected) {
      liveRegion = document.getElementById("ts-live");
      if (!liveRegion) {
        liveRegion = el("p", { id: "ts-live", className: "visually-hidden" });
        liveRegion.setAttribute("aria-live", "polite");
        liveRegion.setAttribute("role", "status");
        document.body.appendChild(liveRegion);
      }
    }
    liveRegion.textContent = String(text == null ? "" : text);
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (liveRegion) liveRegion.textContent = "";
    }, 1000);
  } catch {}
}

export function debounce(fn, ms = 100) {
  let timer = 0;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      fn.apply(this, args);
    }, ms);
  };
}

const COLD_ERROR = /receiving end|could not establish|no receiver|message port|context invalidated|no-runtime/i;

export function message(type, payload = {}) {
  const send = () =>
    new Promise((resolve, reject) => {
      try {
        if (
          typeof chrome === "undefined" ||
          !chrome.runtime ||
          typeof chrome.runtime.sendMessage !== "function"
        ) {
          reject(new Error("Tabsurvey: no runtime"));
          return;
        }
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message || "send-failed"));
          else resolve(response === undefined ? null : response);
        });
      } catch (err) {
        reject(err);
      }
    });
  return send().catch(async (first) => {
    if (!COLD_ERROR.test(String(first && first.message))) throw first;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return send().catch((second) => {
      if (COLD_ERROR.test(String(second && second.message))) return null;
      throw second;
    });
  });
}

export async function storageGet(keys) {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return {};
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    } catch {
      resolve({});
    }
  });
}

export async function storageSet(obj) {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return false;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => resolve(!chrome.runtime.lastError));
    } catch {
      resolve(false);
    }
  });
}

export function storageOnChanged(cb) {
  try {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) {
      return () => {};
    }
    const listener = (changes, area) => cb(changes || {}, area || "local");
    chrome.storage.onChanged.addListener(listener);
    return () => {
      try {
        chrome.storage.onChanged.removeListener(listener);
      } catch {}
    };
  } catch {}
  return () => {};
}

export function openDashboard() {
  try {
    if (typeof chrome === "undefined" || !chrome.tabs || !chrome.runtime) {
      return Promise.resolve(null);
    }
    return Promise.resolve(
      chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html") })
    );
  } catch {
    return Promise.resolve(null);
  }
}
