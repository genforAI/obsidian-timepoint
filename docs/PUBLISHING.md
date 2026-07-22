# Publishing TimePoint

External publication requires maintainer authentication and explicit approval. The canonical
repository is `genforAI/obsidian-timepoint`.

## One-time repository setup

1. Authenticate `genforAI` with `gh auth login` and verify it with `gh api user --jq .login`.
2. Run `npm install --package-lock-only` and `npm run check`.
3. Run `npm run release:validate -- 0.8.0-beta.1`.
4. Run `npm run release:stage` and inspect `Release/0.8.0-beta.1/UPLOAD_CHECKLIST.md`.
5. Create the public `obsidian-timepoint` repository, add it as `origin`, and push `main` only after
   explicit authorization.

Internal Run 02 handoff reports, full runtime evidence, design references, local test Vaults, the
local `Release/` directory, and compiled `main.js` are ignored and must not be force-added.

## Beta release

The exact candidate tag is `0.8.0-beta.1`, without a `v` prefix. The tag workflow re-runs all gates,
checks tag/manifest/package/lock/versions consistency, builds a minified bundle, and publishes only:

- `manifest.json`
- `main.js`
- `styles.css`

Hyphenated tags are marked prerelease. BRAT reads those three assets directly from the GitHub
Release.

## Local release staging

`npm run release:stage` rebuilds and smoke-checks the bundle, verifies local version consistency,
and prepares this ignored local directory:

```text
Release/<version>/
├── manifest.json
├── main.js
├── styles.css
├── TimePoint-<version>-Obsidian-Install.zip
├── SHA256SUMS.txt
├── *.sha256
├── RELEASE_NOTES.md
└── UPLOAD_CHECKLIST.md
```

The three loose runtime files are the authoritative GitHub Release assets and are required by BRAT.
The ZIP is a manual-install convenience with one `timepoint/` plugin folder. `CURRENT.txt` in the
parent directory identifies the latest staged version. The generated checklist confirms whether
the public owner metadata is ready for final preflight.

The candidate gate is green CI, default light and dark themes, core macOS canvas/local-relation
interaction evidence, and a consent-gated external-snapshot smoke test from a dedicated disposable
Obsidian Vault. Network targets and screenshots must contain no private content.

## Stable release

Before changing metadata to `0.8.0`, complete macOS and Windows checks, two third-party themes,
complete four-format export/import round trips, and verify there are no P0/P1 data defects. Keep
`isDesktopOnly: true` until physical iOS and Android validation is complete.

After the matching stable release exists, follow the current official Obsidian community-directory
submission flow with the repository URL. The intended catalog identity is:

```text
id: timepoint
name: TimePoint
author: J. Hall
repository: genforAI/obsidian-timepoint
```

Do not reuse beta screenshots for a changed stable bundle, and do not publish or submit on behalf of
the maintainer without a fresh explicit authorization.
