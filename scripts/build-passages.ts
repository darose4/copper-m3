// Reads every PDF in public/docs, cuts each page into passages of a few
// sentences, embeds them with Gemini and saves them all to one JSON file,
// lib/copper/data/passages.json, which the app loads into memory at startup.
//
// Run it with: npm run passages:build
// It needs GOOGLE_GENERATIVE_AI_API_KEY in .env.local, and runs again any time
// the PDFs change.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { callEmbed } from "@/lib/ai/call";
import { EMBEDDING_MODEL } from "@/lib/ai/models";
import { DOCUMENTS } from "@/lib/copper/documents";
import { normalize, passageText, splitPage } from "@/lib/copper/passage-split";
import type { Passage, PassagesFile } from "@/lib/copper/passages";

const OUTPUT = path.join("lib", "copper", "data", "passages.json");

/** Rounds to 6 decimals, which keeps the file small and changes nothing that matters. */
const round = (x: number) => Math.round(x * 1e6) / 1e6;

async function main() {
  const drafts: Omit<Passage, "embedding">[] = [];
  const counts: { title: string; pages: number; passages: number }[] = [];

  for (const doc of DOCUMENTS) {
    const bytes = await readFile(path.join("public", doc.file));
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text: pages } = await extractText(pdf, { mergePages: false });

    let made = 0;
    pages.forEach((pageText, index) => {
      const page = index + 1;
      splitPage(pageText).forEach((body, n) => {
        drafts.push({
          id: `${doc.id}-p${page}-${n + 1}`,
          documentId: doc.id,
          title: doc.title,
          page,
          text: passageText(doc.title, body),
        });
        made += 1;
      });
    });
    counts.push({ title: doc.title, pages: pages.length, passages: made });
  }

  console.log(
    `Embedding ${drafts.length} passages with ${EMBEDDING_MODEL.id}...`,
  );
  const embeddings = await callEmbed(
    { module: 3, feature: "embed-passages" },
    drafts.map((draft) => draft.text),
    "document",
  );
  if (embeddings.length !== drafts.length) {
    throw new Error(
      `Asked for ${drafts.length} embeddings but got ${embeddings.length}.`,
    );
  }

  const file: PassagesFile = {
    model: EMBEDDING_MODEL.id,
    dimensions: EMBEDDING_MODEL.dimensions,
    passages: drafts.map((draft, i) => ({
      ...draft,
      embedding: normalize(embeddings[i]).map(round),
    })),
  };
  await writeFile(OUTPUT, JSON.stringify(file) + "\n", "utf8");

  console.log(`\nSaved ${file.passages.length} passages to ${OUTPUT}\n`);
  for (const { title, pages, passages } of counts) {
    console.log(`${String(passages).padStart(4)}  ${title}  (${pages} pages)`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
