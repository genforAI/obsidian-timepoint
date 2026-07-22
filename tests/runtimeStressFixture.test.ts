import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseDayViewState, parseStandaloneEntry } from "../src/storage";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runtime stress fixture generator", () => {
  it("creates valid 48/250 event days from only TimePoint/Days and never overwrites them", async () => {
    const vault = await temporaryVault(true);
    const script = path.resolve("scripts/generate-runtime-stress-fixture.mjs");
    const first = await execFileAsync(process.execPath, [script, vault]);
    expect(first.stdout).toMatch(/CREATED visual: 48 events/u);
    expect(first.stdout).toMatch(/CREATED pressure: 250 events/u);

    const visual = await inspectDay(vault, "2026-07-19");
    const pressure = await inspectDay(vault, "2026-07-20");
    expect(visual).toMatchObject({ entryCount: 48, sameMinuteCount: 18, manualCount: 12 });
    expect(pressure).toMatchObject({ entryCount: 250, sameMinuteCount: 96, manualCount: 100 });
    const before = await snapshotFiles(vault);

    const second = await execFileAsync(process.execPath, [script, vault]);
    expect(second.stdout.match(/SKIP /gu)).toHaveLength(2);
    expect(await snapshotFiles(vault)).toEqual(before);
  });

  it("refuses a directory that is not explicitly prepared as a TimePoint test Vault", async () => {
    const vault = await temporaryVault(false);
    const script = path.resolve("scripts/generate-runtime-stress-fixture.mjs");
    try {
      await execFileAsync(process.execPath, [script, vault]);
      throw new Error("Expected the fixture generator to reject an unprepared Vault.");
    } catch (error) {
      if (!isExecFailure(error)) throw error;
      expect(error.stderr).toMatch(/Refusing to write outside a TimePoint test Vault/u);
    }
    expect(await readdir(vault)).toEqual([]);
  });
});

async function temporaryVault(withStorage: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "timepoint-runtime-fixture-"));
  temporaryRoots.push(root);
  if (withStorage) await mkdir(path.join(root, "TimePoint", "Days"), { recursive: true });
  return root;
}

async function inspectDay(
  vault: string,
  date: string,
): Promise<{ entryCount: number; sameMinuteCount: number; manualCount: number }> {
  const folder = path.join(vault, "TimePoint", "Days", date.slice(0, 4), date.slice(5, 7), date);
  const names = (await readdir(folder)).sort();
  const entryNames = names.filter((name) => name.endsWith(".md") && name !== "_Timeline.md");
  const entries = await Promise.all(
    entryNames.map(async (name) => {
      const parsed = parseStandaloneEntry(await readFile(path.join(folder, name), "utf8"), {
        expectedDate: date,
      });
      expect(
        parsed.diagnostics.filter((item) => item.severity === "error"),
        name,
      ).toEqual([]);
      expect(parsed.entry, name).toBeDefined();
      return parsed.entry;
    }),
  );
  const index = await readFile(path.join(folder, "_Timeline.md"), "utf8");
  expect(parseDayViewState(index).status).toBe("valid");
  expect(index.match(/^- \[\[/gmu)).toHaveLength(entryNames.length);
  return {
    entryCount: entries.length,
    sameMinuteCount: entries.filter((entry) => entry?.time === "09:30").length,
    manualCount: entries.filter((entry) => entry?.cardLayout).length,
  };
}

async function snapshotFiles(vault: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const date of ["2026-07-19", "2026-07-20"]) {
    const folder = path.join(vault, "TimePoint", "Days", date.slice(0, 4), date.slice(5, 7), date);
    for (const name of (await readdir(folder)).sort()) {
      result.set(`${date}/${name}`, await readFile(path.join(folder, name), "utf8"));
    }
  }
  return result;
}

function isExecFailure(value: unknown): value is Error & { stderr: string } {
  return value instanceof Error && "stderr" in value && typeof value.stderr === "string";
}
