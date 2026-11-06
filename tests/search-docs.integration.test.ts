// @vitest-environment node
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// search_docs with real Gemini embeddings, on the three questions the tool was
// built for. It checks the right document page is among the 5 passages brought
// back, and that every passage has its title, page and a link to that page.
// Runs only when a Google key is set; otherwise it's skipped.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const ready = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

const HOME = "Copper Home User Guide";
const FAQ = "Copper Plus FAQ";
const TERMS = "Copper State Labs Terms and Conditions";

describe.skipIf(!ready)("search_docs (live Google key)", () => {
  async function search(question: string) {
    const { searchDocs } = await import("@/lib/copper/assistant/tools");
    vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await searchDocs({ question });
    vi.restoreAllMocks();
    if (result.status !== "ok") throw new Error(result.message);
    return result.matches;
  }

  const found = (
    matches: Awaited<ReturnType<typeof search>>,
    title: string,
    page: number,
  ) => matches.some((m) => m.title === title && m.page === page);

  it("brings back 5 passages, each with its document title, page and a link to that page", async () => {
    const matches = await search("reset Wi-Fi");
    expect(matches).toHaveLength(5);
    for (const m of matches) {
      expect(m.title.length).toBeGreaterThan(0);
      expect(Number.isInteger(m.page) && m.page >= 1).toBe(true);
      expect(m.url).toMatch(new RegExp(`^/docs/.+\\.pdf#page=${m.page}$`));
      expect(m.text.length).toBeGreaterThan(0);
    }
    // Closest first.
    const scores = matches.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  }, 60_000);

  it('"C-47" finds the Copper Home error-code table (page 9)', async () => {
    const matches = await search("C-47");
    expect(
      found(matches, HOME, 9),
      JSON.stringify(matches.map((m) => [m.title, m.page])),
    ).toBe(true);
    // The passage that actually names C-47 is the best match.
    expect(matches[0].text).toMatch(/C-47/);
  }, 60_000);

  it('"annual refund" finds the Copper Plus FAQ (page 5) and the Terms refund table (page 4)', async () => {
    const matches = await search("annual refund");
    expect(found(matches, FAQ, 5)).toBe(true);
    expect(found(matches, TERMS, 4)).toBe(true);
    expect(matches.slice(0, 3).some((m) => /14 days/.test(m.text))).toBe(true);
  }, 60_000);

  it('"reset Wi-Fi" finds the Copper Home page about changing the Wi-Fi network (page 4)', async () => {
    const matches = await search("reset Wi-Fi");
    expect(
      found(matches, HOME, 4),
      JSON.stringify(matches.map((m) => [m.title, m.page])),
    ).toBe(true);
    expect(
      matches.slice(0, 2).some((m) => /Change network|Wi-Fi/i.test(m.text)),
    ).toBe(true);
  }, 60_000);
});
