import { locateEntryBlocks } from "../storage";

const METADATA_PATTERN = /<!--\s*timepoint(?=\s)([\s\S]*?)-->/iu;
const HEADING_PATTERN = /^##[ \t]+[^\r\n]+$/mu;

export interface NativeEditorPreparation {
  /** Insert immediately before positioning the native editor cursor. */
  offset: number;
  text: string;
}

export interface NativeEditorTarget {
  /** Final cursor offset after applying `preparation`, when present. */
  cursorOffset: number;
  /** Existing user-authored content range, used to center the native editor. */
  contentStart: number;
  contentEnd: number;
  /** Legacy empty blocks may need one blank line before they can be edited safely. */
  preparation?: NativeEditorPreparation;
}

/**
 * Locate the user-owned Markdown body inside one managed TimePoint block.
 *
 * The returned position deliberately skips the readable time heading and the
 * hidden Schema 1 metadata. It never guesses when markers are duplicated or
 * ambiguous, because placing a cursor in the wrong managed block would be a
 * data-integrity bug.
 */
export function locateNativeEditorTarget(
  markdown: string,
  entryId: string,
): NativeEditorTarget | null {
  const scan = locateEntryBlocks(markdown);
  const blocks = scan.blocks.filter((block) => block.id === entryId);
  const markerCount = scan.markerIds.filter((id) => id === entryId).length;
  if (blocks.length !== 1 || markerCount !== 2) return null;

  const block = blocks[0];
  if (!block) return null;
  const managedContent = markdown.slice(block.contentStart, block.contentEnd);
  const metadata = METADATA_PATTERN.exec(managedContent);
  const heading = HEADING_PATTERN.exec(managedContent);
  const scaffoldEnd = Math.max(
    metadata ? metadata.index + metadata[0].length : 0,
    heading ? heading.index + heading[0].length : 0,
  );
  const remainderStart = block.contentStart + scaffoldEnd;
  const remainder = markdown.slice(remainderStart, block.contentEnd);

  if (remainder.trim().length === 0) {
    return locateEmptyBody(markdown, remainderStart, remainder);
  }

  const leadingBlankLines = /^(?:[ \t]*\r?\n)+/u.exec(remainder)?.[0].length ?? 0;
  const contentStart = remainderStart + leadingBlankLines;
  const content = markdown.slice(contentStart, block.contentEnd);
  const trailingBlankLines = /(?:\r?\n[ \t]*)+$/u.exec(content);
  const contentEnd = trailingBlankLines
    ? contentStart + trailingBlankLines.index
    : block.contentEnd;

  return {
    cursorOffset: contentStart,
    contentStart,
    contentEnd: Math.max(contentStart, contentEnd),
  };
}

function locateEmptyBody(
  markdown: string,
  remainderStart: number,
  remainder: string,
): NativeEditorTarget {
  const firstLineBreak = /\r?\n/u.exec(remainder);
  const fallbackLineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";

  if (!firstLineBreak) {
    const cursorOffset = remainderStart + fallbackLineBreak.length;
    return {
      cursorOffset,
      contentStart: cursorOffset,
      contentEnd: cursorOffset,
      preparation: { offset: remainderStart, text: fallbackLineBreak.repeat(2) },
    };
  }

  const lineBreak = firstLineBreak[0];
  const cursorOffset = remainderStart + firstLineBreak.index + lineBreak.length;
  const afterFirstLineBreak = remainder.slice(firstLineBreak.index + lineBreak.length);
  if (/\r?\n/u.test(afterFirstLineBreak)) {
    return { cursorOffset, contentStart: cursorOffset, contentEnd: cursorOffset };
  }

  return {
    cursorOffset,
    contentStart: cursorOffset,
    contentEnd: cursorOffset,
    preparation: { offset: cursorOffset, text: lineBreak },
  };
}
