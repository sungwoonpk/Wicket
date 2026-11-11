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
