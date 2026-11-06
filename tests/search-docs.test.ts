// @vitest-environment node
// search_docs: Ask Copper's tool for answering from the company's PDFs.
// It embeds the question, finds the closest passages and says which document
// and page each one is on. The embedding call is faked here, so these tests
// need no AI key and cost nothing.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@/lib/ai/call");
  vi.doUnmock("@/lib/copper/passages");
  vi.resetModules();
});

type FakePassage = {
  id: string;
  documentId: string;
  title: string;
  page: number;
  text: string;
  embedding: number[];
};

const fake = (
  id: string,
  page: number,
  body: string,
  embedding: number[],
  documentId = "copper-home-user-guide",
  title = "Copper Home User Guide",
): FakePassage => ({
  id,
  documentId,
  title,
  page,
  text: `${title}: ${body}`,
  embedding,
});

/** Loads the tool with a fake embedding call and, optionally, fake passages. */
async function load(options: {
  embedding?: number[] | Error;
  passages?: FakePassage[];
}) {
  const callEmbed = vi.fn(async () => {
    if (options.embedding instanceof Error) throw options.embedding;
    return [options.embedding ?? [1, 0]];
  });
  vi.doMock("@/lib/ai/call", () => ({ callEmbed }));
  if (options.passages) {
    vi.doMock("@/lib/copper/passages", () => ({ passages: options.passages }));
  }
  vi.resetModules();
  const tools = await import("@/lib/copper/assistant/tools");
  return { ...tools, callEmbed };
}

describe("search_docs", () => {
  it("brings back the closest passages first, with their document title and page", async () => {
    const { searchDocs } = await load({
      embedding: [1, 0],
      passages: [
        fake("far", 3, "Unrelated.", [0, 1]),
        fake("close", 9, "Hold both buttons for 15 seconds.", [1, 0]),
        fake("near", 4, "Press the button.", [0.8, 0.6]),
      ],
    });
    const result = await searchDocs({ question: "How do I reset it?" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.matches.map((m) => [m.title, m.page])).toEqual([
      ["Copper Home User Guide", 9],
      ["Copper Home User Guide", 4],
      ["Copper Home User Guide", 3],
    ]);
    expect(result.matches.map((m) => m.score)).toEqual([1, 0.8, 0]);
  });

  it("shows the passage without the title it is stored with, and links to its page", async () => {
    const { searchDocs } = await load({
      embedding: [1, 0],
      passages: [fake("a", 9, "Hold both buttons for 15 seconds.", [1, 0])],
    });
    const result = await searchDocs({ question: "reset the speaker" });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.matches[0].text).toBe("Hold both buttons for 15 seconds.");
    expect(result.matches[0].url).toBe(
      "/docs/copper-home-user-guide.pdf#page=9",
    );
  });

  it("brings back at most five passages", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      fake(`p${i}`, i + 1, `Passage ${i}.`, [1, i / 10]),
    );
    const { searchDocs } = await load({
      embedding: [1, 0],
      passages: many,
    });
    const result = await searchDocs({ question: "anything at all" });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.matches).toHaveLength(5);
  });

  it("embeds the question as a query, logged under its own feature", async () => {
    const { searchDocs, callEmbed } = await load({
      embedding: [1, 0],
      passages: [fake("a", 1, "Text.", [1, 0])],
    });
    await searchDocs({ question: "What is Copper Plus?" });
    expect(callEmbed).toHaveBeenCalledWith(
      { module: 3, feature: "search-docs" },
      ["What is Copper Plus?"],
      "query",
    );
  });

  it("says the documents can't be searched when the embedding call fails", async () => {
    const { searchDocs } = await load({
      embedding: new Error("Google is down"),
      passages: [fake("a", 1, "Text.", [1, 0])],
    });
    const result = await searchDocs({ question: "What is Copper Plus?" });
    expect(result).toEqual({
      status: "unavailable",
      message: "The documents can't be searched right now.",
    });
  });

  it("says so, without calling Google, when no passages are loaded", async () => {
    const { searchDocs, callEmbed } = await load({ passages: [] });
    const result = await searchDocs({ question: "What is Copper Plus?" });
    expect(result.status).toBe("unavailable");
    expect(callEmbed).not.toHaveBeenCalled();
  });

  it("only accepts a real question", async () => {
    const { searchDocsInput } = await load({});
    expect(searchDocsInput.safeParse({ question: "reset" }).success).toBe(true);
    expect(searchDocsInput.parse({ question: "  reset it  " }).question).toBe(
      "reset it",
    );
    for (const bad of [
      {},
      { question: "" },
      { question: "  ?  " },
      { question: "x".repeat(301) },
      { question: 42 },
    ]) {
      expect(searchDocsInput.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it("finds the saved passage a question's embedding matches exactly", async () => {
    // The real saved passages: a question that means exactly what a passage
    // means must bring that passage back first.
    const { passages } = await import("@/lib/copper/passages");
    const target = passages.find(
      (p) => p.documentId === "copper-terms-and-conditions" && p.page === 4,
    )!;
    const { searchDocs } = await load({ embedding: target.embedding });
    const result = await searchDocs({
      question: "Is Copper Plus refundable?",
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.matches[0].title).toBe(
      "Copper State Labs Terms and Conditions",
    );
    expect(result.matches[0].page).toBe(4);
    expect(result.matches[0].score).toBeGreaterThan(0.99);
    expect(result.matches[0].url).toBe(
      "/docs/copper-terms-and-conditions.pdf#page=4",
    );
  });

  it("is one of Copper's tools, described for the model, and the instructions say when to use it", async () => {
    const { copperTools } = await load({});
    const { COPPER_INSTRUCTIONS } =
      await import("@/lib/copper/assistant/instructions");
    const { TOOL_LABELS } = await import("@/lib/copper/assistant/progress");
    expect(Object.keys(copperTools)).toContain("search_docs");
    expect(copperTools.search_docs.description).toMatch(/passages/);
    expect(typeof copperTools.search_docs.execute).toBe("function");
    expect(TOOL_LABELS.search_docs).toBeTruthy();
    expect(COPPER_INSTRUCTIONS).toContain("search_docs");
    expect(COPPER_INSTRUCTIONS).toMatch(/page/i);
  });
});
