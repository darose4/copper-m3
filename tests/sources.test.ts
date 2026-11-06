// The Sources list under an answer: only the document pages the reply cites,
// and only ones the document search really found.
import { describe, expect, it } from "vitest";
import type { Step } from "@/lib/copper/assistant/progress";
import { citedSources, linkCitations } from "@/lib/copper/assistant/sources";

const match = (title: string, page: number, file: string) => ({
  title,
  page,
  text: "…",
  url: `/docs/${file}.pdf#page=${page}`,
  score: 0.5,
});

const HOME = "Copper Home User Guide";
const FAQ = "Copper Plus FAQ";

const search = (...matches: ReturnType<typeof match>[]): Step => ({
  type: "tool",
  id: "call-1",
  name: "search_docs",
  state: "done",
  input: { question: "q" },
  output: { status: "ok", matches },
});

describe("linkCitations", () => {
  const steps = [search(match(HOME, 9, "copper-home-user-guide"))];

  it("links each [Title, p. N] citation to that PDF page", () => {
    const parts = linkCitations(
      `Hold both buttons. [${HOME}, p. 9] Then wait. [${HOME}, p. 9]`,
      steps,
    );
    expect(parts.filter((p) => p.url)).toEqual([
      { text: `[${HOME}, p. 9]`, url: "/docs/copper-home-user-guide.pdf#page=9" },
      { text: `[${HOME}, p. 9]`, url: "/docs/copper-home-user-guide.pdf#page=9" },
    ]);
    expect(parts.map((p) => p.text).join("")).toBe(
      `Hold both buttons. [${HOME}, p. 9] Then wait. [${HOME}, p. 9]`,
    );
  });

  it("leaves a citation for a page that was never found as plain text", () => {
    const parts = linkCitations(`Made up. [${HOME}, p. 40]`, steps);
    expect(parts.some((p) => p.url)).toBe(false);
  });
});

describe("citedSources", () => {
  const steps = [
    search(
      match(HOME, 9, "copper-home-user-guide"),
      match(HOME, 3, "copper-home-user-guide"),
      match(FAQ, 2, "copper-plus-faq"),
    ),
  ];

  it("lists the pages the reply cites, with a link to each", () => {
    expect(citedSources(`Hold both buttons (${HOME}, page 9).`, steps)).toEqual(
      [
        {
          title: HOME,
          page: 9,
          url: "/docs/copper-home-user-guide.pdf#page=9",
        },
      ],
    );
  });

  it("leaves out pages that were searched but not cited", () => {
    const sources = citedSources(`It is on (${HOME}, page 9).`, steps);
    expect(sources.map((s) => `${s.title} ${s.page}`)).toEqual([`${HOME} 9`]);
  });

  it("ties each page to its own document", () => {
    // Page 2 is cited for the FAQ, not for the Home guide, so only the FAQ's page 2 counts.
    const sources = citedSources(
      `See (${FAQ}, page 2) and (${HOME}, page 9).`,
      steps,
    );
    expect(sources.map((s) => `${s.title} ${s.page}`).sort()).toEqual([
      `${HOME} 9`,
      `${FAQ} 2`,
    ]);
    const onlyFaq = citedSources(`See (${FAQ}, page 2).`, steps);
    expect(onlyFaq.map((s) => `${s.title} ${s.page}`)).toEqual([`${FAQ} 2`]);
  });

  it("understands several pages cited at once", () => {
    for (const reply of [
      `(${HOME}, pages 3 and 9)`,
      `(${HOME}, pages 3, 9)`,
      `(${HOME}, pp. 3 & 9)`,
      `${HOME}, page 3 and ${HOME}, page 9.`,
    ]) {
      expect(
        citedSources(reply, steps)
          .map((s) => s.page)
          .sort(),
        reply,
      ).toEqual([3, 9]);
    }
  });

  it("ignores case, and a page that was never found by the search", () => {
    expect(
      citedSources(`(${HOME.toUpperCase()}, PAGE 9)`, steps).map((s) => s.page),
    ).toEqual([9]);
    expect(citedSources(`(${HOME}, page 7)`, steps)).toEqual([]);
  });

  it("lists a page once, however many searches found it", () => {
    const twice = [
      search(match(HOME, 9, "copper-home-user-guide")),
      search(match(HOME, 9, "copper-home-user-guide")),
    ];
    expect(citedSources(`(${HOME}, page 9)`, twice)).toHaveLength(1);
  });

  it("shows nothing when the reply cites nothing, or nothing was searched", () => {
    expect(citedSources("Hold both buttons for 15 seconds.", steps)).toEqual(
      [],
    );
    expect(citedSources(`(${HOME}, page 9)`, [])).toEqual([]);
    const otherTool: Step = {
      type: "tool",
      id: "c",
      name: "get_prices",
      state: "done",
      output: { products: [] },
    };
    expect(citedSources(`(${HOME}, page 9)`, [otherTool])).toEqual([]);
  });

  it("ignores a search that failed", () => {
    const failed: Step = {
      type: "tool",
      id: "c",
      name: "search_docs",
      state: "done",
      output: { status: "unavailable", message: "no" },
    };
    expect(citedSources(`(${HOME}, page 9)`, [failed])).toEqual([]);
  });

  it("copes with a title that has special characters", () => {
    const odd = [search(match("Terms (2026) + Privacy?", 4, "terms"))];
    expect(
      citedSources("(Terms (2026) + Privacy?, page 4)", odd).map((s) => s.page),
    ).toEqual([4]);
  });
});
