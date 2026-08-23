# AUDIT.md

Pre-1.0.0 audits were performed by three independent agents that wrote none of the code: a code-quality/safety audit, a privacy/offline-guarantee audit, and a design/accessibility audit judged against DESIGN.md. Findings below are verbatim summaries; each was either fixed (with the fix described) or explicitly accepted with a reason. The suite (`npm test`, 93 tests) and the real-browser gate (`npm run e2e`, 17 checks) were re-run green after every fix round.

## Code-quality audit

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| B1 | blocker | Dashboard sent string tab IDs into `chrome.tabs.remove/group/discard/update`; Chrome rejects non-integer IDs, so close/focus/discard/group from the dashboard failed on real Chrome while all tests passed (fakes don't type-check). | Fixed at the controller message boundary: `tabId` coerced via `Number`, `tabIds` mapped through `Number` + `isFinite` before any handler runs; `actions.js` now sends numbers at source too; `pendingClose` persistence stores integers only. New `tests/integration/stringIds.test.js` drives FOCUS_TAB / CORRECT_TAGS / GROUP_TABS / DISCARD_TABS / CLOSE_TABS→alarm→remove end-to-end using dashboard-style string IDs and asserts the fake received numeric IDs and the real tab closed. |
| M1 | major | Tag corrections existed only in the background; no UI could send `CORRECT_TAGS`, contradicting the README. | Dashboard rows now render removable chips (per-chip × button) and an inline "+ tag" chip that expands to an input; both send `CORRECT_TAGS`, which persists learned corrections. Toasts confirm; storage change re-renders rows. |
| M2 | major | Popup "Enable page reading" set `hostGranted/hostPermissionAvailable=true` even when `permissions.request` resolved `false`, permanently hiding the opt-in after one denial. | The popup now requires a truthy grant before setting any state; denial leaves the button visible. |
| m1 | minor | Search implemented three times with divergent ranking (dashboard lib, omnibox fallback in controller, popup). | Accepted for 1.0 with rationale: the popup's local AND-substring search is deliberately dependency-light for instant cold start; the omnibox path is being consolidated onto `src/lib/searchIndex.js` in a follow-up. Documented here rather than silently divergent. |
| m2 | minor | URL classification duplicated between schema.js and the standalone content script without drift protection. | Extractor now exports its scheme list; new `tests/unit/extractorSchemaParity.test.js` asserts list parity and per-URL classification agreement between `classifySkip` and `classifyUrl`. |
| m3 | minor | Partial multi-step operations lacked compensation (alarm-after-storage ordering, partial grouping results). | Partially fixed: alarm creation failure now surfaces through `lastAlarmError` and the entry is removed on finalize-before-write ordering kept but hydration sanitization (m9) prevents zombie revival; full saga-style rollback deferred — bounded impact, documented. |
| m4 | minor | Any extraction failure was terminal; timeout/pruned rows never recovered, even via "Extract unread". | `eligibility` now admits retryable failures (`injection-failed`) for automatic retry under the existing attempt cap, and **Extract unread** clears failed extractions on web tabs explicitly, so user-triggered retries always work. Exhausted retries settle on honest terminal reasons. |
| m5 | minor | Several swallowed catches hid errors without counters. | Added `counters.lastExtractError` / `lastSummarySkip`; permission revocation and persist failures route through dedicated state fields. Remaining stylistic swallows are best-effort writes whose failure surfaces via the next persist. |
| m6 | minor | Dead code: unused exports/wrappers, duplicate type check, second file input accepting `.md` into a JSON importer. | Removed the `.md` input and its wiring; `exportSessions` now uses `sessionsToJson` from exporters; duplicate type check deleted. Retained intentionally: `duplicateSets` (test/public API), `THEME_BOOTSTRAP_SNIPPET` (single-source reference for the two inline copies), browser API wrappers kept for symmetry of the injectable surface. |
| m7 | minor | Debounced persist could lose the final mutation if the worker died inside the debounce window; failed persist never retried. | Added `runtime.onSuspend` listener flushing pending state immediately; debounced writes remain for churn, terminal states persist within 250 ms. Retry-on-failure deferred: next event re-persists, `lastPersistError` records gaps. |
| m8 | minor | Fake-chrome fidelity gaps (no lastError callback mode, alarms fired manually). | Accepted for 1.0: the callback branch is exercised implicitly by dual-mode call sites; deadline-expiry is covered by the real-browser e2e undo/alarm path. Scheduled follow-up: timer-driven undo test in fakes. |
| m9 | minor | `pendingClose` hydrated unsanitized; corrupt storage broke GET_STATE entirely. | Hydration now validates every batch (string id ≤128, integer tabIds non-empty, finite deadline, object snapshot) and drops invalid entries. |
| m10 | minor | Three messaging styles across layers; dead `#sr-live` element. | Row aria-labels unified through one shared builder (`rowAriaLabel` in uiCommon) used by popup and dashboard. Full wrapper migration for permissions/tabs deferred — boundary normalization (B1) removes the correctness risk that motivated it. |

## Privacy audit

Verdict quoted: *"The zero-network, fully-on-device guarantee is intact as shipped"* — zero network-capable constructs in `src/**`, no `storage.sync`, no external messaging surface, no auto-injected content scripts, fail-closed optional host access, packed artifact contains exactly manifest + local src + local icons.

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| F1 | minor | Stale cached `hostGranted=false` after mid-session grant stalled extraction until worker restart. | `REQUEST_EXTRACT_ALL` now refreshes the permission state before enqueuing; popup/dashboard enable-flows therefore take effect immediately. |
| F2 | minor | No `permissions.onRemoved` handling; revocation left cached state stale (platform still denies injection — fail closed). | `permissions.onRemoved` now clears `hostGranted` and drains the queue, then re-checks. |
| F3 | minor | Static gate bypassable by aliased calls, `new Image().src`, location assignment, protocol-relative URLs; dead `E2E_DIR`; overstated test name. | Gate extended with `new Image()`, `location.href/assign/replace`, and protocol-relative-URL-in-string patterns; scope renamed to "shipped code"; dead constant removed. The gate is documented as a tripwire layered under the runtime behavioral check (e2e asserts zero non-local `performance` resources on popup and dashboard). |
| F4 | note | Extractor hardcodes the 20 000-char cap duplicating schema's constant. | Accepted: the content script must be self-contained (no module imports in classic content-script context); `validateExtractionPayload` independently re-caps, so drift cannot over-store. Parity is covered by the new extractor/schema tests where feasible. |
| F5 | note | No explicit CSP declared (MV3 default applies). | Accepted: default `script-src 'self'` is sufficient; declaring an identical policy adds no enforcement. |
| F6 | note | `favIconUrl` persisted but used only as truthiness flag. | Accepted: harmless local-only retention; dropping it would break nothing but saves bytes — scheduled cleanup. |

## Design/a11y audit

Token tables verified byte-exact against DESIGN.md; contrast table computed for all required pairs in all three themes — **all pass AA** (tightest: light warn 4.72); banned-aesthetics sweep clean (zero gradients/backdrop-filter/emoji/keyframes/shimmer/AI-motif/indigo; box-shadow only on toasts as exempted).

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| D#5 | major | Popup rows rendered no tag chips though DESIGN allocates up to two. | Popup rows now show up to 2 chips + overflow counter, dot-coloured, reason in tooltip. |
| D#8 | major | Help overlay Esc/backdrop paths bypassed focus restore; no focus trap. | All close paths route through `closeHelp()` (restores focus to the trigger); a two-endpoint Tab trap keeps focus inside the dialog while open. Group-menu Esc now also restores trigger focus. |
| D#13 | major | Row aria-label assemblies disagreed between surfaces (dashboard omitted pinned; popup omitted tags). | Single shared `rowAriaLabel(record)` (title, domain, tags, unreadable, audible, discarded, duplicate, pinned) used everywhere; popup passes computed `unreadable`. |
| D#18 | major | Popup footer lacked the DESIGN-mandated "Page reading is off — summaries unavailable." notice beside the enable button. | Notice added, shown/hidden together with the button. |
| D#6 | minor | Filter chips capped at top 4 with no overflow. | Now top 5 per DESIGN. |
| D#14 | minor | "N tabs shown" announced on every store patch. | Announcement fires only when the filter/query identity changes. |
| D#15/16 | minor | Missing `dir="auto"` on query echo and page-derived chip/category labels. | Applied to the no-results note (popup+dashboard), tag-derived filter chips, and row tag chips. |
| D#17 | minor | Header count badge reflowed as digits grew. | Badge gets `min-width:2ch` + tabular numerals. |
| D#19–21 | minor | Copy drift from DESIGN (quota punctuation, bare "Extraction failed", merged empty-state hint). | Verbatim strings restored; unknown/injection reasons use the full "Extraction failed — page unreadable" phrase; empty state split into main line + muted hint. |
| D#4 | minor | Fallback tile letters used accent-contrast on mid-tone dots (sub-AA in light theme). | Tile letter colour switched to the theme foreground token, which clears AA against every palette step. |
| D#22 | note | "Group by ▾" caret baked into accessible name. | Caret wrapped in `aria-hidden` span. |
| D#10/11 | note | Menu arrow-key traversal absent; Space does not activate list rows. | Accepted for 1.0: Enter activation plus roving tabindex covers keyboard operation; arrow-traversal in menus scheduled post-1.0. |

## Verification after fixes

- `npm test`: **93/93** passing (includes new string-ID end-to-end and extractor/schema parity suites).
- `npm run e2e`: **17/17** passing in headless Chrome for Testing — live extraction, summaries, honest failures, duplicates, chips, zero non-local resources at runtime, worker termination/revival persistence, reduced-capability mode, theme flash check, popup instant render.
- Packaging re-verified: release zip contains exactly `manifest.json`, `src/**`, `icons/**`.
