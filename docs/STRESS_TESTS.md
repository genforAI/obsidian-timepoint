# TimePoint density and interaction stress tests

These tests use synthetic notes in a disposable Vault. They never rewrite the Markdown body merely
to make a timeline fit: density changes are runtime-only preview decisions.

## Background automated matrix

| Scenario                                   | Invariant                                                                         | Current result          |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------- |
| 39 events with a 34-minute cluster         | Dense mode, at most four lanes at 720 px, no same-lane overlap                    | Pass                    |
| 96 events at one minute in a 320 px leaf   | One packed lane, one proportional node, complete stable ordering                  | Pass                    |
| 180 shuffled dense events                  | Output identical for forward/reverse input; five-lane cap                         | Pass                    |
| Long Markdown, image, table, code, callout | Preview cap changes; source string and file stay unchanged                        | Pass                    |
| Ordinary evenly distributed day            | Comfortable mode; no unnecessary compression                                      | Pass                    |
| Real-time packed overflow                  | Timeline may grow below the cards while the 00:00–24:00 axis remains proportional | Pass                    |
| Existing-minute axis hover                 | Existing node is highlighted; no duplicate ghost label                            | Pass by source contract |
| Rapid repeated creation                    | One create promise per view; later clicks wait for completion                     | Pass by source contract |
| Fresh/mode-switched Real-time view         | Reset horizontal anchor and settle vertical position after paint                  | Pass by source contract |
| Dense proportional badges                  | Permanent labels are thinned; every node retains its exact accessible time        | Pass                    |
| Hand mode and 50–300% zoom                 | Drag suppresses card/create actions; viewport centre survives runtime zoom        | Pass                    |

The automated gate is `npm run check`. It covers formatting, ESLint, strict TypeScript, Vitest,
production build, bundle evaluation/secret scan, and high-severity dependency audit.

## Real Obsidian runtime matrix

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
7. Enable the Hand tool, zoom from 50% through 300%, drag vertically and horizontally, reset to
   100%, then exit Hand mode; confirm no event opens, moves, or gets created during navigation.
8. Repeat in default light/dark, Minimal, AnuPpuccin, and a high-contrast custom accent.
9. Verify the same fixture in an embedded `_Timeline.md` Reading View block.
10. Edit, externally modify, rename, delete/undo, and reload a dense entry; confirm IDs and Markdown
    remain authoritative.
11. Preview and round-trip Markdown, JSON, CSV, and Portable notes folder exports from the dense
    date and an inclusive date range.

Record failures with the exact runtime-file hashes, Obsidian version, OS, theme, width, zoom,
fixture revision, and reproduction steps. Never capture personal Vault content.
