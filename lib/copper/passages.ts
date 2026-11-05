// The company's documents, cut into passages and embedded, ready to search.
// They live in one JSON file (built by `npm run passages:build` from the PDFs
// in public/docs), and importing it here loads the whole thing into memory
// once, when the app starts.
import data from "@/lib/copper/data/passages.json";

export type Passage = {
  id: string;
  documentId: string;
  /** The document's title, e.g. "Copper Home User Guide". */
  title: string;
  /** The page the passage is on, starting at 1. */
  page: number;
  /** The passage itself. It starts with the document title. */
  text: string;
  /** What the passage means, as numbers (length 1, so a dot product compares two). */
  embedding: number[];
};

export type PassagesFile = {
  model: string;
  dimensions: number;
  passages: Passage[];
};

const file = data as PassagesFile;

/** Every passage, in memory. */
export const passages: Passage[] = file.passages;

/** The embedding model that made them: a question must be embedded with the same one. */
export const passagesModel = file.model;
