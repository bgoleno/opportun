// Static $/MTok cost table used to estimate task_runs.est_cost (FR-A5). This is config data:
// estimates only, never billing. A model missing from the table is charged at FALLBACK_PRICE
// (the highest listed input and output prices) so it still counts against the daily budget,
// and its run is marked as fallback-priced. A policy can set its own prices
// (inputUsdPerMTok / outputUsdPerMTok), which take precedence over the table.
import type { ModelPolicy, ProviderId } from './types';

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

// ---------------------------------------------------------------------------
// UPDATE AS PRICES CHANGE.
// First-party standard-tier list prices in USD per million tokens, keyed by provider then
// model id. Last reviewed: 2026-10-15. Add new models here; nothing else needs to change.
// OpenAI models with separate long-context rates are listed at their short-context rate.
// openai_compatible endpoints (local runtimes, gateways) have no list price: add entries
// under that provider if your gateway charges per token, otherwise their runs are charged
// at the fallback price below.
export const PRICING: Record<ProviderId, Record<string, ModelPrice>> = {
  anthropic: {
    'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
    'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
    'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
    'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
    'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  },
  openai: {
    'gpt-6-astra': { inputPerMTok: 10, outputPerMTok: 50 },
    'gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10 },
    'gpt-6-sol': { inputPerMTok: 2, outputPerMTok: 10 },
    'gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    'gpt-5.6-sol': { inputPerMTok: 4, outputPerMTok: 20 },
    'gpt-5.6-terra': { inputPerMTok: 2, outputPerMTok: 12 },
    'gpt-5.6-luna': { inputPerMTok: 0.2, outputPerMTok: 1.2 },
    'gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30 },
    'gpt-5.5-pro': { inputPerMTok: 30, outputPerMTok: 180 },
    'gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15 },
    'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5 },
    'gpt-5.4-nano': { inputPerMTok: 0.2, outputPerMTok: 1.25 },
    'gpt-5.4-pro': { inputPerMTok: 30, outputPerMTok: 180 },
    'gpt-5.2': { inputPerMTok: 1.75, outputPerMTok: 14 },
    'gpt-5.1': { inputPerMTok: 1.25, outputPerMTok: 10 },
    'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10 },
    'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2 },
    'gpt-5-nano': { inputPerMTok: 0.05, outputPerMTok: 0.4 },
    'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
    'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6 },
    'gpt-4.1-nano': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
    'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
    'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
    o3: { inputPerMTok: 2, outputPerMTok: 8 },
    'o4-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  },
  openai_compatible: {},
};
// END OF PRICE TABLE
// ---------------------------------------------------------------------------

const ALL_PRICES = Object.values(PRICING).flatMap((models) => Object.values(models));

/** Conservative price for unlisted models: the highest input and output prices in the table. */
export const FALLBACK_PRICE: ModelPrice = {
  inputPerMTok: Math.max(...ALL_PRICES.map((p) => p.inputPerMTok)),
  outputPerMTok: Math.max(...ALL_PRICES.map((p) => p.outputPerMTok)),
};

// Lookups go through a Map so provider and model strings from storage never index objects.
const PRICE_INDEX = new Map<string, ModelPrice>(
  Object.entries(PRICING).flatMap(([provider, models]) =>
    Object.entries(models).map(([model, price]) => [`${provider}/${model}`, price] as const),
  ),
);

export function priceFor(provider: string, model: string): ModelPrice | undefined {
  return PRICE_INDEX.get(`${provider}/${model}`);
}

export interface CostEstimate {
  /** Estimated USD cost; always finite and >= 0. */
  usd: number;
  /** True when any side (input or output) was charged at FALLBACK_PRICE. */
  fallback: boolean;
}

/** A policy's own prices; each side set here beats the table for that side. */
export type PriceOverride = Pick<ModelPolicy, 'inputUsdPerMTok' | 'outputUsdPerMTok'>;

/** A usable override value: finite and >= 0 (0 is a real price, e.g. a free local model). */
function overridePrice(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Precedence per side: policy override, then the price table, then FALLBACK_PRICE. */
export function estimateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  override?: PriceOverride,
): CostEstimate {
  const listed = priceFor(provider, model);
  const inputOverride = overridePrice(override?.inputUsdPerMTok);
  const outputOverride = overridePrice(override?.outputUsdPerMTok);
  const inputPrice = inputOverride ?? listed?.inputPerMTok ?? FALLBACK_PRICE.inputPerMTok;
  const outputPrice = outputOverride ?? listed?.outputPerMTok ?? FALLBACK_PRICE.outputPerMTok;
  const cost =
    (Math.max(0, inputTokens) * inputPrice + Math.max(0, outputTokens) * outputPrice) / 1_000_000;
  const fallback =
    listed === undefined && (inputOverride === undefined || outputOverride === undefined);
  return { usd: Number.isFinite(cost) ? cost : 0, fallback };
}

/** Estimated USD cost of one call (fallback-priced for unlisted models). */
export function estimateCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  return estimateCost(provider, model, inputTokens, outputTokens).usd;
}
