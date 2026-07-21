# Privacy and local-first statement

TimePoint `0.5.0-beta.1`:

- stores every event in an independent, readable Markdown file in the user's Obsidian vault;
- stores preferences and the last-opened date in Obsidian's normal plugin data file;
- stores no card position, measured height, clipping state, editor cursor, or private draft as
  event data;
- makes no plugin-initiated network request;
- requires no account, backend, subscription, API key, or telemetry service;
- includes no analytics or advertising SDK;
- does not access files outside the vault through direct filesystem APIs;
- does not use Electron or desktop-only Node.js runtime APIs.

The beta is nevertheless marked desktop-only because physical mobile interaction has not passed
the release gate. This is a support claim, not a technical permission requirement.

Export reads only the selected local dates. It writes to the configured Vault folder, makes no
network request, and exposes clipboard actions only after an explicit user click. No automatic
clipboard read occurs.

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
