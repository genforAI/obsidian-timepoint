# Publishing TimePoint

External publication requires maintainer authentication and explicit approval. The local project
is prepared but intentionally has no remote while `gh auth status` is unauthenticated.

## One-time repository setup

1. Run `gh auth login` and verify the intended account with `gh api user --jq .login`.
2. Replace every `GITHUB_OWNER` placeholder in public files with that exact account name.
3. Run `npm install --package-lock-only` and `npm run check`.
4. Run `npm run release:validate -- 0.5.0-beta.1`.
5. Create the public `obsidian-timepoint` repository, add it as `origin`, and push `main` only after
   explicit authorization.

The preflight fails while placeholders remain. Internal Run 02 handoff reports, full runtime
evidence, design references, local test Vaults, and compiled `main.js` are ignored and must not be
force-added.

## Beta release

The exact beta tag is `0.5.0-beta.1`, without a `v` prefix. The tag workflow re-runs all gates,
checks tag/manifest/package/lock/versions consistency, builds a minified bundle, and publishes only:

- `manifest.json`
- `main.js`
- `styles.css`

Hyphenated tags are marked prerelease. BRAT reads those three assets directly from the GitHub
Release.

The beta gate is green CI, default light and dark themes, and core macOS interaction evidence from
a dedicated Obsidian test window.

## Stable release

Before changing metadata to `0.5.0`, complete macOS and Windows checks, two third-party themes,
complete four-format export/import round trips, and verify there are no P0/P1 data defects. Keep
`isDesktopOnly: true` until physical iOS and Android validation is complete.

After the matching stable release exists, follow the current official Obsidian community-directory
submission flow with the repository URL. The intended catalog identity is:

```text
id: timepoint
name: TimePoint
author: J. Hall
repository: GITHUB_OWNER/obsidian-timepoint
```

Do not reuse beta screenshots for a changed stable bundle, and do not publish or submit on behalf of
the maintainer without a fresh explicit authorization.
