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
  normalize,
  passageText,
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
