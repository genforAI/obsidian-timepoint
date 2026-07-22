# Privacy and local-first statement

TimePoint `0.7.0-beta.1`:

- stores every event in an independent, readable Markdown file in the user's Obsidian vault;
- stores preferences and the last-opened date in Obsidian's normal plugin data file;
- stores optional card layout preferences in event YAML and per-day viewport, minimap, relation,
  reference-card, and stacking preferences in `_Timeline.md`;
- makes no request for core recording, editing, navigation, local relations, import, or export;
- requires no account, backend, subscription, API key, or telemetry service;
- includes no analytics or advertising SDK;
- does not access files outside the vault through direct filesystem APIs;
- does not use Electron or desktop-only Node.js runtime APIs.

The beta is nevertheless marked desktop-only because physical mobile interaction has not passed
the release gate. This is a support claim, not a technical permission requirement.

Export reads only the selected local dates and used completed snapshot cache entries. It writes to
the configured Vault folder, makes no network request, and exposes clipboard actions only after an
explicit user click. No automatic clipboard read occurs.

## Optional external-link snapshots

Relationship view works locally without network access. External URLs are inert placeholder cards
until the user explicitly enables **External link snapshots** after reading the consent notice.
When enabled, TimePoint sends only the normalized public HTTPS URL to that host through Obsidian's
`requestUrl`; it does not send the surrounding event body, Vault path, account identity, telemetry,
or login cookies.

The local cache stores the original and normalized URL, a truncated title and description, fetch
time, a content hash, source event IDs, and an optional size-limited validated PNG/JPEG/WebP image:

```text
TimePoint/Snapshots/<normalized-url-sha256>/
├── snapshot.md
└── preview.webp
```

No script or full HTML page is stored. A complete cache hit avoids the network. Refreshing a
snapshot is explicit. Removing a link removes its event association on relationship refresh, but
does not silently delete the cache; cache files are user-owned Vault files and are removed only by
an explicit cache-management action or normal Vault file operation. Declining or disabling consent
does not remove existing cache files.

Generated `_Timeline.md` files contain a local Reading View block and relative links to event
notes. Embedded `timepoint` blocks read the same local files and do not create a file merely by
rendering. Editable embedded actions route to the main timeline and its native Markdown pane.

Legacy multi-event Markdown files may remain in the vault as user-owned archives after migration.
TimePoint does not silently delete or upload them.

If a user enables Obsidian Sync, iCloud, Git, or another independent synchronization or backup
tool, that tool may copy TimePoint Markdown like any other vault note. TimePoint does not configure
or control those services.

Markdown cards and native editing use Obsidian's renderer/editor. External images or links inside
user-authored Markdown retain the normal behavior and privacy implications of those resources and
the user's Obsidian settings.
