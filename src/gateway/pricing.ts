export interface Price {
  /** US dollars per one million input tokens. */
  inputPerM: number;
  /** US dollars per one million output tokens. */
  outputPerM: number;
}

export type PriceTable = Record<string, Price>;

/** Prices for the demo models and a fallback. Real deployments supply their own table. */
export const DEFAULT_PRICES: PriceTable = {
  "demo-small": { inputPerM: 0.15, outputPerM: 0.6 },
  "demo-large": { inputPerM: 3, outputPerM: 15 },
  "*": { inputPerM: 1, outputPerM: 3 },
};

export function costUsd(
  table: PriceTable,
  model: string,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
): number {
  const price = table[model] ?? table["*"] ?? { inputPerM: 0, outputPerM: 0 };
  const cost = ((promptTokens ?? 0) * price.inputPerM + (completionTokens ?? 0) * price.outputPerM) / 1_000_000;
  return Math.round(cost * 1e9) / 1e9;
}

/**
 * Reads a price table from a JSON file shaped like `{ "model-name": { "inputPerM": 3, "outputPerM": 15 } }`.
 * Names may use `*` as a fallback entry. Throws a readable error on anything else, so a typo
 * stops the gateway at start-up instead of silently pricing requests at zero.
 */
export function parsePriceTable(input: unknown): PriceTable {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("the price table must be a JSON object");
  const table: PriceTable = {};
  for (const [model, price] of Object.entries(input as Record<string, unknown>)) {
    const p = price as Partial<Price> | null;
    const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
    if (!p || typeof p !== "object" || !ok(p.inputPerM) || !ok(p.outputPerM)) {
      throw new Error(`the price for "${model}" needs non-negative numbers inputPerM and outputPerM`);
    }
    table[model] = { inputPerM: p.inputPerM as number, outputPerM: p.outputPerM as number };
  }
  return table;
}
