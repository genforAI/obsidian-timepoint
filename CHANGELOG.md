# Changelog

## 0.5.0-beta.1 - 2026-07-21

Theme-native UI, inclusive range export, and public beta engineering.

- Added Native and Signature appearance modes. Native uses Obsidian semantic surfaces without a
  fixed brand color, black shadow, or glow; Signature derives its restrained layer from the active
  user accent.
- Reduced ordinary axis, connector, node, and card emphasis while retaining clear current,
  selected, creation-preview, and primary-action states.
- Added density-adaptive timeline previews. Clustered hours compact Markdown presentation, reduce
  lane width, cap Real-time lane count to the current leaf, and pack overflow downward without
  changing event files or proportional time nodes.
- Fixed occupied-minute creation previews so the existing node receives one local highlight rather
  than drawing a duplicate time badge or accenting the full axis; creation is single-flight.
- Reset stale horizontal anchors and settle Real-time positioning after its first painted frame,
  preventing a dense mode switch from presenting an apparently empty canvas.
- Added localized English and Simplified Chinese UI and locale-aware date/weekday formatting.
- Added a one-time ready notice, Settings open action, responsive visible Export button, and
  three-action empty-day welcome card.
- Replaced separate day export actions with one preview-first day/range panel supporting Markdown,
  JSON, CSV, and portable notes folders across at most 366 inclusive days.
- Added range Schema 1 Markdown/JSON round trips, multi-date CSV, canonical portable directory
  output, exact success paths, clipboard actions, and 2 MiB content-copy protection.
- Blocked the entire export for parser errors, future schemas, duplicate IDs, stale previews, and
  caught partial writes.
- Moved runtime geometry to scoped CSS custom properties, added 560/720/900 px container behavior,
  and enforced 44 px coarse-pointer targets.
- Added Obsidian-specific ESLint, minified production builds, Node 20/22 CI, exact-tag release
  checks, issue/PR templates, security/contribution/publishing docs, and Git ignores for internal
  handoff evidence and `main.js`.
- Expanded public automated coverage to 135 tests across 14 files, including 39-entry clustered,
  96 same-minute narrow-leaf, and 180-entry deterministic packing stress cases.

## 0.4.0 - 2026-07-21

Independent event notes, conservative recovery, and portable timeline days.

- Replaced new multi-event day-file writes with one ordinary Markdown file per event under a dated
  folder, plus a `_Timeline.md` daily index containing an interactive block and relative links.
- Kept legacy Schema 1 day files readable and added non-destructive migration: event notes are
  written first, the index is the commit marker, and the legacy source remains untouched.
- Added conservative recovery for uniquely truncated/missing legacy end markers; ambiguous damage
  remains read-only and opens directly for manual repair.
- Replaced the generic red error banner with diagnostic details and actionable Repair, Migrate, and
  Open source/problem note controls.
- Opened independent events as completely normal Obsidian Markdown notes, while retaining the
  legacy body-targeting path for unmigrated days.
- Preserved unrelated Obsidian YAML properties during guarded TimePoint updates and blocked
  duplicate standalone IDs before ambiguous edit/delete operations.
- Added an explicit clipped-preview footer; long text and the lower portion of large images remain
  hidden until the event note is opened.
- Added note-link copy, portable event-Markdown copy, Markdown paste import, portable day-index
  access, and day-folder path copy alongside existing Markdown/JSON/CSV exports.
- Extended main and embedded refresh matching to independent event files and refined responsive
  toolbar, diagnostic, and card styling.
- Expanded automated coverage to 108 tests across 11 files before runtime validation.

## 0.3.0 - 2026-07-21

Native Markdown editing and bounded timeline previews.

- Removed the custom Inspector, its textarea editor, draft tabs, formatting toolbar, and modal
  fallback from the active product and source tree.
- Creating from the toolbar or the timeline axis now writes a valid empty Schema 1 entry and opens
  its body in a reusable adjacent Obsidian `MarkdownView` in Live Preview/source mode.
- Editing, the card action, and card double-click all reuse that native Markdown pane, position the
  cursor at the selected entry, focus the editor, and rely on Obsidian's normal autosave behavior.
- Scoped the native pane so TimePoint's machine-owned comments and stable block IDs stay hidden in
  Live Preview while the underlying day file remains unchanged and fully portable.
- Replaced inline expansion with a hard preview-height contract: long text, tables, code, callouts,
  and images are clipped inside the timeline and can be viewed in full only in the Markdown pane.
- Removed the unlimited Full mode and migrated old `full`/`showFullNote` settings to the bounded
  comfortable preview.
- Preserved card remeasurement and Elastic reflow across resize without allowing hidden content to
  inflate clipped cards.
- Added safe native-body targeting for normal, empty, legacy-empty, and duplicate-marker cases.
- Preserved CRLF consistently inside hidden JSON metadata as well as around managed entry blocks.
- Fixed main-view title synchronization after date changes and native-editor focus after axis/card
  navigation.
- Verified the workflow in Obsidian 1.12.7: toolbar creation, axis creation, native autosave,
  immediate card refresh, double-click pane reuse, external refresh, hard clipping, and narrow
  split resizing.

## 0.2.2 - 2026-07-21

Run 02.2 — Real-runtime interface and interaction hardening.

- Fixed Edit/Preview so only the active Inspector surface occupies space; the editor and rendered
  preview now use the full panel width.
- Replenished the bounded layout convergence budget after stable renders and on every real
  container-width change, preventing wrapped Markdown from colliding after resize/Inspector open.
- Preserved the current timeline scroll position across card expansion, save, file refresh, and
  responsive remeasurement.
- Moved medium-width editing to a bottom sheet before the docked Inspector can make the timeline
  unusably narrow.
- Reduced light-theme tint and card shadow noise, revealed card actions on intent for mouse users,
  and highlighted the card currently being edited.
- Added draft character feedback and disabled unchanged Save actions.

## 0.2.1 - 2026-07-21

Run 02.1 — Real Obsidian Runtime Hotfix.

- Preserved the bounded automatic-reflow budget while a TimePoint view is hidden by Obsidian.
- Added visible-state recovery so Smart/Preview card measurement and Elastic layout rerun after
  returning from full-screen settings or an inactive workspace state.
- Added a regression test for the zero-size-to-visible measurement transition.

## 0.2.0 - 2026-07-18

Run 02 — Markdown UX + UI Fidelity + Embedded Timeline.

- Replaced the modal-first desktop workflow with an integrated right Inspector and responsive
  narrow-pane bottom sheet.
- Added shared Create/Edit drafts, Clicked/Now/Manual time modes, explicit Save/Cancel/Delete,
  conflict-aware writes, and unsaved-change confirmation.
- Added Markdown Edit/Preview tabs and a selection-preserving formatting toolbar.
- Added Smart, Full, and Preview card modes with runtime-only expansion and measured layout reflow.
- Added bounded axis interaction, ghost node/time preview, active-layout inverse mapping, and click
  snapping.
- Added Edit/Open/More card actions, stable block-reference copy, expansion, and guarded deletion.
- Added Reading View `timepoint` code blocks with strict configuration, read-only rendering, main
  Inspector routing, file refresh, and per-instance cleanup.
- Preserved Schema 1 and v0.1 settings, including `showFullNote` migration.
- Hardened rich Markdown boundaries, fenced marker examples, LF/CRLF round trips, and future entry
  schema fail-closed mutation/export behavior.
- Made unknown managed metadata read-only so an older build cannot erase extension fields.
- Blocked duplicate IDs inside a single JSON/CSV import before any vault write.
- Added a deterministic 20-entry multilingual demo vault and expanded automated coverage.
- Updated version metadata, documentation, validation evidence, and release packaging.

Real Obsidian screenshot and interaction evidence is blocked by the build environment and remains
the strict Gate H requirement before an overall PassGate result can be `PASS`.

## 0.1.0 - 2026-07-18

Initial stable internal-use MVP candidate.

- Added the TimePoint workspace view, ribbon action, commands, date navigation, and capture flows.
- Added Markdown-native bounded storage, conflict-aware create/edit/delete, and delete undo.
- Added deterministic Elastic and exact proportional Real-time layouts.
- Added theme-compatible responsive styling and Obsidian Markdown rendering.
- Added settings, Markdown/JSON/CSV export, and previewed JSON/CSV import conflicts.
- Added strict TypeScript, automated tests, clean-build validation, and release documentation.
