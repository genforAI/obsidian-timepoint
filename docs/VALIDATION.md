# TimePoint 0.5.0-beta.1 validation status

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

The public implementation currently passes strict TypeScript and 139/139 tests across 14 files.
Final build, lint, smoke, audit, and clean-install results are recorded during the release handoff,
not predeclared in this document.

Automated coverage includes appearance migration, bilingual dictionary parity, responsive/theme
CSS contracts, legacy storage safety, native editor targeting, bounded previews, date-range and
leap-day boundaries, range format round trips, portable folder structure, duplicate IDs, preview
fingerprints, and partial-write rollback.

Density stress coverage additionally includes a 39-entry clustered day, 96 entries at the same
minute in a 320 px leaf, 180 shuffled dense entries, bounded Real-time lanes, collision-free packed
cards, unchanged proportional nodes, and runtime-only preview caps.

## Runtime gate

No static or browser simulation is accepted as Obsidian runtime evidence. A dedicated Obsidian
test window must verify the exact candidate files against:

- default light and dark themes;
- Minimal, AnuPpuccin, and a high-contrast custom accent;
- 320, 560, 900, and 1200 px widths plus 200% scaling;
- ribbon, command, settings, empty state, and embedded index entry points;
- native event creation/editing, clipping, resize/reflow, delete/undo, and external refresh;
- all four day and range export formats followed by re-import.

Routine file checks and automation must not activate or cover the user's foreground applications.
Visible UI control requires advance explanation and user consent; user-performed visible actions are
preferred.

## Release decisions

- `0.5.0-beta.1`: CI green, default light/dark pass, and macOS core interactions pass.
- `0.5.0`: macOS and Windows pass, two third-party themes pass, complete export round trips pass,
  and no P0/P1 data issue remains.
- Mobile support stays unclaimed and `isDesktopOnly` remains true until physical iOS and Android
  validation is complete.
