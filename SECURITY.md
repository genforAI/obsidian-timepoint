# Security policy

## Supported versions

`0.5.0-beta.1` is the currently supported desktop beta. Older local handoff builds are not public
security-support targets.

## Reporting a vulnerability

Use the private security-advisory form at
`https://github.com/GITHUB_OWNER/obsidian-timepoint/security/advisories/new` after the repository is
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

TimePoint is local-first and makes no plugin-owned network requests. It has no account, telemetry,
analytics, backend, or runtime package dependencies. It reads and writes only through Obsidian's
Vault APIs. User-authored links, remote images, third-party themes, sync plugins, and Obsidian itself
remain outside TimePoint's trust boundary.

Imports and exports fail closed on invalid schemas, duplicate IDs, parser errors, and stale
previews. This reduces accidental corruption but does not replace normal Vault backups or an
independent review before installing third-party code.
