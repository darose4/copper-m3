// Cuts a PDF page into passages: short runs of a few sentences, each small
// enough to be about one thing. Kept free of PDF and AI code so it is easy to
// test. The build script (scripts/build-passages.ts) uses it.

/** How many sentences go into one passage. */
export const SENTENCES_PER_PASSAGE = 3;

// Every page in the company's PDFs starts with a three-line header that ends
// with this copyright line. It repeats on every page, so it would only add
// noise to each passage.
const HEADER_END = /^©\s*\d{4}\s+Copper State Labs/;

/** The page's text without its running header, on one line. */
export function cleanPage(pageText: string): string {
  const lines = pageText.split("\n");
  const headerEnd = lines.findIndex((line) => HEADER_END.test(line.trim()));
  const body = headerEnd >= 0 ? lines.slice(headerEnd + 1) : lines;
  return body.join(" ").replace(/\s+/g, " ").trim();
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/** The text split into sentences, in order. */
export function splitSentences(text: string): string[] {
  return [...sentenceSegmenter.segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
}

/**
 * One page's text as passages of a few sentences each. A lone sentence left
 * over at the end joins the passage before it, so no passage is a stray line.
 * A passage that runs past MAX_PASSAGE_CHARS (a flattened table, say) is cut
 * into smaller overlapping pieces.
 */
export function splitPage(
  pageText: string,
  sentencesPerPassage = SENTENCES_PER_PASSAGE,
): string[] {
  const sentences = splitSentences(cleanPage(pageText));
  const groups: string[][] = [];
  for (let i = 0; i < sentences.length; i += sentencesPerPassage) {
    groups.push(sentences.slice(i, i + sentencesPerPassage));
  }
  if (groups.length > 1 && groups.at(-1)!.length === 1) {
    groups[groups.length - 2].push(...groups.pop()!);
  }
  return groups.flatMap((group) => splitLong(group.join(" ")));
}

/** A passage longer than this gets cut into smaller overlapping pieces. */
export const MAX_PASSAGE_CHARS = 450;

/** How much of the end of one piece is repeated at the start of the next. */
const OVERLAP_CHARS = 80;

/**
 * Cuts text longer than `max` characters into pieces that overlap a little,
 * always at word boundaries. Tables come out of a PDF as one long run of words
 * with no full stops, so a whole table can end up as a single "sentence". Left
 * alone it would be one blurry passage about many things; in pieces, each row
 * can be found on its own.
 */
export function splitLong(
  text: string,
  max = MAX_PASSAGE_CHARS,
  overlap = OVERLAP_CHARS,
): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + overlap) end = space;
    }
    pieces.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    // The next piece starts a little before this one ended, at a word boundary.
    const space = text.indexOf(" ", Math.max(end - overlap, start + 1));
    start = space === -1 || space >= end ? end : space + 1;
  }
  return pieces;
}

/** The text that gets embedded and shown: it starts with the document title. */
export function passageText(title: string, body: string): string {
  return `${title}: ${body}`;
}

/**
 * Scales an embedding to length 1, so comparing two of them is just a dot
 * product. Google recommends this for the shorter (768-number) versions.
 */
export function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return length === 0 ? vector : vector.map((x) => x / length);
}
