# TimePoint 0.7.0-beta.1 validation status

Date: 2026-07-21

## Automated gate

The public beta gate requires all of the following on Node.js 20 and 22:

- Prettier;
- ESLint with Obsidian-specific rules;
- strict TypeScript;
- Vitest;
- minified production build;
- bundle, manifest, dependency, and secret smoke checks;
- high-severity dependency audit.

The candidate passed the complete local gate repeatedly on 2026-07-21, including after the final
no-flicker rendering changes: 20 Vitest files and 207/207 tests passed; formatting, ESLint, strict
TypeScript, minified production build, bundle smoke, and high-severity audit all passed; `npm audit`
reported 0 vulnerabilities. The focused pressure suite passed 90/90, a shuffled final suite passed
207/207, and Node 20 plus Node 22 each passed strict TypeScript and 207/207 tests.

Automated coverage includes appearance migration, bilingual dictionary parity, responsive/theme
CSS contracts, legacy storage safety, native editor targeting, bounded previews, date-range and
leap-day boundaries, range format round trips, portable folder structure, duplicate IDs, preview
fingerprints, and partial-write rollback.

Density stress coverage additionally includes a 39-entry clustered day, 96 entries at the same
minute in a 320 px leaf, 180 shuffled dense entries, bounded Real-time lanes, collision-free packed
cards, unchanged proportional nodes, and runtime-only preview caps.

0.6 coverage additionally includes gesture thresholds and cancellation, eight resize handles,
normalized geometry, wide-preference responsive clamps, 250 total cards including 100 manual cards,
same-time SVG ports, deterministic obstacle routing, layout-only frontmatter writes, coalesced
stacking, daily/mode viewport state, minimap navigation, undo/redo, index rebuild, and stale-write
conflicts. Managed viewport writes are exact-content classified so the plugin does not mistake its
own `_Timeline.md` persistence for an external edit and re-render every Markdown card. The pressure
target is p95 geometry processing below 32 ms without Markdown rendering or file I/O during a
gesture.

0.7 coverage additionally includes Wiki/Markdown/same-day/cross-day/local/external links, bounded
expansion/cycles, consent, public-URL validation, cache/in-flight deduplication, concurrency/pacing,
timeouts/offline retry, HTML/image limits, MIME/magic validation, marker-last commits, and portable
relationship/snapshot round trips.

## Runtime gate

No static or browser simulation is accepted as Obsidian runtime evidence. A dedicated Obsidian
test window must verify the exact candidate files against:

- default light and dark themes;
- Minimal, AnuPpuccin, and a high-contrast custom accent;
- 320, 560, 900, and 1200 px widths plus 200% scaling;
- ribbon, command, settings, empty state, and embedded index entry points;
- native event creation/editing, clipping, resize/reflow, delete/undo, and external refresh;
- canvas pan/zoom/Fit/Now, move/eight-way resize, cancel, layout undo/redo, persistence, minimap, and
  same-time connector routing;
- local relationship expansion and consent-gated synthetic external snapshot cases;
- all four day and range export formats followed by re-import.

Routine file checks and automation must not activate or cover the user's foreground applications.
Visible UI control requires advance explanation and user consent; user-performed visible actions are
preferred.

### 2026-07-21 compatibility run

A disposable `TimePoint_GateH_Test_Vault` was exercised on macOS in Obsidian 1.12.7 using the exact
candidate runtime files. This is useful compatibility evidence, but it is not the formal beta gate
because the candidate manifest requires Obsidian 1.13.0.

The final installed candidate matched these source-build SHA-256 values byte for byte:

- `main.js`: `59aaf6d375d4872d0c0d821a4ace165be5724d340c7865d9770f5dcbbcfe07a1`;
- `manifest.json`: `ec87b3640adac250e90064fbff189283bca42b11c2855a99d1582721875c4bf7`;
- `styles.css`: `fcd52bdde14f8dc67cb3c672ce8cd0fc22bc432e20bdb2617e10121f63fd9652`.

Verified in that compatibility run:

- default dark and light native-theme rendering;
- a 48-event visual fixture and a 250-event pressure fixture with 96 events at 09:30 and 100 saved
  manual layouts;
- continuous dense scrolling without the former self-write/full-render blank frame;
- 120 high-rate Ctrl-wheel samples collapsed to one `5.4 ms` geometry-only pass while retaining the
  exact timeline, card, and Markdown nodes;
- 64 applied move frames and 68 applied resize frames each measured no more than `0.4 ms`, with no
  peer-card attributes, child nodes, or Markdown changing during the gesture;
- a two-transition width cycle retained all 250 mounted cards and completed its last in-place
  geometry pass in `7.3 ms`, without DOM child churn;
- sticky minimap plus Home/Page Up/Page Down keyboard navigation;
- local relationship cards with networking declined and no snapshot request;
- relationship on/off refresh without jumping into empty canvas space;
- single-day Markdown export preview (`250 events`, `0 conflicts`, `0 errors`) and a successful
  170 KiB export to `TimePoint/Exports/2026-07-20/timepoint-2026-07-20.md`.

Still required for the formal gate: Obsidian 1.13+, physical pointer move/eight-way resize and
cancel/undo evidence, third-party themes, breakpoint/200% matrix, snapshot networking fixtures,
all day/range format round trips, Windows, and the stable-release checks listed below.

## Release decisions

- `0.6.0-beta.1` milestone: canvas automation green, default light/dark pass, and macOS core canvas
  interactions pass.
- `0.7.0-beta.1`: complete automation green, default light/dark pass, macOS core canvas/local
  relation interactions pass, and consent-gated snapshot smoke passes in the disposable Vault.
- `0.7.0`: macOS and Windows pass, two third-party themes pass, complete export round trips pass,
  and no P0/P1 data issue remains.
- Mobile support stays unclaimed and `isDesktopOnly` remains true until physical iOS and Android
  validation is complete.
