# Security policy

## Supported versions

`0.8.0-beta.1` is the currently supported desktop beta. Older local handoff builds are not public
security-support targets.

## Reporting a vulnerability

Use the private security-advisory form at
`https://github.com/genforAI/obsidian-timepoint/security/advisories/new` after the repository is
published. If private advisories are unavailable, contact the maintainer through the GitHub profile
linked in `manifest.json` before opening a public issue.

Do not include real event bodies, private Vault paths, usernames, sync-provider details, or
screenshots containing personal notes. Replace them with a minimal synthetic Vault and state:

- TimePoint and Obsidian versions;
- operating system and theme;
- affected data format and exact safe reproduction steps;
- whether any file was created, changed, deleted, or transmitted.

You should receive an acknowledgement within seven days. A confirmed issue will be handled in a
private branch, verified against data-safety tests, and released with an appropriate advisory.

## Security posture

TimePoint is local-first and has no account, telemetry, analytics, backend, or required network
service. Event storage uses Obsidian's Vault APIs. Its bundled ZIP parser handles local Portable
interchange only. External-link snapshot requests are an
optional, consent-gated exception: TimePoint uses Obsidian `requestUrl` for public HTTPS URLs and
never attaches login cookies or event bodies. Disabling consent leaves local relations available
and external links as inert placeholders.

Snapshot requests reject credential URLs, non-HTTPS targets, localhost, `.local`, IP literals, and
known private/reserved destinations. HTML is limited to 512 KiB and parsed only for inert title and
Open Graph metadata. Images are limited to 2 MiB, must match PNG/JPEG/WebP MIME and magic bytes, and
SVG or executable content is rejected. At most two requests run concurrently, each host is paced,
and late responses after the timeout are ignored. A bounded `snapshot.md` marker is written last so
an incomplete cache is never treated as successful.

User-authored links, remote images rendered by Obsidian, third-party themes, sync plugins, and
Obsidian itself remain outside TimePoint's trust boundary.

Imports and exports fail closed on invalid schemas, duplicate IDs, parser errors, stale previews,
unsafe archive paths, encrypted/ZIP64/multivolume archives, header mismatches, oversized files,
excessive expansion ratios, and MIME/magic-byte mismatches. Imported files never replace existing
Vault paths, and a caught partial write is rolled back. These controls reduce accidental corruption
but do not replace normal Vault backups or an independent review before installing third-party
code.
