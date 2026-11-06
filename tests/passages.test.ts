// @vitest-environment node
// The documents-to-passages pipeline: how a page is cut up, what the saved
// passages file holds, and the embedding call that made it.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MockEmbeddingModelV4 } from "ai/test";
import { extractText, getDocumentProxy } from "unpdf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callEmbed } from "@/lib/ai/call";
import { EMBEDDING_MODEL } from "@/lib/ai/models";
import { DOCUMENTS } from "@/lib/copper/documents";
import {
  cleanPage,
  MAX_PASSAGE_CHARS,
  normalize,
  passageText,
  splitLong,
  splitPage,
  splitSentences,
} from "@/lib/copper/passage-split";
import { passages, passagesModel } from "@/lib/copper/passages";

// ---------------------------------------------------------------------------
// Cutting a page into passages
// ---------------------------------------------------------------------------

const HEADER =
  "Copper Home User Guide Meet Copper Home\nCSL-UG-0101-EN Rev. C 2\n© 2026 Copper State Labs, Inc. · Fictional company and documents, for educational use only.\n";

describe("cutting a page into passages", () => {
  it("drops the three-line page header and joins the rest onto one line", () => {
    const page = `${HEADER}2 Meet Copper Home\nIt is a speaker.\nIt has a display.`;
    expect(cleanPage(page)).toBe(
      "2 Meet Copper Home It is a speaker. It has a display.",
    );
  });

  it("keeps the whole page when there is no header to drop", () => {
    expect(cleanPage("Just one line.\nAnd another.")).toBe(
      "Just one line. And another.",
    );
  });

  it("splits text into sentences", () => {
    expect(splitSentences("One. Two! Three? Four.")).toEqual([
      "One.",
      "Two!",
      "Three?",
      "Four.",
    ]);
  });

  it("groups three sentences to a passage", () => {
    const page = `${HEADER}A one. B two. C three. D four. E five. F six.`;
    expect(splitPage(page)).toEqual([
      "A one. B two. C three.",
      "D four. E five. F six.",
    ]);
  });

  it("joins a lone leftover sentence onto the passage before it", () => {
    const page = `${HEADER}A one. B two. C three. D four.`;
    expect(splitPage(page)).toEqual(["A one. B two. C three. D four."]);
  });

  it("keeps a short leftover of two sentences as its own passage", () => {
    const page = `${HEADER}A one. B two. C three. D four. E five.`;
    expect(splitPage(page)).toEqual([
      "A one. B two. C three.",
      "D four. E five.",
    ]);
  });

  it("leaves a passage under the size limit alone", () => {
    expect(splitLong("A short passage.")).toEqual(["A short passage."]);
    const justUnder = "word ".repeat(89).trim(); // 444 characters
    expect(splitLong(justUnder)).toEqual([justUnder]);
  });

  it("cuts a long run of words into overlapping pieces, at word boundaries, losing nothing", () => {
    // A flattened table: lots of words and no full stops.
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`);
    const text = words.join(" ");
    const pieces = splitLong(text);
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
      expect(piece).toBe(piece.trim());
      // Every piece is whole words from the text, never a word cut in half.
      for (const word of piece.split(" ")) expect(words).toContain(word);
    }
    // Neighbouring pieces share some words, so a row cut in two is whole in one of them.
    for (let i = 1; i < pieces.length; i++) {
      const before = new Set(pieces[i - 1].split(" "));
      expect(
        pieces[i].split(" ").some((word) => before.has(word)),
        `piece ${i} overlaps`,
      ).toBe(true);
    }
    // Together the pieces still cover every word.
    expect(new Set(pieces.flatMap((p) => p.split(" "))).size).toBe(
      words.length,
    );
    expect(pieces[0].startsWith("w0 ")).toBe(true);
    expect(pieces.at(-1)!.endsWith("w299")).toBe(true);
  });

  it("finds a table row in its own passage instead of lost in a long one", () => {
    const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(" ");
    const page = `${HEADER}Code What it means ${filler} C-63 Temperature protection: too hot to operate Move it to a cool place for 30 minutes ${filler}`;
    const passages = splitPage(page);
    const row = passages.find((p) => p.includes("C-63"))!;
    expect(row).toContain("30 minutes");
    expect(row.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
    expect(passages.every((p) => p.length <= MAX_PASSAGE_CHARS)).toBe(true);
  });

  it("makes no passages from a page with only a header", () => {
    expect(splitPage(HEADER)).toEqual([]);
  });

  it("starts each passage's text with the document title", () => {
    expect(passageText("Copper Plus FAQ", "Hello there.")).toBe(
      "Copper Plus FAQ: Hello there.",
    );
  });

  it("scales an embedding to length 1", () => {
    const v = normalize([3, 4]);
    expect(v).toEqual([0.6, 0.8]);
    expect(Math.hypot(...normalize([1, 2, 3, 4]))).toBeCloseTo(1, 10);
    expect(normalize([0, 0])).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// The saved passages file
// ---------------------------------------------------------------------------

describe("the saved passages file (lib/copper/data/passages.json)", () => {
  it("was made with the embedding model the app asks with", () => {
    expect(passagesModel).toBe(EMBEDDING_MODEL.id);
  });

  it("gives every passage its title, page and a full-length embedding", () => {
    expect(passages.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const p of passages) {
      expect(ids.has(p.id), `duplicate id ${p.id}`).toBe(false);
      ids.add(p.id);
      expect(p.text.startsWith(`${p.title}: `), p.id).toBe(true);
      // Passages are short enough to be about one thing.
      expect(p.text.length - p.title.length - 2, p.id).toBeLessThanOrEqual(
        MAX_PASSAGE_CHARS,
      );
      expect(Number.isInteger(p.page) && p.page >= 1, p.id).toBe(true);
      expect(p.embedding).toHaveLength(EMBEDDING_MODEL.dimensions);
      expect(Math.hypot(...p.embedding), p.id).toBeCloseTo(1, 3);
    }
  });

  it("has no repeated page headers in the text", () => {
    for (const p of passages) {
      expect(p.text, p.id).not.toMatch(
        /Fictional company and documents|CSL-(UG|KB|LGL)-/,
      );
    }
  });

  it("covers every page of every document in public/docs", async () => {
    for (const doc of DOCUMENTS) {
      const bytes = await readFile(path.join("public", doc.file));
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text: pages } = await extractText(pdf, { mergePages: false });
      const mine = passages.filter((p) => p.documentId === doc.id);
      expect(mine.length, doc.title).toBeGreaterThan(0);
      expect(mine.every((p) => p.title === doc.title)).toBe(true);
      for (let page = 1; page <= pages.length; page++) {
        // A page with no text after its header has nothing to make a passage from.
        const hasText = cleanPage(pages[page - 1]).length > 0;
        expect(
          mine.some((p) => p.page === page),
          `${doc.title}, page ${page}`,
        ).toBe(hasText);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The embedding call
// ---------------------------------------------------------------------------

describe("callEmbed", () => {
  let model: MockEmbeddingModelV4;
  beforeEach(() => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    model = new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: 100,
      doEmbed: async ({ values }) => ({
        embeddings: values.map((_, i) => [i, 1]),
        usage: { tokens: values.length * 10 },
        warnings: [],
      }),
    });
    vi.doMock("@ai-sdk/google", () => ({
      createGoogleGenerativeAI: () => ({ embedding: () => model }),
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock("@ai-sdk/google");
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    return import("@/lib/ai/call");
  }

  it("returns one embedding per text, in order, and logs one row with tokens and cost", async () => {
    const logged: Record<string, unknown>[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      if (args[0] === "[ai_calls]") logged.push(JSON.parse(args[1] as string));
    });
    const { callEmbed } = await load();
    const result = await callEmbed({ module: 3, feature: "embed-passages" }, [
      "a",
      "b",
      "c",
    ]);
    expect(result).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      module: 3,
      feature: "embed-passages",
      model: EMBEDDING_MODEL.id,
      input_tokens: 30,
      ok: true,
    });
    expect(logged[0].cost_usd).toBeCloseTo((30 * 0.15) / 1_000_000, 12);
  });

  it("asks for the right size and kind of embedding", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { callEmbed } = await load();
    await callEmbed(
      { module: 3, feature: "embed-passages" },
      ["a"],
      "document",
    );
    await callEmbed({ module: 3, feature: "embed-question" }, ["a"], "query");
    const [docCall, queryCall] = model.doEmbedCalls;
    expect(docCall.providerOptions?.google).toMatchObject({
      outputDimensionality: EMBEDDING_MODEL.dimensions,
      taskType: "RETRIEVAL_DOCUMENT",
    });
    expect(queryCall.providerOptions?.google).toMatchObject({
      taskType: "RETRIEVAL_QUERY",
    });
  });

  it("needs an AI key, and says so instead of calling Google", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const { callEmbed, AiNotConfiguredError } = await load();
    await expect(
      callEmbed({ module: 3, feature: "x" }, ["a"]),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(model.doEmbedCalls).toHaveLength(0);
  });
});

// Keeps the static import above used, so a typo in the export name fails loudly.
void callEmbed;
