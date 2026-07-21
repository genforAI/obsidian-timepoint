import { readFile, stat } from "node:fs/promises";
import process from "node:process";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const [manifest, packageJson, packageLock, versions] = await Promise.all([
  readJson("manifest.json"),
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson("versions.json"),
]);

const expected = manifest.version;
const tag = process.argv[2] || process.env.GITHUB_REF_NAME || "";
const failures = [];
if (packageJson.version !== expected)
  failures.push("package.json version differs from manifest.json");
if (packageLock.version !== expected)
  failures.push("package-lock.json version differs from manifest.json");
if (packageLock.packages?.[""]?.version !== expected) {
  failures.push("package-lock root package version differs from manifest.json");
}
if (versions[expected] !== manifest.minAppVersion) {
  failures.push("versions.json does not map the release version to manifest.minAppVersion");
}
if (tag && tag !== expected) failures.push(`tag ${tag} must exactly equal ${expected}`);
if (tag.startsWith("v")) failures.push("release tags must not use a v prefix");
if (JSON.stringify({ manifest, packageJson }).includes("GITHUB_OWNER")) {
  failures.push("replace GITHUB_OWNER metadata after gh auth login and before publishing");
}

for (const asset of ["manifest.json", "main.js", "styles.css"]) {
  try {
    const info = await stat(asset);
    if (!info.isFile() || info.size === 0) failures.push(`${asset} is missing or empty`);
  } catch {
    failures.push(`${asset} is missing`);
  }
}

if (failures.length > 0) {
  console.error(`Release validation failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Release metadata and assets are consistent for ${expected}.`);
}
