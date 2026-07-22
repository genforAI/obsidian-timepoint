import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const projectRoot = resolve(process.cwd());
const [manifest, packageJson, packageLock, versions] = await Promise.all([
  readJson(join(projectRoot, "manifest.json")),
  readJson(join(projectRoot, "package.json")),
  readJson(join(projectRoot, "package-lock.json")),
  readJson(join(projectRoot, "versions.json")),
]);

const version = manifest.version;
const requestedVersion = process.argv[2] || version;
const consistencyFailures = [];
if (requestedVersion !== version) {
  consistencyFailures.push(
    `requested version ${requestedVersion} differs from manifest ${version}`,
  );
}
if (packageJson.version !== version) {
  consistencyFailures.push("package.json version differs from manifest.json");
}
if (packageLock.version !== version || packageLock.packages?.[""]?.version !== version) {
  consistencyFailures.push("package-lock.json root version differs from manifest.json");
}
if (versions[version] !== manifest.minAppVersion) {
  consistencyFailures.push("versions.json does not map this version to manifest.minAppVersion");
}
if (consistencyFailures.length > 0) {
  throw new Error(`Cannot stage release:\n- ${consistencyFailures.join("\n- ")}`);
}

const releaseRoot = join(projectRoot, "Release");
const releaseDirectory = join(releaseRoot, version);
await mkdir(releaseDirectory, { recursive: true });

const runtimeAssets = ["manifest.json", "main.js", "styles.css"];
for (const asset of runtimeAssets) {
  const source = join(projectRoot, asset);
  const contents = await readFile(source);
  if (contents.length === 0) throw new Error(`${asset} is empty`);
  await copyFile(source, join(releaseDirectory, asset));
}

const archiveName = `TimePoint-${version}-Obsidian-Install.zip`;
const archivePath = join(releaseDirectory, archiveName);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "timepoint-release-"));
const archiveTimestamp = new Date("2000-01-01T12:00:00.000Z");
try {
  const pluginDirectory = join(temporaryDirectory, "timepoint");
  await mkdir(pluginDirectory);
  for (const asset of runtimeAssets) {
    const archivedAsset = join(pluginDirectory, asset);
    await copyFile(join(releaseDirectory, asset), archivedAsset);
    await utimes(archivedAsset, archiveTimestamp, archiveTimestamp);
  }
  await unlink(archivePath).catch(() => undefined);
  const zipped = spawnSync(
    "zip",
    ["-X", "-q", archivePath, ...runtimeAssets.map((asset) => `timepoint/${asset}`)],
    { cwd: temporaryDirectory, encoding: "utf8" },
  );
  if (zipped.error || zipped.status !== 0) {
    throw new Error(
      `Could not create ${archiveName}: ${zipped.error?.message || zipped.stderr || "zip failed"}`,
    );
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

const hashFile = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const stagedAssets = [...runtimeAssets, archiveName];
const hashes = new Map();
for (const asset of stagedAssets) {
  const hash = await hashFile(join(releaseDirectory, asset));
  hashes.set(asset, hash);
  await writeFile(join(releaseDirectory, `${asset}.sha256`), `${hash}  ${asset}\n`, "utf8");
}
await writeFile(
  join(releaseDirectory, "SHA256SUMS.txt"),
  `${stagedAssets.map((asset) => `${hashes.get(asset)}  ${asset}`).join("\n")}\n`,
  "utf8",
);

const changelog = await readFile(join(projectRoot, "CHANGELOG.md"), "utf8");
const releaseSection = changelog
  .split(/^## /mu)
  .slice(1)
  .find((section) => section.startsWith(`${version} `) || section.startsWith(`${version}\n`));
if (!releaseSection) throw new Error(`CHANGELOG.md has no section for ${version}`);
const releaseBody = releaseSection.slice(releaseSection.indexOf("\n") + 1).trim();
if (!releaseBody) throw new Error(`CHANGELOG.md section for ${version} has no release notes`);
await writeFile(
  join(releaseDirectory, "RELEASE_NOTES.md"),
  `# TimePoint ${version}\n\n${releaseBody}\n`,
  "utf8",
);

const publicMetadata = JSON.stringify({ manifest, packageJson });
const ownerReady = !publicMetadata.includes("GITHUB_OWNER");
const uploadChecklist = `# GitHub Release upload checklist — ${version}

Status: **${ownerReady ? "READY FOR FINAL PREFLIGHT" : "BLOCKED — replace every GITHUB_OWNER placeholder first"}**

1. Authenticate the intended account with \`gh auth login\` and confirm it with \`gh api user --jq .login\`.
2. ${ownerReady ? "Confirm manifest/package/README links use the authenticated owner." : "Replace every `GITHUB_OWNER` placeholder with that exact login."}
3. Run \`npm install --package-lock-only\`, \`npm run check\`, and \`npm run release:validate -- ${version}\`.
4. Commit and push the source repository. Do not force-add \`main.js\` or this ignored \`Release/\` directory.
5. Create and push the exact tag \`${version}\` (no \`v\` prefix).
6. Mark the GitHub Release as **${version.includes("-") ? "pre-release" : "stable"}** and paste \`RELEASE_NOTES.md\` into its description.
7. Upload these required loose assets: \`manifest.json\`, \`main.js\`, and \`styles.css\`.
8. Optionally upload \`${archiveName}\`, \`SHA256SUMS.txt\`, and the four sidecars for manual installers.
9. Download the three runtime assets again and compare them with \`SHA256SUMS.txt\` before announcing BRAT availability.

The ZIP contains one installable \`timepoint/\` directory. BRAT still requires the three loose runtime files.
`;
await writeFile(join(releaseDirectory, "UPLOAD_CHECKLIST.md"), uploadChecklist, "utf8");
await writeFile(join(releaseRoot, "CURRENT.txt"), `${version}\n`, "utf8");
await writeFile(
  join(releaseRoot, "README.md"),
  `# Local TimePoint release staging

Current staged version: **${version}**

- Rebuild with \`npm run release:stage\` from the source root.
- Open \`${version}/UPLOAD_CHECKLIST.md\` before creating the GitHub Release.
- Upload the three loose runtime files for BRAT; the ZIP is a manual-install convenience.
- This complete \`Release/\` directory is local-only and intentionally ignored by Git.
`,
  "utf8",
);

console.log(`Staged TimePoint ${version} in ${releaseDirectory}`);
console.log(`Install archive: ${basename(archivePath)}`);
for (const asset of stagedAssets) console.log(`${hashes.get(asset)}  ${asset}`);
if (!ownerReady) {
  console.warn("Publishing remains blocked until GITHUB_OWNER is replaced after gh auth login.");
}
