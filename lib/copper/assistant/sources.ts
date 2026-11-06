// Which document pages an answer actually leaned on. Copper cites them in its
// reply, like (Copper Home User Guide, page 9), so the Sources list under an
// answer shows only the pages it cited, never every passage that was searched.
// No server code in here, so the chat panel can import it.
import type { Step } from "@/lib/copper/assistant/progress";

export type Source = {
  title: string;
  page: number;
  /** Opens the PDF at that page. */
  url: string;
};

type Rec = Record<string, unknown>;

/** Every passage the answer's document searches found, best match first. */
function searched(steps: Step[]): Source[] {
  const found: Source[] = [];
  for (const step of steps) {
    if (step.type !== "tool" || step.name !== "search_docs") continue;
    const output = step.output as Rec | undefined;
    if (output?.status !== "ok" || !Array.isArray(output.matches)) continue;
    for (const match of output.matches as Rec[]) {
      if (typeof match.title !== "string" || typeof match.page !== "number")
        continue;
      found.push({
        title: match.title,
        page: match.page,
        url: typeof match.url === "string" ? match.url : "",
      });
    }
  }
  return found;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The page numbers the reply cites for one document: "Title, page 9" or "Title, pages 4 and 9". */
function citedPages(reply: string, title: string): Set<number> {
  const citation = new RegExp(
    `${escapeRegExp(title)}[,:]?\\s*(?:pages?|pp?\\.)\\s*(\\d+(?:\\s*(?:,|and|&|–|-|to)\\s*\\d+)*)`,
    "gi",
  );
  const pages = new Set<number>();
  for (const [, numbers] of reply.matchAll(citation)) {
    for (const n of numbers.match(/\d+/g) ?? []) pages.add(Number(n));
  }
  return pages;
}

export type ReplyPart = { text: string; url?: string };

/**
 * The reply cut into plain text and citations. A citation like
 * [Copper Home User Guide, p. 9] gets the link that opens that PDF page, taken
 * from what search_docs really returned (the model never writes URLs). A
 * citation for a page that was not found stays plain text.
 */
export function linkCitations(reply: string, steps: Step[]): ReplyPart[] {
  const urls = new Map<string, string>();
  for (const s of searched(steps)) urls.set(`${s.title}#${s.page}`, s.url);
  const parts: ReplyPart[] = [];
  let last = 0;
  for (const m of reply.matchAll(
    /\[([^\[\]]+?),\s*(?:pages?|pp?\.)\s*(\d+)\s*\]/gi,
  )) {
    const url = urls.get(`${m[1].trim()}#${Number(m[2])}`);
    if (!url) continue;
    if (m.index > last) parts.push({ text: reply.slice(last, m.index) });
    parts.push({ text: m[0], url });
    last = m.index + m[0].length;
  }
  if (last < reply.length) parts.push({ text: reply.slice(last) });
  return parts;
}

/** The document pages the reply cites that its searches really found, without repeats. */
export function citedSources(reply: string, steps: Step[]): Source[] {
  const cited = new Map<string, Set<number>>();
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const source of searched(steps)) {
    if (!cited.has(source.title))
      cited.set(source.title, citedPages(reply, source.title));
    const key = `${source.title}#${source.page}`;
    if (cited.get(source.title)!.has(source.page) && !seen.has(key)) {
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}
