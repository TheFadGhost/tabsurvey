# PLAN.md

Feature ideation record. Each idea was judged against three tests:

1. Does it serve the core purpose: understanding and organizing currently open tabs?
2. Can it be finished to the same quality bar as the rest of the product?
3. Does it avoid expanding scope into a second product (bookmark manager with sync, read-later service, full-text archive, cross-device account system)?

## Accepted (first-class features)

| Idea | Reason |
|---|---|
| Onboarding card explaining that everything is local | Trust in the offline claim is part of the product; one static card, cheap to finish well. |
| Keyboard shortcuts: popup action key, `Alt+Shift+S` opens dashboard, `/` focuses search, `j/k` navigation, `?` help overlay | Core audience (heavy tab users) lives on the keyboard; small surface. |
| Omnibox keyword `ts` searching the local index | Zero new permissions, direct path to the core search feature. |
| Per-domain extraction opt-out | Extraction quality varies; user control keeps summaries trustworthy. |
| Summary length setting (short / medium / long) | Same engine, three cut points; honest control over output size. |
| Export full inventory as Markdown; session import/export as JSON | Exit safety for saved sessions and inventory; no server involved. |
| Light / dark / high-contrast themes with system-follow option, no flash on open | Dashboard is a reading surface; theme correctness is expected baseline. |
| Accessibility pass: list semantics, announced tab states, focus-visible rings, shortcut overlay | The dashboard replaces visual scanning; it must be operable without sight or mouse. |
| Explicit per-tab failure states (blocked scheme, PDF, SPA shell, paywall stub, no host permission) | Honest failures replace fake summaries; core to credibility. |
| Undo window (8 s) before bulk close or session close finalize | Destructive bulk actions need reversibility; implemented with alarms so it survives worker death. |
| Duplicate detection with tracking-parameter and fragment normalization | Directly serves "what do I actually have"; cheap and deterministic. |
| Middle-out truncation with domain always visible | Titles are pathological in the wild; the domain is the anchor users scan for. |

## Rejected

| Idea | Reason |
|---|---|
| Bookmark management, bookmark tagging, sync | Second product (bookmark manager). |
| Read-later queue / archive of visited pages | Second product; also unbounded storage growth. |
| Cross-device session sync or accounts | Second product; would break the no-network story. |
| Any remote summarization fallback | Violates the core guarantee; there is no fallback, ever. |
| Bundled neural model for abstractive summaries | Tens of MB shipped for marginal gain over deterministic extractive scoring; extractive output is auditable sentence-by-sentence. |
| Telemetry or analytics, even opt-in | Contradicts the privacy promise; nothing to learn that tests cannot measure. |
| CDN fonts, icon CDNs, remote images | Every remote request is a defect; favicons come from the browser's own cache via `_favicon`. |
| ML auto-clustering of tabs into groups | Uninspectable; rules with visible reasons and corrections serve the same goal honestly. |
| Reading-time estimates, word counts, "productivity scores" | Clutter with no organizing value. |
| Notes/annotations on tabs | Drift toward bookmark manager. |
| Import from third-party session managers | Integration surface of another product. |
| Auto-discard idle tabs on a timer | Surprising destructive behaviour; discarding stays user-driven. |
