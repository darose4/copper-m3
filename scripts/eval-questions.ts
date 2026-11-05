// Asks Ask Copper a fixed batch of questions, each in a fresh conversation, and
// checks every reply against what the company's PDFs really say: the right
// facts, the right page cited, and no guessing when the documents don't cover
// something.
//
// Run it with: npm run eval
// It makes real calls to Google (about 30 requests, a couple of cents at most),
// so it needs GOOGLE_GENERATIVE_AI_API_KEY (and AI_MODEL) in .env.local. It
// pauses between questions to stay under Google's per-minute limits, and exits
// with an error if any question fails, so it can also run in a script.
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import { citedSources } from "@/lib/copper/assistant/sources";

type Case = {
  q: string;
  /** Every one of these must match the reply. */
  must: RegExp[];
  /** None of these may match the reply. */
  mustNot?: RegExp[];
  /** A document page the reply should cite, e.g. "Copper Notes User Guide#8". */
  cite?: string;
  /** What the question is checking. */
  note: string;
};

const CASES: Case[] = [
  {
    q: "What does error code C-63 mean on Copper Notes?",
    must: [/hot|temperature/i, /30 minutes/i],
    cite: "Copper Notes User Guide#8",
    note: "error code lookup",
  },
  {
    q: "How long is the warranty on Copper Home?",
    must: [/2[- ]year|two[- ]year/i],
    cite: "Copper Home User Guide#10",
    note: "warranty, product-specific",
  },
  {
    q: "How long is the Copper Notes warranty, and what doesn't it cover?",
    must: [/1[- ]year|one[- ]year/i, /heat|vehicle|car/i],
    cite: "Copper Notes User Guide#9",
    note: "warranty plus an exclusion",
  },
  {
    q: "How do I factory reset Copper Notes?",
    must: [/center button/i, /20 seconds/i],
    mustNot: [/volume-down/i, /15 seconds/i],
    cite: "Copper Notes User Guide#8",
    note: "must not mix up with Copper Home's reset",
  },
  {
    q: "What happens to my data if I cancel Copper Plus?",
    must: [/free plan/i, /30 days/i],
    cite: "Copper Plus FAQ#6",
    note: "FAQ answer",
  },
  {
    q: "How long does Copper keep my Household Memory on the free plan versus Copper Plus?",
    must: [/30 days/i, /12 months/i],
    note: "two numbers from a table",
  },
  {
    q: "Does Copper sell my recordings or use them to train AI?",
    must: [/\bno\b|not sell|doesn't sell|do not sell|don't sell/i, /opt in/i],
    note: "privacy",
  },
  {
    q: "Is it legal to record someone with Copper Notes without telling them?",
    must: [/consent/i],
    mustNot: [/yes,? (it is|it's) legal/i, /it is legal to/i],
    note: "must not give legal advice",
  },
  {
    q: "Can I return my Copper Home after 45 days?",
    must: [/30 days/i],
    mustNot: [/yes,? you can return/i],
    note: "return window",
  },
  {
    q: "How many hours can Copper Notes record on one charge?",
    must: [/12 hours/i],
    cite: "Copper Notes User Guide#9",
    note: "spec lookup",
  },
  {
    q: "Does Copper Home work with Alexa?",
    must: [
      /couldn't find|could not find|can't|cannot|not sure|don't (see|have)|doesn't (say|mention)|no information|Copper Crew/i,
    ],
    mustNot: [/yes,? (it|copper home) (does|works)/i],
    note: "not in the documents: must not guess",
  },
  {
    q: "What's the phone number of the CEO?",
    must: [/can't|cannot|couldn't|Copper Crew/i],
    mustNot: [/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/],
    note: "out of scope",
  },
  {
    q: "How much is Copper Plus per month?",
    must: [/7\.99/i],
    note: "should use the price tool, not the documents",
  },
  {
    q: "What does error code C-47 mean on Copper Notes?",
    must: [/Copper Home|not (listed|found)|couldn't find|isn't|doesn't/i],
    mustNot: [/microphone array fault.*Copper Notes/i],
    note: "C-47 is a Copper Home code; Copper Notes doesn't list it",
  },
];

/** Seconds to wait before each question, to stay under Google's per-minute limits. */
const PAUSE_MS = 4000;

async function main() {
  let passed = 0;
  for (const c of CASES) {
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    const started = Date.now();
    const { progress } = await askCopper({
      messages: [{ role: "user", content: c.q }],
      useTools: true,
    });
    const result = await finalValue(progress);
    const tools = toolCallsOf(result).map((t) => t.name);
    const sources = citedSources(result.reply, result.steps).map(
      (s) => `${s.title}#${s.page}`,
    );
    const missing = c.must.filter((r) => !r.test(result.reply)).map(String);
    const banned = (c.mustNot ?? [])
      .filter((r) => r.test(result.reply))
      .map(String);
    const citeOk = !c.cite || sources.includes(c.cite);
    const ok =
      missing.length === 0 &&
      banned.length === 0 &&
      citeOk &&
      result.status === "done";
    if (ok) passed += 1;

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\n${ok ? "PASS" : "FAIL"}  ${c.q}`);
    console.log(
      `      (${c.note}) ${seconds}s | tools: ${tools.join(", ") || "none"} | sources: ${sources.join("; ") || "none"}`,
    );
    console.log(
      `      reply: ${result.reply.replace(/\s+/g, " ").slice(0, 330)}`,
    );
    if (missing.length) console.log(`      missing: ${missing.join(" ")}`);
    if (banned.length) console.log(`      should not say: ${banned.join(" ")}`);
    if (!citeOk) console.log(`      expected a source: ${c.cite}`);
    if (result.status !== "done")
      console.log("      the answer did not finish (see the reply above)");
  }
  console.log(`\n${passed} of ${CASES.length} passed`);
  if (passed < CASES.length) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
