import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC_DIR = path.join(ROOT, "src");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");

const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (!BINARY_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function collectFiles() {
  const files = [];
  if (existsSync(SRC_DIR)) files.push(...walk(SRC_DIR));
  files.push(MANIFEST_PATH);
  return files;
}

const CALL_PATTERNS = [
  ["fetch()", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["importScripts", /\bimportScripts\b/],
  ["new Image()", /\bnew\s+Image\s*\(/],
  ["location navigation", /\blocation\.(href|assign|replace)\s*[=(]/],
  ["protocol-relative URL", /["'`]\/\/[a-z0-9][a-z0-9.-]+\.[a-z]{2,}/i]
];

const URL_PATTERN = /https?:\/\/(?!w3\.org|www\.w3\.org)/i;

test("no network APIs or remote URLs anywhere in shipped code (src/, manifest.json)", () => {
  const violations = [];
  for (const file of collectFiles()) {
    const rel = path.relative(ROOT, file);
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch (e) {
      violations.push(`${rel}: unreadable (${e.message})`);
      continue;
    }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const isManifest = path.basename(file) === "manifest.json";
      const scanLine = line.replace(/https?:\/\/\*\/[\w*/-]*/g, "");
      for (const [label, pattern] of CALL_PATTERNS) {
        if (pattern.test(scanLine)) violations.push(`${rel}:${idx + 1} forbidden network API ${label} -> ${line.trim().slice(0, 120)}`);
      }
      if (!isManifest && URL_PATTERN.test(scanLine)) {
        violations.push(`${rel}:${idx + 1} forbidden remote URL -> ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.equal(
    violations.length,
    0,
    `Network-access patterns found:\n${violations.join("\n")}`
  );
});

test("manifest permissions are exactly the offline-safe set", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.deepEqual(manifest.permissions, ["tabs", "tabGroups", "storage", "alarms", "scripting", "favicon"]);
});

test("manifest has no required host permissions, web_accessible_resources, or http CSP", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(
    "host_permissions" in manifest,
    false,
    "required host_permissions must be absent; use optional_host_permissions only"
  );
  assert.equal(
    "web_accessible_resources" in manifest,
    false,
    "web_accessible_resources must be absent"
  );
  if (manifest.content_security_policy !== undefined) {
    assert.doesNotMatch(
      JSON.stringify(manifest.content_security_policy),
      /https?:\/\//i,
      "content_security_policy must not reference remote origins"
    );
  }
});

test("optional_host_permissions contains only wildcard http/https patterns", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const optional = manifest.optional_host_permissions || [];
  assert.ok(optional.length > 0, "expected optional host permissions to be declared");
  for (const pattern of optional) {
    assert.match(
      pattern,
      /^https?:\/\/\*\//,
      `optional_host_permissions entry must be an http(s) wildcard, got: ${pattern}`
    );
  }
});
