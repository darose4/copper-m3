// The tools Ask Copper can use. Products and prices come from
// lib/copper/catalog.ts, stock from lib/copper/inventory.ts, and answers about
// setup, troubleshooting, warranty, privacy and terms from the company's PDFs
// (lib/copper/passages.ts), so the chatbot never has to make them up.
// Each tool returns plain data; the model writes the reply around it.
import { tool } from "ai";
import { z } from "zod";
import {
  getPlans,
  getProducts,
  type Plan,
  type ProductId,
} from "@/lib/copper/catalog";
import { callEmbed } from "@/lib/ai/call";
import { DOCUMENTS } from "@/lib/copper/documents";
import { readInventory } from "@/lib/copper/inventory";
import { normalize } from "@/lib/copper/passage-split";
import { passages } from "@/lib/copper/passages";

export type ProductList = {
  products: {
    id: ProductId;
    name: string;
    type: string;
    priceUsd: number;
    colors: string[];
  }[];
};

export type Prices = {
  products: { id: ProductId; name: string; priceUsd: number }[];
  plans: {
    id: Plan["id"];
    name: string;
    monthlyUsd: number;
    annualUsd: number;
  }[];
};

export type CalculateCostInput = {
  products: ProductId[];
  plan: Plan["id"];
  billing: "monthly" | "annual";
  years: number;
};

export type CostBreakdown = {
  lines: { item: string; usd: number }[];
  totalUsd: number;
};

export type CheckAvailabilityInput = { product: ProductId; color?: string };

export type Stock = "in_stock" | "low_stock" | "backordered";

export type Availability =
  | {
      status: "ok";
      product: string;
      colors: { color: string; stock: Stock; restockDate: string | null }[];
    }
  | { status: "not_a_color"; product: string; color: string; colors: string[] }
  | { status: "unavailable"; message: string };

/** get_products: what Copper sells and which colors each one comes in. */
export function listProducts(): ProductList {
  return {
    products: getProducts().map(({ id, name, type, priceUsd, colors }) => ({
      id,
      name,
      type,
      priceUsd,
      colors,
    })),
  };
}

/** get_prices: every product and plan price, read from the catalog. */
export function getPrices(): Prices {
  return {
    products: getProducts().map(({ id, name, priceUsd }) => ({
      id,
      name,
      priceUsd,
    })),
    plans: getPlans().map(({ id, name, monthlyUsd, annualUsd }) => ({
      id,
      name,
      monthlyUsd,
      annualUsd,
    })),
  };
}

const productId = z.enum(["copper-home", "copper-notes"]);

export const calculateCostInput = z.object({
  products: z.array(productId).max(5),
  plan: z.enum(["free", "copper-plus"]),
  billing: z.enum(["monthly", "annual"]),
  years: z.number().int().min(1).max(5),
}) satisfies z.ZodType<CalculateCostInput>;

const cents = (usd: number) => Math.round(usd * 100) / 100;

/** calculate_cost: the total cost of devices plus a plan over some years. */
export function calculateCost(input: CalculateCostInput): CostBreakdown {
  const products = getProducts();
  const lines = input.products.map((id) => {
    const product = products.find((p) => p.id === id)!;
    return { item: product.name, usd: cents(product.priceUsd) };
  });
  const plan = getPlans().find((p) => p.id === input.plan)!;
  const planUsd =
    input.billing === "monthly"
      ? plan.monthlyUsd * 12 * input.years
      : plan.annualUsd * input.years;
  // The free plan costs nothing, so it adds no line.
  if (planUsd > 0) {
    const years = input.years === 1 ? "1 year" : `${input.years} years`;
    lines.push({
      item: `${plan.name}, ${input.billing}, ${years}`,
      usd: cents(planUsd),
    });
  }
  return { lines, totalUsd: cents(lines.reduce((sum, l) => sum + l.usd, 0)) };
}

export const checkAvailabilityInput = z.object({
  product: productId,
  color: z.string().optional(),
}) satisfies z.ZodType<CheckAvailabilityInput>;

function stockOf(units: number): Stock {
  if (units === 0) return "backordered";
  return units < 10 ? "low_stock" : "in_stock";
}

/** check_availability: stock for one product (or one of its colors), read fresh each time. */
export async function checkAvailability(
  input: CheckAvailabilityInput,
): Promise<Availability> {
  const product = getProducts().find((p) => p.id === input.product)!;
  const wanted = input.color?.trim().toLowerCase();
  const colors = wanted
    ? product.colors.filter((c) => c.toLowerCase() === wanted)
    : product.colors;
  if (input.color && colors.length === 0) {
    return {
      status: "not_a_color",
      product: product.name,
      color: input.color,
      colors: product.colors,
    };
  }
  const rows = await readInventory();
  if (!rows) {
    return {
      status: "unavailable",
      message: "Stock can't be checked right now. Please try again soon.",
    };
  }
  return {
    status: "ok",
    product: product.name,
    colors: colors.flatMap((color) => {
      const row = rows.find(
        (r) =>
          r.product === product.name &&
          r.color.toLowerCase() === color.toLowerCase(),
      );
      if (!row) return [];
      const stock = stockOf(row.units_in_stock);
      return [
        {
          color,
          stock,
          restockDate: stock === "backordered" ? row.next_shipment : null,
        },
      ];
    }),
  };
}

export type DocumentSearchInput = { question: string };

export type DocumentMatch = {
  /** The document it came from, e.g. "Copper Home User Guide". */
  title: string;
  page: number;
  /** The passage itself, without the title it starts with in the saved file. */
  text: string;
  /** Opens the PDF at that page. */
  url: string;
  /** How close the passage is to the question: 1 is identical, near 0 is unrelated. */
  score: number;
};

export type DocumentSearch =
  | { status: "ok"; matches: DocumentMatch[] }
  | { status: "unavailable"; message: string };

/** How many passages a search brings back. */
const MATCHES_PER_SEARCH = 5;

export const searchDocsInput: z.ZodType<DocumentSearchInput> = z.object({
  question: z.string().trim().min(3).max(300),
});

/** Both embeddings have length 1, so this is how alike they are. */
function similarity(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * search_docs: finds the passages in the user guides, the Copper Plus FAQ
 * and the Terms and Conditions that are closest in meaning to the question,
 * and says which document and page each one is on.
 */
export async function searchDocs({
  question,
}: DocumentSearchInput): Promise<DocumentSearch> {
  if (passages.length === 0) {
    return {
      status: "unavailable",
      message:
        "The documents aren't loaded, so they can't be searched right now.",
    };
  }
  try {
    const [embedding] = await callEmbed(
      { module: 3, feature: "search-docs" },
      [question],
      "query",
    );
    const query = normalize(embedding);
    const matches = passages
      .map((passage) => ({
        passage,
        score: similarity(query, passage.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MATCHES_PER_SEARCH)
      .map(({ passage, score }): DocumentMatch => {
        const file = DOCUMENTS.find((d) => d.id === passage.documentId)?.file;
        return {
          title: passage.title,
          page: passage.page,
          text: passage.text.slice(passage.title.length + 2),
          url: file ? `${file}#page=${passage.page}` : "",
          score: Math.round(score * 1000) / 1000,
        };
      });
    return { status: "ok", matches };
  } catch {
    return {
      status: "unavailable",
      message: "The documents can't be searched right now.",
    };
  }
}

export const copperTools = {
  get_products: tool({
    description:
      "Lists every Copper product with its type, price and the colors it comes in.",
    inputSchema: z.object({}),
    execute: async () => listProducts(),
  }),
  get_prices: tool({
    description: "Gets the price of every Copper product and plan.",
    inputSchema: z.object({}),
    execute: async () => getPrices(),
  }),
  calculate_cost: tool({
    description:
      "Works out the total cost of Copper devices plus a plan over 1 to 5 years.",
    inputSchema: calculateCostInput,
    execute: async (input) => calculateCost(input),
  }),
  check_availability: tool({
    description:
      "Checks today's stock for a Copper product, for every color or just one.",
    inputSchema: checkAvailabilityInput,
    execute: async (input) => checkAvailability(input),
  }),
  search_docs: tool({
    description:
      "Searches the Copper user guides, the Copper Plus FAQ and the Terms and Conditions for a question about setup, troubleshooting, warranty or policy. Returns the 5 closest passages, each with its document title, page number and a link that opens the PDF at that page.",
    inputSchema: searchDocsInput,
    execute: async (input) => searchDocs(input),
  }),
};
