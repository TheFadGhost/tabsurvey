# DESIGN.md

The UI is built to this document. Deviations are defects.

## Point of view

Tabsurvey should feel like it was shipped by the browser vendor: a precise, dense, quiet utility that belongs beside the address bar. It borrows the visual language of browser chrome — flat raised surfaces, hairline borders, a single restrained accent, system fonts — and refuses the aesthetics of consumer AI: no gradients, no glass, no sparkles, no chat voice, no animated text. Information density is the feature; every pixel of the popup is rationed and the dashboard reads like a well-set index page. Motion exists only to confirm an action (≤120 ms fades), never to perform. When the system cannot know something — a page it could not read, a summary it is unsure of — it says so in plain text rather than decorating around the gap.

## Surfaces

### Popup — fixed 380 × 560 px

Chrome renders popups at their content size; this popup declares `body { width: 380px; height: 560px; overflow: hidden }`. Internal regions scroll, the frame does not.

| Region | Height | Contents |
|---|---|---|
| Header | 44 px | App name (13 px semibold), total-tab count badge, settings gear → dashboard settings section. |
| Search row | 36 px | Search input (searches titles, URLs, tags, summaries locally). |
| Filter chips | 32 px | Horizontal scrollable chips: All / Duplicates / Audible / Unreadable / per-category (top 5 by count) + "+n". |
| Tab list | flexible, scrolls | Compact rows. |
| Footer | 28 px | Counts ("42 tabs · 3 windows · 2 duplicates"), link "Open dashboard". |

What earns space in the popup: search, filters, tab identity, state, up to two tag chips, one line of summary status. What belongs only in the dashboard: bulk action toolbar, session management, settings editors, full summaries, markdown export.

### Dashboard

Full extension tab (`dashboard.html`). Three-region layout: header (search, sort select, actions toolbar), left sidebar 220 px (categories with counts, states, windows/groups, sessions list), main list. Collapses to single column below 720 px viewport width (sidebar becomes a disclosure); comfortable at any width above.

### Tab row anatomy

Grid: `16px favicon | 1fr text | auto meta`, min-height 44 px (popup) / 56 px (dashboard), padding-inline 12 px, hairline bottom border, no card shadow, no rounded card per row.

- **Favicon** 16×16 from `_favicon`; on miss, first letter tile using the tag palette hue for the domain.
- **Title**: one line, `truncateMiddle(title, 64)` — keeps head and tail so extensions like `.pdf` and trailing markers survive; `title` attribute carries the full string.
- **Domain**: 11 px muted, always rendered as its own element and never truncated away; `dir="auto"`.
- **Summary excerpt (dashboard)**: exactly 2 lines reserved (`min-height: 34px` fixed regardless of state) so nothing shifts when text arrives asynchronously.
- **Tag chips**: see below.
- **State indicators**: inline SVG glyphs after the meta column — speaker (audible), moon-pause (discarded), copy glyph (duplicate, tooltip names its primary), pin. Each has visually-hidden text so screen readers announce state.

### Tag chip system

Chip = 6 px colour dot + label, height 18 px, padding-inline 6 px, radius 9 px, font 11 px, background `--chip-bg`, border hairline. Colour lives **only in the dot**; label text is always `--fg` on `--chip-bg`, so AA contrast holds for every tag in every theme independent of hue. A tab shows at most 3 chips plus a `+N` counter chip; overflow never wraps (container `white-space: nowrap; overflow: hidden`). With five tags the row stays one line tall. Adjacent dots alternate lightness steps so deuteranopic users can distinguish neighbours even before reading labels.

## Summary presentation (honesty rules)

- Pending extraction: muted italic "Reading page…" in the reserved area.
- Extraction failed: danger-tinted plain text stating the reason verbatim from the extractor (`Extraction failed — page unreadable`, `Blocked: internal browser page`, `Skipped: PDF`, `No host permission granted`, `Skipped: excluded domain`).
- Low confidence (short/thin source text): abstract shown, prefixed with a bordered `low confidence` mini-badge. Never silently presented as if certain.
- No empty boxes, no spinners larger than a 12 px glyph, no shimmer.

## Type and spacing

- Font stack: `"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif` (system fonts only; zero remote fonts).
- Scale: 15 px dashboard headings · 13 px base UI · 12 px secondary · 11 px meta/chips. Line-height 1.35 (dense surfaces).
- Spacing scale: 4 / 8 / 12 / 16 / 24. Row padding-block 8 px. Section gaps 16 px.
- Focus ring: 2 px `--focus` outline, 2 px offset, `:focus-visible` only.

## Colour tokens by role (CSS custom properties)

Roles, not decorations: `bg` page, `raised` bars/toolbars, `inset` wells/inputs, `fg` primary text, `muted` secondary text, `faint` decorative-only, `border`/`border-strong` hairlines, `accent` interactive + focus, `accent-contrast` text on accent, `danger`, `ok`, `warn`, `chip-bg`, plus `dot-1…dot-12` tag hues and `focus`.

| Token | Light | Dark | High-contrast |
|---|---|---|---|
| bg | #f7f7f8 | #131417 | #ffffff |
| raised | #ffffff | #1b1d21 | #ffffff |
| inset | #ececee | #23262b | #f0f0f0 |
| fg | #17181c | #e8eaed | #000000 |
| muted | #5f6368 | #a2a7ae | #333333 |
| faint | #6e7278 | #7c8188 | #4d4d4d |
| border | #d9dadd | #33363c | #000000 |
| border-strong | #b6b8bd | #4a4e55 | #000000 |
| accent | #0b57d0 | #8ab4f8 | #002d7a |
| accent-contrast | #ffffff | #0b1220 | #ffffff |
| danger | #b3261e | #f28b82 | #a30000 |
| ok | #146c2e | #81c995 | #006400 |
| warn | #9a6700 | #fdd663 | #7a5200 |
| chip-bg | #ececee | #23262b | #f0f0f0 |
| focus | #0b57d0 | #8ab4f8 | #002d7a |

Contrast pairs verified ≥ 4.5:1: fg/bg, muted/bg, muted/raised, accent-contrast/accent, danger/bg, ok/bg, warn/bg in all three themes. Dots are non-text graphics sized 6–10 px; each theme's dot palette keeps ≥ 3:1 against chip-bg where achievable and never relies on hue alone (lightness alternation).

Tag dot palettes (deuteranopia-safe: alternating lightness, red/green never adjacent):

- Light: `#d93025, #b26a00, #796200, #188038, #00897b, #1a73e8, #7627bb, #c2185b, #5f6368, #00769d, #8d6e63, #3f51b5`
- Dark: `#f28b82, #fcad70, #fdd663, #81c995, #6cc0b7, #8ab4f8, #c58af9, #f8abb9, #9aa0a6, #57c7c7, #d7a37c, #aecbfa`
- High-contrast: the light set darkened one step each (`#a80e0a, #8f5200, #5e4a00, #0c5d27, #00695d, #0b57d0, #5f158f, #970f45, #3c3f43, #005661, #6d5342, #2c3a99`)

Native tab-group colours (for browser groups created from categories) map to Chrome's nine group colours; group title always carries the category word, so colour is redundant there too.

## States (all defined, none improvised)

- **Empty inventory**: centred muted line "No open tabs match." with a one-line hint; not an illustration.
- **Loading**: none at frame level — popup/dashboard render instantly from cached storage; per-row pending text replaces itself when data lands (space pre-reserved).
- **Extraction failed / skipped**: per summary-honesty rules above.
- **Permission denied** (host access off): persistent dismissible banner in dashboard, "Page reading is off — summaries unavailable. Enable" button calling `chrome.permissions.request`; popup shows the same as a footer notice. Everything except extraction/summaries works without it.
- **No search results**: "No results for “query”." plus active-filter reset button.
- **Storage pressure**: banner once extractions are pruned: "Storage full — oldest page texts dropped; summaries kept."

## Auditable requirements

1. Popup opens instantly from cached state; never blocks on extraction or worker cold start.
2. Long titles/URLs truncate middle-out; domain always visible.
3. Dashboard usable narrow (≥320 px) and wide.
4. Full keyboard operation: documented overlay (`?`), roving tabindex across rows, visible rings.
5. Screen-reader correct: `role=list/listitem`, assembled `aria-label` including states; filter results announced via polite live region.
6. AA contrast everywhere incl. chips and muted text.
7. `prefers-reduced-motion: reduce` disables all transitions/animations.
8. No layout shift as summaries arrive — space is reserved.
9. RTL-safe: `dir="auto"` on dynamic strings, logical CSS properties, bidi-aware truncation on code points.
10. Theme applied via inline head script reading a synchronous localStorage mirror — no flash of wrong theme.
