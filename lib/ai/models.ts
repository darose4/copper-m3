// The course's approved models. Calls go straight to Google with a Google AI
// Studio key, which is free and needs no credit card.
export const MODELS = [
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash (fast, shows its thinking)",
    // Google's own name for it, used when calling Google.
    googleId: "gemini-2.5-flash",
  },
  {
    id: "google/gemini-3-flash",
    label: "Gemini 3 Flash (newer, thinks out loud less often)",
    googleId: "gemini-3-flash-preview",
  },
  {
    // Gemini 3 Flash's free tier allows only 20 requests a day per project, which
    // a class can use up in minutes. Flash-Lite has its own, larger allowance.
    id: "google/gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite (fast, much higher free limits)",
    googleId: "gemini-3.1-flash-lite",
  },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

/**
 * The model used when a call doesn't name one. 2.5 Flash writes a summary of
 * its thinking for every question, which Ask Copper shows students.
 */
export const DEFAULT_MODEL: ModelId = "google/gemini-2.5-flash";

/**
 * The model that turns text into an embedding: a list of numbers that captures
 * what the text means, so passages about the same thing end up close together.
 */
export const EMBEDDING_MODEL = {
  id: "google/gemini-embedding-001",
  // Google's own name for it, used when calling Google.
  googleId: "gemini-embedding-001",
  // How many numbers each embedding has. 768 keeps the saved file small and
  // the search fast, and is plenty for a few hundred passages.
  dimensions: 768,
} as const;

/** AI_MODEL if it names an approved model, otherwise the default. */
export function defaultModel(): ModelId {
  const id = process.env.AI_MODEL;
  return MODELS.find((m) => m.id === id)?.id ?? DEFAULT_MODEL;
}
