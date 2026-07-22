export interface ExtractedMarkdownLink {
  target: string;
  kind: "internal" | "external";
  embedded: boolean;
}

const WIKI_LINK = /(!)?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/gu;
const MARKDOWN_LINK = /(!)?\[[^\]]*\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/gu;
const AUTO_LINK = /<((?:https):\/\/[^>\s]+)>/giu;
const BARE_HTTPS = /(?<![\w"'(=])https:\/\/[^\s<>{}\u005B\u005D]+/giu;

export function extractMarkdownLinks(markdown: string): ExtractedMarkdownLink[] {
  const source = stripCode(markdown);
  const links: ExtractedMarkdownLink[] = [];
  const occupied = new Set<string>();
  collect(
    source,
    WIKI_LINK,
    (match) => ({
      target: (match[2] ?? "").trim(),
      kind: "internal",
      embedded: Boolean(match[1]),
    }),
    links,
    occupied,
  );
  collect(
    source,
    MARKDOWN_LINK,
    (match) => {
      const target = decodeAngleTarget(match[2] ?? "");
      return {
        target,
        kind: isHttpsUrl(target) ? "external" : "internal",
        embedded: Boolean(match[1]),
      };
    },
    links,
    occupied,
  );
  collect(
    source,
    AUTO_LINK,
    (match) => ({
      target: match[1] ?? "",
      kind: "external",
      embedded: false,
    }),
    links,
    occupied,
  );
  collect(
    source,
    BARE_HTTPS,
    (match) => ({
      target: trimUrlPunctuation(match[0]),
      kind: "external",
      embedded: false,
    }),
    links,
    occupied,
  );
  return deduplicateLinks(links);
}

export function normalizeExternalUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if (url.port === "443") url.port = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/iu.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function collect(
  source: string,
  pattern: RegExp,
  map: (match: RegExpExecArray) => ExtractedMarkdownLink,
  output: ExtractedMarkdownLink[],
  occupied: Set<string>,
): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const key = `${match.index}:${match[0].length}`;
    if ([...occupied].some((range) => rangesOverlap(range, match.index, match[0].length))) continue;
    const link = map(match);
    if (!link.target) continue;
    output.push(link);
    occupied.add(key);
  }
}

function deduplicateLinks(links: readonly ExtractedMarkdownLink[]): ExtractedMarkdownLink[] {
  const seen = new Set<string>();
  const result: ExtractedMarkdownLink[] = [];
  for (const link of links) {
    const target = link.kind === "external" ? normalizeExternalUrl(link.target) : link.target;
    if (!target) continue;
    const key = `${link.kind}:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...link, target });
  }
  return result;
}

function stripCode(markdown: string): string {
  return markdown
    .replace(/^(?: {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gmu, (block) =>
      block.replace(/[^\n]/gu, " "),
    )
    .replace(/`[^`\n]*`/gu, (code) => " ".repeat(code.length));
}

function rangesOverlap(range: string, start: number, length: number): boolean {
  const [storedStart = 0, storedLength = 0] = range.split(":").map(Number);
  return start < storedStart + storedLength && start + length > storedStart;
}

function decodeAngleTarget(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[),.;:!?]+$/gu, "");
}

function isHttpsUrl(value: string): boolean {
  return /^https:\/\//iu.test(value);
}
