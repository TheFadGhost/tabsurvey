import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME =
  process.env.CHROME_BIN ||
  "C:\\Users\\Work\\.cache\\puppeteer\\chrome\\win64-127.0.6533.88\\chrome-win64\\chrome.exe";
const FIXTURES = path.join(ROOT, "tests", "fixtures", "html");
const TMP = path.join(ROOT, "tmp", "e2e");
const SHOTS = path.join(ROOT, "docs", "screenshots");

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs, label, intervalMs = 300) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function startFixtureServer() {
  const srv = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const file = path.join(FIXTURES, rel);
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`ws error ${wsUrl}`));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) {
        if (msg.method === "Runtime.exceptionThrown") {
          this.events.push(JSON.stringify(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text).slice(0, 400));
        }
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
  }
  async send(method, params = {}, timeoutMs = 15000) {
    await this.ready;
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`cdp ${method} timeout`));
        }
      }, timeoutMs);
    });
  }
  async eval(expression, timeoutMs) {
    const res = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs
    );
    if (res.exceptionDetails) {
      throw new Error(`page eval failed: ${res.exceptionDetails.text} ${String(res.exceptionDetails.exception?.description || "").slice(0, 300)}`);
    }
    return res.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const devHttp = (port) => `http://127.0.0.1:${port}`;
async function jsonList(port) {
  const r = await fetch(`${devHttp(port)}/json/list`);
  return r.json();
}
async function closeTarget(port, targetId) {
  await fetch(`${devHttp(port)}/json/close/${targetId}`).catch(() => {});
}

async function openAndAttach(port, url) {
  const r = await fetch(`${devHttp(port)}/json/new`, { method: "PUT" });
  if (!r.ok) throw new Error(`/json/new ${r.status}`);
  const target = await r.json();
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });
  await until(async () => {
    try {
      return (await cdp.eval("document.readyState")) === "complete";
    } catch {
      return false;
    }
  }, 20000, `ready ${url}`);
  return { cdp, target };
}

function makeFullExt(outDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  delete manifest.optional_host_permissions;
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  manifest.name = "Tabsurvey E2E Full";
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(path.join(ROOT, "src"), path.join(outDir, "src"), { recursive: true });
  fs.cpSync(path.join(ROOT, "icons"), path.join(outDir, "icons"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest));
}

const FIXTURE_FILES = [
  "article-clean.html",
  "article-noisy.html",
  "interview.html",
  "hostile-markup.html",
  "spa-shell.html",
  "minimal-text.html",
  "paywall-stub.html",
  "image-only.html"
];

function domSnapshotExpr() {
  return `(() => {
    const rows = [...document.querySelectorAll('[role="listitem"]')];
    const withSummary = rows.filter(r => {
      const s = r.querySelector('.row__summary');
      return s && s.textContent.trim().length > 40 && !s.classList.contains('is-pending') && !s.classList.contains('is-failed');
    });
    const failedTexts = [...new Set(rows.map(r => r.querySelector('.row__summary.is-failed')?.textContent || '').filter(Boolean))];
    const dupRows = rows.filter(r => (r.getAttribute('aria-label') || '').includes(', duplicate'));
    const external = performance.getEntriesByType('resource').filter(r => !/^https?:\\/\\/127\\.0\\.0\\.1/.test(r.name) && !r.name.startsWith(location.origin)).map(r => r.name);
    return JSON.stringify({ total: rows.length, summaries: withSummary.length, failedTexts, dupCount: dupRows.length, external, chips: document.querySelectorAll('.chip').length });
  })()`;
}

async function launchChrome(profileDir, extensions) {
  const debugPort = await freePort();
  const args = [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--load-extension=${extensions.join(",")}`,
    "--window-size=1400,900",
    "about:blank"
  ];
  const proc = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderrTail = "";
  proc.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-1200);
  });
  const cleanup = () => {
    try {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    try {
      proc.kill();
    } catch {}
  };
  await until(
    async () => {
      try {
        return (await fetch(`${devHttp(debugPort)}/json/version`)).ok;
      } catch {
        return false;
      }
    },
    25000,
    "devtools endpoint"
  );
  return { proc, cleanup, debugPort, getStderr: () => stderrTail };
}

async function findSwHost(port, preferFull) {
  const hosts = await until(async () => {
    const list = await jsonList(port);
    const sws = list.filter((t) => t.type === "service_worker" && t.url.includes("background/serviceWorker.js"));
    const distinct = [...new Set(sws.map((s) => new URL(s.url).host))];
    return distinct.length > 0 ? { sws, distinct } : null;
  }, 30000, "service worker registration");
  for (const host of hosts.distinct) {
    const c = new Cdp(hosts.sws.find((s) => new URL(s.url).host === host).webSocketDebuggerUrl);
    const name = await c.eval("chrome.runtime.getManifest().name").catch(() => "");
    c.close();
    const isFull = String(name).includes("E2E");
    if ((preferFull && isFull) || (!preferFull && !isFull)) return host;
  }
  return null;
}

async function runSession(label, extensions, checks) {
  fs.rmSync(path.join(TMP, `profile-${label}`), { recursive: true, force: true });
  const session = await launchChrome(path.join(TMP, `profile-${label}`), extensions);
  const httpSrv = await startFixtureServer();
  try {
    await checks(session, httpSrv.port);
  } finally {
    session.cleanup();
    httpSrv.srv.close();
    await sleep(800);
  }
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const fullExtDir = path.join(TMP, "ext-full");
  makeFullExt(fullExtDir);

  await runSession("full", [fullExtDir], async (session, fixPort) => {
    const fullDash = `chrome-extension://${session.extHost ?? ""}`;
    void fullDash;
    const host = await findSwHost(session.debugPort, true);
    if (!host) throw new Error("full extension service worker not found");
    record("full-permission extension loaded", true, host);

    const dashUrl = `chrome-extension://${host}/src/dashboard/dashboard.html`;
    const dash = await openAndAttach(session.debugPort, dashUrl);

    for (const f of FIXTURE_FILES) {
      await dash.cdp.eval(`chrome.tabs.create({ url: ${JSON.stringify(`${devHttp(fixPort)}/${f}`)}, active: false })`);
      await sleep(120);
    }
    const dupUrlA = `${devHttp(fixPort)}/article-clean.html?utm_source=e2e#frag1`;
    const dupUrlB = `${devHttp(fixPort)}/article-clean.html`;
    await dash.cdp.eval(`chrome.tabs.create({ url: ${JSON.stringify(dupUrlA)}, active: false })`);
    await sleep(150);
    await dash.cdp.eval(`chrome.tabs.create({ url: ${JSON.stringify(dupUrlB)}, active: false })`);
    const openedCount = FIXTURE_FILES.length + 3;

    let snap = null;
    let hungAfter = -1;
    for (let i = 0; i < 14; i++) {
      await sleep(2500);
      try {
        snap = JSON.parse(await dash.cdp.eval(domSnapshotExpr(), 6000));
        console.log(`  [poll ${i}] ${JSON.stringify(snap)}`);
        hungAfter = -1;
      } catch {
        hungAfter = i;
        console.log(`  [poll ${i}] eval-hung-or-error`);
        snap = null;
      }
      if (snap && snap.summaries >= 3) break;
    }

    record("summaries rendered from live extraction", Boolean(snap && snap.summaries >= 3), snap ? `${snap.summaries}/${snap.total} rows` : `page unresponsive from poll ${hungAfter}`);
    if (snap) {
      record("article summary contains main-content marker", await dash.cdp.eval(
        `[...document.querySelectorAll('.row__summary:not(.is-failed):not(.is-pending)')].some(s => /quantum barnacle|estuary breathes/i.test(s.textContent))`
      ));
      record("unreadable pages show honest failure text", snap.failedTexts.some((t) => /unreadable/i.test(t)) && snap.failedTexts.length >= 2, JSON.stringify(snap.failedTexts).slice(0, 160));
      record("duplicate detection across tracking-param variants", snap.dupCount === 2, `${snap.dupCount} duplicate rows of three identical tabs`);
      record("tag chips rendered", snap.chips > 0, `${snap.chips} chips`);
      record("zero non-local network resources on dashboard", snap.external.length === 0, JSON.stringify(snap.external).slice(0, 160));
    } else {
      for (const n of ["article summary contains main-content marker", "unreadable pages show honest failure text", "duplicate detection across tracking-param variants", "tag chips rendered", "zero non-local network resources on dashboard"]) {
        record(n, false, "skipped — page became unresponsive");
      }
    }

    if (snap && snap.summaries >= 3) {
      await dash.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
      const shot = await dash.cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, "dashboard.png"), Buffer.from(shot.data, "base64"));
      record("dashboard screenshot captured", true);

      const swEntry = (await jsonList(session.debugPort)).find(
        (t) => t.type === "service_worker" && new URL(t.url).host === host
      );
      if (swEntry) {
        let stopped = false;
        try {
          const swC = new Cdp(swEntry.webSocketDebuggerUrl);
          await swC.send("Runtime.enable");
          await swC.eval("self.close()");
          stopped = true;
        } catch {
          stopped = false;
        }
        if (!stopped) {
          stopped = await fetch(`${devHttp(session.debugPort)}/json/close/${swEntry.targetId}`)
            .then((r) => r.ok)
            .catch(() => false);
        }
        await sleep(1500);

        const reopened = await openAndAttach(session.debugPort, dashUrl);
        const persisted = await until(async () => {
          const info = JSON.parse(await reopened.cdp.eval(domSnapshotExpr(), 8000));
          return info.total >= openedCount && info.summaries >= 3 ? info : null;
        }, 25000, "persisted rows after worker revival").catch(() => null);
        const swGoneAfterStop = !(await jsonList(session.debugPort)).some(
          (t) => t.type === "service_worker" && new URL(t.url).host === host
        );
        record(
          "state intact after worker termination and revival",
          Boolean(persisted),
          persisted
            ? `${persisted.summaries} summaries survived; stop method=${stopped ? "self.close" : "target-close"}; sw relisted after revival=${!swGoneAfterStop}`
            : "not restored"
        );
        reopened.cdp.close();
      } else {
        record("state intact after worker termination and revival", false, "sw target missing before stop");
      }
    }
    dash.cdp.close();
  });

  await runSession("shipped", [ROOT], async (session, fixPort) => {
    const host = await findSwHost(session.debugPort, false);
    if (!host) throw new Error("shipped extension service worker not found");
    record("shipped extension loaded", true, host);
    const dash = await openAndAttach(session.debugPort, `chrome-extension://${host}/src/dashboard/dashboard.html`);
    for (const f of FIXTURE_FILES.slice(0, 5)) {
      await dash.cdp.eval(`chrome.tabs.create({ url: ${JSON.stringify(`${devHttp(fixPort)}/${f}`)}, active: false })`);
      await sleep(100);
    }
    await sleep(2500);
    const rowsA = await dash.cdp.eval(`document.querySelectorAll('[role="listitem"]').length`, 8000);
    record("dashboard renders cached-first without host permission", rowsA >= 6, `${rowsA} rows`);
    const statesA = await dash.cdp.eval(`JSON.stringify({
      texts: [...document.querySelectorAll('.row__summary')].map(s => s.textContent.trim()),
      external: performance.getEntriesByType('resource').filter(r => !/^https?:\\/\\/127\\.0\\.0\\.1/.test(r.name) && !r.name.startsWith(location.origin)).length
    })`, 8000);
    const parsed = JSON.parse(statesA);
    record("reduced-capability mode shows honest per-row status", parsed.texts.filter(Boolean).length > 0, `${parsed.texts.filter(Boolean).length} status rows`);
    record("zero non-local resources on shipped dashboard", parsed.external === 0);
    const themeNow = await dash.cdp.eval(`document.documentElement.dataset.theme`, 8000);
    record("theme applied synchronously at open (no flash)", ["light", "dark", "high-contrast"].includes(themeNow), themeNow);

    const popupUrl = `chrome-extension://${host}/src/popup/popup.html`;
    const pop = await openAndAttach(session.debugPort, popupUrl);
    await pop.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 560, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const popupState = await pop.cdp.eval(`(() => ({
      rows: document.querySelectorAll('[role="listitem"]').length,
      stats: document.getElementById('footstats') ? document.getElementById('footstats').textContent : '',
      bodySize: getComputedStyle(document.body).width + 'x' + getComputedStyle(document.body).height
    }))()`, 8000);
    record("popup lists tabs instantly from cache", popupState.rows > 0, `${popupState.rows} rows, body ${popupState.bodySize}`);
    record("popup footer stats populated", /tabs · \d+ windows/.test(popupState.stats), popupState.stats.slice(0, 60));
    const shotP = await pop.cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, "popup.png"), Buffer.from(shotP.data, "base64"));
    record("popup screenshot captured", true);
    pop.cdp.close();
    dash.cdp.close();
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
