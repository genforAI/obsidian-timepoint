# TimePoint architecture

## Runtime stance

TimePoint is a browser-compatible Obsidian plugin. Runtime source uses Obsidian and Web Platform
APIs only; it does not import Node.js, Electron, or direct filesystem APIs. Markdown in the vault is
authoritative. Optional visual preferences are isolated from event meaning and validated before
use. External snapshots use only Obsidian `requestUrl` after explicit consent.

## Layers

| Layer       | Main files                                                                  | Responsibility                                                                                        |
| ----------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Bootstrap   | `src/main.ts`                                                               | Settings, commands, refresh routing, import/export coordination                                       |
| Main view   | `src/views/TimePointView.ts`, `TimelineMinimap.ts`, `nativeEditorTarget.ts` | Date/view state, minimap, layout history, diagnostics, native Markdown leaf reuse                     |
| Timeline    | `src/views/TimelineRenderer.ts`, `RelationLayerRenderer.ts`                 | Bounded event/reference cards, pointer gestures, SVG connectors, responsive reflow                    |
| Embedded    | `src/embedded/`                                                             | Strict code-block config, Reading View lifecycle, editable/read-only routing, per-day storage refresh |
| Layout      | `src/layout/`                                                               | Time scales, card geometry, obstacle avoidance, connector routing, responsive clamping                |
| Relations   | `src/relations/`, `ExternalSnapshotService.ts`                              | Bounded local graph, URL validation, consent-gated safe metadata cache                                |
| Storage     | `src/storage/`                                                              | Event/layout YAML, daily view state, legacy migration, guarded writes                                 |
| Portability | `src/import-export/`, `ExportService.ts`, `PortableArchiveService.ts`       | Day/range formats, direct local attachments, shared Portable archives, fingerprints, rollback guards  |

## Hybrid load flow

1. Resolve the legacy `YYYY-MM-DD.md` path and the v0.4 `YYYY-MM-DD/_Timeline.md` path.
2. If the index exists, read direct child event notes independently and attach diagnostics to their
   source paths.
3. Otherwise, read the legacy day with the Schema 1 recovery parser. An absent date stays an empty
   in-memory day and creates no file.
4. Render valid entries even when another entry is damaged; error-level diagnostics block only
   operations that could lose or misidentify data.
5. Pass each event's own source path to Obsidian `MarkdownRenderer`, so relative links and embeds
   resolve as they do in the event note.

## Migration transaction shape

Migration is non-destructive and retryable:

1. Read the latest legacy bytes.
2. Build a conservative repair plan in memory. Use the repaired copy only if it eliminates every
   error; otherwise require a clean parse.
3. Create the dated event folder.
4. Write each independent event note. An existing byte-identical note is accepted on retry; any
   different collision aborts.
5. Create `_Timeline.md` last. Its presence selects the v0.4 layout on future reads.
6. Keep the original legacy file as an archive.

No repair or migration infers a mismatched identity, removes user content, or downgrades a future
schema.

## Native create/edit flow

1. Toolbar, axis click, card/node action, embedded action, or command identifies a date and time.
2. A new event is immediately created as a real Markdown file; this intentionally follows native
   autosave instead of maintaining a private draft.
3. Desktop reuses one adjacent `MarkdownView`; mobile requests a normal Obsidian tab.
4. For v0.4 notes, the cursor targets the first body byte after YAML and the editor otherwise has no
   special styling—it is a normal Obsidian note.
5. For an unmigrated legacy day, the compatibility target locates exactly one bounded body and
   scoped Live Preview CSS hides only machine-owned comment lines while that legacy file is active.
6. Vault events refresh the main and embedded timelines after Obsidian autosaves.

## Card preview contract

Comfortable and Compact modes both impose a hard measured Markdown height. Short notes render in
full; long text, images, tables, code, callouts, and embeds are clipped without changing source.
Only a measured overflow receives a theme-derived bottom fade; no hint strip or repeated text is
mounted. Cards open the event note on double-click/Enter. ResizeObserver and image-load measurements
are coalesced through animation frames, and hidden content cannot inflate Elastic geometry.

## Timeline and resize behavior

Elastic uses a monotonic piecewise time scale and measured visible card heights to expand dense
periods without reordering events. Real-time keeps node Y proportional to `minute / 1440` and uses
horizontal lanes for card collisions. Labels, ghost time, click inversion, and nodes share the same
active scale. Creation is restricted to the 22 px axis radius.

ResizeObserver runs a bounded convergence pass after real width/content changes. Zero-sized hidden
leaves do not consume the budget. Container queries wrap the toolbar, diagnostics, axis, cards, and
embedded header for narrow splits.

Zoom and container changes use an in-place geometry path: the timeline, card, Markdown, image,
selection, and renderer-component DOM stays mounted while only changed CSS custom properties,
node positions, visible connector paths, and the canvas minimap are updated. High-resolution wheel
input keeps only the newest target per animation-frame drain. Elastic reflow preserves one
ResizeObserver and consumes only changed `ResizeObserverEntry` measurements instead of disconnecting
and re-observing every card. Full obstacle-aware connector routing is deferred into bounded frame
chunks below the card layer.

## Canvas gesture and layout flow

Pointer input enters a small state machine. Mouse movement below 6 px and coarse input below 10 px
remain clicks. Blank/axis drags become pan gestures after the threshold; card bodies become visual
moves; eight handles become resizes. Interactive links and buttons are exempt, explicit Hand mode
turns non-control drags into pan, and holding Space temporarily does the same.

During a move/resize, requestAnimationFrame applies only the newest pointer sample to the active
card's compositor transform or size and its immediate SVG connector. Peer cards and Markdown are
not mutated, Markdown is not rerendered, and no file is written. Escape or pointer cancellation
restores the starting rectangle. Pointer-up freezes the current resolved rectangle into normalized
Schema 1 layout metadata and performs one metadata-aware frontmatter update. Undo/redo records only
layout mutations. Card selection updates the daily stack order through an approximately 250 ms
coalesced index write. Overlap controls are pre-mounted and hidden; completed overlap reconciliation
is contextual and changes only the selected top card's outline and chooser, so entering a dense
connected group cannot rebuild or fade peer cards.

The time node always comes from the event's true `time`. Card geometry cannot reschedule it. Manual
cards may intentionally overlap, while automatic cards deterministically avoid manual rectangles.
SVG paths use same-minute ports and a corridor near the axis; they are below cards and never own
pointer events. Narrow clamps are applied to the resolved rectangle only.

Each date/mode remembers zoom, independent 40–400% vertical scale, and normalized center. Button
zoom anchors the viewport center and Command/Ctrl+wheel anchors the pointer. Vertical controls or
Alt/Option+wheel change temporal spacing without changing canvas zoom or real event time. Fit and
Now are explicit actions. The minimap maps nodes, event/reference rectangles and the visible frame,
supports click/drag navigation, and temporarily collapses below 720 px without overwriting the wide
preference.

## Relationship and snapshot flow

Relationship view is disabled by default per date. The graph parser extracts Wiki, Markdown and
HTTPS links outside code, normalizes/deduplicates targets, detects cycles, and expands only
user-opened local levels. Rendering is capped at 50 reference cards and 100 edges. Same-day
TimePoint targets connect existing event cards; other days and ordinary notes use read-only cards.
Reference layout is stored in the current day's index and never mutates the target note.

External cards remain URL placeholders without consent. With consent, a shared request service
validates public HTTPS destinations, deduplicates in-flight/cache work, limits concurrency and
per-host rate, enforces response/time limits, parses detached inert metadata, validates image MIME
and magic bytes, and writes the snapshot marker after its optional preview. Event YAML associations
are updated only for completed snapshots. Failed/offline attempts may retry after a cooldown; a
complete cache never reconnects unless the user selects refresh.

## Portability and safety

- `_Timeline.md` is both a human-readable link index and a Reading View interactive record.
- Event notes can move/copy independently; card actions copy note links or their portable Markdown.
- Markdown, JSON, and CSV imports are previewed with deterministic fingerprints.
- Day/range export reloads every source at commit and compares the preview fingerprint before
  creating a file. Range exports are capped at 366 inclusive days.
- Portable output stages canonical event/index contents and writes its human root index last.
- Portable output follows directly referenced non-Markdown Vault files one layer deep, validates
  byte limits/MIME/magic/SHA-256, and rewrites only the exported event copy. It emits the shared
  `timepoint-portable` manifest used by TimePoint Web.
- Portable output includes referenced completed snapshots, writing preview assets before snapshot
  markers; a missing associated marker blocks the whole export.
- Portable ZIP import preflights the central and local headers before expansion, validates every
  manifest record, never overwrites a Vault path, rechecks a preview fingerprint, and rolls back all
  newly created files after a caught failure.
- Exact note snapshots guard update/delete, while unrelated YAML properties are preserved.
- Duplicate IDs and unknown/future schemas fail closed.
- Export aborts on any error diagnostic rather than emitting incomplete data.

## Invalidation and cleanup

Storage events for either the legacy file, direct event files, daily index, or completed snapshots
schedule bounded refresh. Markdown render components, embedded children, pointer handlers,
ResizeObservers, animation frames, and timers are released on rerender/unload. Event/day state is
reconstructed from Markdown; external metadata persists only in the disclosed snapshot folder.

## Theme and responsive posture

Native appearance uses Obsidian semantic variables only. Signature appearance derives its accent
surface, selected edge, and node halo from `--interactive-accent`. Runtime geometry is passed to
scoped CSS through `--tp-*` properties. Persisted geometry is normalized preference data, not
measured DOM pixels. Container queries adapt at approximately 560, 720, and 900 px, while
coarse-pointer controls have at least 44 px targets.

## Mobile posture

No direct filesystem API is used, essential actions are visible without hover, and narrow controls
wrap. Physical mobile loading, touch, and virtual-keyboard behavior remain platform-unverified, so
the beta manifest is honestly marked desktop-only.
