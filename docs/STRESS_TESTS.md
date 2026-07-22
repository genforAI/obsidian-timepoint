# TimePoint density and interaction stress tests

These tests use synthetic notes in a disposable Vault. They never rewrite the Markdown body merely
to make a timeline fit: density changes are runtime-only preview decisions.

## Background automated matrix

| Scenario                                   | Invariant                                                                          | Current result          |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------- |
| 39 events with a 34-minute cluster         | Dense mode, at most four lanes at 720 px, no same-lane overlap                     | Pass                    |
| 96 events at one minute in a 320 px leaf   | One packed lane, one proportional node, complete stable ordering                   | Pass                    |
| 180 shuffled dense events                  | Output identical for forward/reverse input; five-lane cap                          | Pass                    |
| Long Markdown, image, table, code, callout | Preview cap changes; source string and file stay unchanged                         | Pass                    |
| Ordinary evenly distributed day            | Comfortable mode; no unnecessary compression                                       | Pass                    |
| Real-time packed overflow                  | Timeline may grow below the cards while the 00:00–24:00 axis remains proportional  | Pass                    |
| Existing-minute axis hover                 | Existing node is highlighted; no duplicate ghost label                             | Pass by source contract |
| Rapid repeated creation                    | One create promise per view; later clicks wait for completion                      | Pass by source contract |
| Fresh/mode-switched Real-time view         | Reset horizontal anchor and settle vertical position after paint                   | Pass by source contract |
| Dense proportional badges                  | Permanent labels are thinned; every node retains its exact accessible time         | Pass                    |
| Hand mode and 50–300% zoom                 | Drag suppresses card/create actions; viewport centre survives runtime zoom         | Pass                    |
| Gesture state machine                      | 6/10 px thresholds, Hand/Space override, link exemption, cancel/capture recovery   | Pass                    |
| Eight resize handles                       | 72–720 px height, width bounds, normalized round trip, narrow clamps               | Pass                    |
| 250 total / 100 manual cards               | Manual cards do not reserve auto-flow slots; bounded gaps and routing; p95 < 32 ms | Pass                    |
| 96 same-time event fan-out                 | One true node time, distinct ports, stable complete card ordering                  | Pass                    |
| Layout persistence/history                 | One pointer-up write, click coalescing, day/mode state, undo/redo, conflict block  | Pass                    |
| Bounded relation expansion                 | Wiki/Markdown/local/cross-day/URL dedupe, cycle detection, 50 cards/100 edges      | Pass                    |
| Snapshot request safety                    | Consent, public HTTPS, cache/dedupe, 2 concurrent, timeout, size/MIME/magic limits | Pass                    |
| Portable relationship export               | Daily state and used completed preview/marker pairs survive; missing cache blocks  | Pass                    |
| Viewport persistence under 250 cards       | Exact self-write is ignored; byte-different external index edits still refresh     | Pass                    |

The automated gate is `npm run check`. It covers formatting, ESLint, strict TypeScript, Vitest,
production build, bundle evaluation/secret scan, and high-severity dependency audit.

### Latest local beta verification (2026-07-21)

- `npm run check`: 20 files and 207/207 tests passed; formatting, ESLint, strict TypeScript,
  production build, bundle smoke, and audit all passed with zero reported vulnerabilities.
- `npm run test:stress`: 8 files and 90/90 focused stress tests passed.
- Twenty earlier shuffled full-suite seeds plus two post-optimization seeds passed. The final
  shuffled runs were 207/207, checking for hidden order dependencies in shared state, timers,
  caches, and asynchronous queues.
- Node 20 and Node 22 each passed strict TypeScript and all 207 tests using the same final source
  tree; production build and bundle smoke passed from the same candidate.
- The automated 250-card/100-obstacle layout and connector sample stayed below the 32 ms p95 gate.

The disposable Obsidian 1.12.7 compatibility run also exercised 250 events, 96 events at one
minute, 103 manually positioned cards, and 300% zoom. Instrumented runtime probes produced these
post-optimization results without a full-render count increase:

- 120 high-rate Ctrl-wheel samples collapsed to one in-place geometry reflow (`5.4 ms`), with zero
  timeline child changes and stable timeline, card, and Markdown node identities;
- a 64-frame card move and a 68-frame eight-way resize each stayed at or below `0.4 ms` per applied
  pointer frame, with zero peer-card attribute changes, zero child changes, and zero Markdown
  changes;
- two container-width transitions reused the same 250-card DOM and ResizeObserver; the final
  geometry pass was `7.3 ms`, with zero child changes and stable first/middle card plus Markdown
  identities;
- settled obstacle routes ran in frame chunks capped at approximately `6 ms`, below cards.

The edited fixture retained its `time`, body, tags, `createdAt`, and business `updatedAt`; only the
documented card-layout extension changed. Double activation opened the adjacent native Markdown
leaf. Real DOM wheel events changed 100% → 127% with Ctrl and 127% → 100% with Command and were
cancelled before reaching Obsidian's application zoom. Since this Obsidian build is below the
candidate's declared 1.13.0 minimum, these observations are compatibility evidence rather than the
final release gate.

## Real Obsidian runtime matrix

Generate the disposable dense-day fixtures only inside a dedicated test Vault:

```bash
npm run fixture:runtime -- /absolute/path/to/disposable-vault
```

The command requires an existing `TimePoint/Days` test-storage folder and never overwrites an
existing fixture date. It creates a 48-event visual day (18 events at one minute and 12 manual
layouts) plus a 250-event pressure day (96 events at one minute and 100 manual layouts). These are
synthetic Markdown notes and must not be generated in a user's working Vault.

Runtime checks remain necessary because Obsidian owns Markdown rendering, theme variables, leaf
geometry, focus, and scroll anchoring. Run these only in the dedicated test window with foreground
consent.

1. Open the 39-event fixture in Elastic and Real-time at 320, 560, 720, 900, and 1200 px.
2. Confirm dense previews become smaller while double-click opens the complete ordinary Markdown
   note with all text and media intact.
3. Hover an occupied axis minute and confirm exactly one badge and one local node ring appear.
4. Click rapidly near one axis minute and confirm only one new note/editor operation starts.
5. Toggle Elastic → Real-time repeatedly and confirm the first visible frame contains the axis and
   the earliest event rather than an empty canvas.
6. Resize across each container breakpoint and confirm lane count is recalculated without overlap,
   clipped controls, or a stale horizontal blank region.
7. Enable the Hand tool, hold Space temporarily, zoom from 50% through 300% with buttons and
   Command/Ctrl+wheel, pan both axes, Fit, and jump to Now. Confirm navigation never creates,
   opens, moves, or reschedules an event.
8. Drag and resize automatic cards from all eight handles, overlap two manual cards intentionally,
   and confirm the selected opaque top card receives a usable `+N` chooser without rebuilding,
   clipping, or fading peer cards. Escape-cancel, undo/redo, reload, switch dates/modes, and narrow
   the leaf. Confirm only the documented card fields/state block change and wide preferences return
   after re-expansion.
9. Verify same-minute fan-out, quiet unselected paths, selected-path emphasis, connection paths
   staying below cards, and the minimap click/viewport drag at 900/1200 px plus its overlay below
   720 px.
10. Repeat in default light/dark, Minimal, AnuPpuccin, a high-contrast custom accent, and 200%
    system scaling.
11. Verify the same fixture in an embedded `_Timeline.md` Reading View block: saved layouts render,
    but layout mutation controls are absent.
12. Enable relationship view with networking declined. Test same-day, cross-day, ordinary note,
    Wiki/Markdown links, cycles, explicit expansion, 50-card/100-edge bounds, reference movement,
    reload, and native open/navigation.
13. In the disposable Vault only, approve snapshots and use synthetic public HTTPS targets for a
    cache miss, concurrent duplicate reference, cache hit, explicit refresh, offline retry, invalid
    MIME, oversized target, and blocked local/private URL. Inspect that no full HTML or SVG is
    stored and `snapshot.md` appears last.
14. Edit, externally modify, rename, delete/undo, and reload a dense entry; confirm IDs, real time,
    body, tags, and business `updatedAt` remain authoritative through layout operations.
15. Preview and round-trip Markdown, JSON, CSV, and Portable notes folder exports from the dense
    date and an inclusive date range. Confirm portable daily view state and used snapshots work in
    a second disposable Vault.

Record failures with the exact runtime-file hashes, Obsidian version, OS, theme, width, zoom,
fixture revision, and reproduction steps. Never capture personal Vault content.
