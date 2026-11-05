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
  return groups.map((group) => group.join(" "));
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
