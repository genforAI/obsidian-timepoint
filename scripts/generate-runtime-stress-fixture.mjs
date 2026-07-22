import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const vaultArgument = process.argv[2];
if (!vaultArgument || !path.isAbsolute(vaultArgument)) {
  throw new Error("Pass the absolute path of a disposable Obsidian Vault.");
}

const vaultPath = path.resolve(vaultArgument);
const storagePath = path.join(vaultPath, "TimePoint", "Days");
if (!(await isDirectory(storagePath))) {
  throw new Error(`Refusing to write outside a TimePoint test Vault: ${storagePath} is missing.`);
}

const fixtures = [
  { date: "2026-07-19", total: 48, sameMinute: 18, manual: 12, label: "visual" },
  { date: "2026-07-20", total: 250, sameMinute: 96, manual: 100, label: "pressure" },
];

for (const fixture of fixtures) {
  const dayPath = path.join(
    storagePath,
    fixture.date.slice(0, 4),
    fixture.date.slice(5, 7),
    fixture.date,
  );
  if (await exists(dayPath)) {
    console.log(`SKIP ${fixture.label}: ${dayPath} already exists; no files were overwritten.`);
    continue;
  }
  await mkdir(path.dirname(dayPath), { recursive: true });
  try {
    await mkdir(dayPath, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      console.log(`SKIP ${fixture.label}: ${dayPath} already exists; no files were overwritten.`);
      continue;
    }
    throw error;
  }
  const entries = Array.from({ length: fixture.total }, (_, index) => createEntry(fixture, index));
  await Promise.all(
    entries.map((entry) =>
      writeFile(path.join(dayPath, `${entry.time.replace(":", "")}--${entry.id}.md`), entry.note, {
        encoding: "utf8",
        flag: "wx",
      }),
    ),
  );
  await writeFile(path.join(dayPath, "_Timeline.md"), createIndex(fixture.date, entries), {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(
    `CREATED ${fixture.label}: ${entries.length} events (${fixture.sameMinute} at one minute, ${fixture.manual} manual layouts) in ${dayPath}`,
  );
}

function createEntry(fixture, index) {
  const time = index < fixture.sameMinute ? "09:30" : distributedTime(index - fixture.sameMinute);
  const id = `tp-${fixture.date.replaceAll("-", "")}-${time.replace(":", "")}00-${String(index + 1).padStart(4, "0")}`;
  const createdAt = `2026-07-21T12:${String(index % 60).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}.000Z`;
  const layout = index < fixture.manual ? manualLayout(index, createdAt) : [];
  const body = bodyFor(index, fixture.label);
  const lines = [
    "---",
    "timepoint-entry-schema: 1",
    `id: ${JSON.stringify(id)}`,
    `date: ${fixture.date}`,
    `time: ${JSON.stringify(time)}`,
    'timezone: "America/New_York"',
    `createdAt: ${JSON.stringify(createdAt)}`,
    `updatedAt: ${JSON.stringify(createdAt)}`,
    `tags: ${JSON.stringify([fixture.label, index < fixture.sameMinute ? "same-minute" : "distributed"])}`,
    'source: "runtime-fixture"',
    ...layout,
    "---",
    "",
    body,
    "",
  ];
  return { id, time, note: lines.join("\n") };
}

function distributedTime(index) {
  const minute = (6 * 60 + index * 7) % (24 * 60);
  const nonClusterMinute = minute === 9 * 60 + 30 ? minute + 1 : minute;
  return `${String(Math.floor(nonClusterMinute / 60)).padStart(2, "0")}:${String(nonClusterMinute % 60).padStart(2, "0")}`;
}

function manualLayout(index, updatedAt) {
  const column = index % 4;
  const row = Math.floor(index / 4);
  return [
    "timepoint-card-schema: 1",
    `timepoint-card-x: ${Number((0.16 + column * 0.22).toFixed(6))}`,
    `timepoint-card-y: ${Number((0.08 + (row % 12) * 0.075).toFixed(6))}`,
    `timepoint-card-width: ${index % 3 === 0 ? 0.32 : 0.24}`,
    `timepoint-card-height: ${index % 4 === 0 ? 168 : 96}`,
    `timepoint-card-updated-at: ${JSON.stringify(updatedAt)}`,
  ];
}

function bodyFor(index, label) {
  switch (index % 8) {
    case 0:
      return `## ${label === "visual" ? "密集画布检查" : "Pressure checkpoint"} ${index + 1}\n\n- [x] Card data remains Markdown\n- [ ] Move only changes display metadata`;
    case 1:
      return `A deliberately long preview ${"keeps the timeline bounded while the original Markdown remains complete. ".repeat(8)}`;
    case 2:
      return "| Mode | Expected |\n| --- | --- |\n| Pan | Time stays fixed |\n| Resize | Body stays intact |";
    case 3:
      return "```ts\nconst invariant = { time: 'unchanged', body: 'unchanged' };\n```";
    case 4:
      return "Local relation: [[Run 02 Research Note]] and [[Run 02 Embedded Timeline]].";
    case 5:
      return "Public-link placeholder for consent testing: https://help.obsidian.md/";
    case 6:
      return "![[TimePoint-demo-image.svg]]\n\nThe image preview must stay clipped inside the card.";
    default:
      return "> [!info] Layering invariant\n> Selected cards rise above neighboring cards without changing their event time.";
  }
}

function createIndex(date, entries) {
  const state = {
    schemaVersion: 1,
    modes: {
      elastic: { zoom: 1, centerX: 0.5, centerY: 0 },
      realtime: { zoom: 1, centerX: 0.5, centerY: 0 },
    },
    minimapExpanded: true,
    relationsEnabled: false,
    stackOrder: entries.slice(0, 120).map((entry) => entry.id),
    referenceCards: {},
  };
  const links = entries
    .slice()
    .sort((left, right) => left.time.localeCompare(right.time) || left.id.localeCompare(right.id))
    .map((entry) => `- [[${entry.time.replace(":", "")}--${entry.id}|${entry.time}]]`);
  return [
    "---",
    "timepoint-layout: entry-files",
    "timepoint-schema: 2",
    `date: ${date}`,
    'timezone: "America/New_York"',
    "---",
    "",
    `# TimePoint · ${date}`,
    "",
    "> [!info] Disposable runtime stress fixture",
    "> Generated only inside the dedicated test Vault. Every event remains an ordinary Markdown note.",
    "",
    "```timepoint",
    `date: ${date}`,
    "mode: elastic",
    "editable: true",
    "```",
    "",
    "<!-- timepoint:view-state",
    JSON.stringify(state, null, 2),
    "-->",
    "",
    "## Event notes",
    "",
    ...links,
    "",
  ].join("\n");
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
