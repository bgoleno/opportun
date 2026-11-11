// Cache pricing (https://github.com/bgoleno/opportun/issues/356): cache writes and reads are priced
// at their own rates from the provider-reported usage, so the discovery budget reflects what a
// cached call costs; and the minimum prefix a model caches.
import { describe, expect, it } from 'vitest';
import { cacheMinTokens, estimateCost, PRICING } from './pricing';

const usd = (input: number, read: number, write: number, output: number, p: number[]) =>
  (input * p[0]! + read * p[1]! + write * p[2]! + output * p[3]!) / 1_000_000;

describe('estimateCost with cache tokens', () => {
  it('prices uncached input, cache reads and cache writes each at their own rate', () => {
    // 1,000 input tokens reported, of which 600 were read from the cache and 300 written to it:
    // 100 are uncached. Sonnet 5.5: $2 input, $0.10 read, $2.50 write (5 minutes), $10 output.
    const cost = estimateCost('anthropic', 'claude-sonnet-5-5', 1000, 100, undefined, {
      readTokens: 600,
      writeTokens: 300,
    });
    expect(cost.usd).toBeCloseTo(usd(100, 600, 300, 100, [2, 0.1, 2.5, 10]), 12);
    expect(cost.fallback).toBe(false);
  });

  it('is unchanged when nothing was cached', () => {
    const plain = estimateCost('anthropic', 'claude-sonnet-5-5', 1000, 100);
    const zero = estimateCost('anthropic', 'claude-sonnet-5-5', 1000, 100, undefined, {
      readTokens: 0,
      writeTokens: 0,
    });
    expect(zero.usd).toBe(plain.usd);
    expect(plain.usd).toBeCloseTo(usd(1000, 0, 0, 100, [2, 0, 0, 10]), 12);
  });

  it('prices cache tokens as plain input where the table has no cache rate', () => {
    // OpenAI caches on its own and reports reads; its cached rates are not in the table, so a
    // read costs what input costs: the budget may over-count, never under-count.
    const plain = estimateCost('openai', 'gpt-5', 1000, 100);
    const cached = estimateCost('openai', 'gpt-5', 1000, 100, undefined, {
      readTokens: 800,
      writeTokens: 0,
    });
    expect(cached.usd).toBe(plain.usd);
  });

  it('prices cache tokens at a policy’s own input price when it sets one', () => {
    const cost = estimateCost(
      'anthropic',
      'claude-sonnet-5-5',
      1000,
      0,
      { inputUsdPerMTok: 7, outputUsdPerMTok: 1 },
      { readTokens: 600, writeTokens: 300 },
    );
    expect(cost.usd).toBeCloseTo(usd(1000, 0, 0, 0, [7, 0, 0, 0]), 12);
  });

  it('never prices more cache tokens than the input reported', () => {
    const cost = estimateCost('anthropic', 'claude-sonnet-5-5', 100, 0, undefined, {
      readTokens: 500,
      writeTokens: 500,
    });
    // All 100 counted as reads, none uncached, none written.
    expect(cost.usd).toBeCloseTo(usd(0, 100, 0, 0, [2, 0.1, 2.5, 10]), 12);
  });
});

describe('cacheMinTokens', () => {
  it('gives each Anthropic model the minimum prefix it caches', () => {
    expect(cacheMinTokens('anthropic', 'claude-sonnet-5-5')).toBe(512);
    expect(cacheMinTokens('anthropic', 'claude-haiku-5-5')).toBe(512);
    expect(cacheMinTokens('anthropic', 'claude-opus-4-8')).toBe(1024);
    expect(cacheMinTokens('anthropic', 'claude-haiku-4-5')).toBe(4096);
  });

  it('has none for a model it does not know, or a provider that is not Anthropic', () => {
    expect(cacheMinTokens('anthropic', 'claude-unknown-9')).toBeUndefined();
    expect(cacheMinTokens('openai', 'gpt-5')).toBeUndefined();
    expect(cacheMinTokens('openai_compatible', 'claude-sonnet-5-5')).toBeUndefined();
  });

  it('every Anthropic model in the price table has cache rates and a minimum', () => {
    for (const [model, price] of Object.entries(PRICING.anthropic)) {
      expect(price.cacheReadPerMTok, model).toBeGreaterThan(0);
      expect(price.cacheWritePerMTok, model).toBeGreaterThan(price.inputPerMTok);
      expect(price.cacheReadPerMTok, model).toBeLessThan(price.inputPerMTok);
      expect(cacheMinTokens('anthropic', model), model).toBeGreaterThan(0);
    }
  });
});
