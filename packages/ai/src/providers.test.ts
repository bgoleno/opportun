import { describe, expect, it } from 'vitest';
import { estimateCost, estimateCostUsd, FALLBACK_PRICE, PRICING } from './pricing';
import { assertSafeBaseUrl, createLanguageModel, isSafeBaseUrl } from './providers';

const ALLOW_LOOPBACK = { allowLoopbackHttp: true };
const DENY_LOOPBACK = { allowLoopbackHttp: false };
const STUB_FETCH = (() => Promise.reject(new Error('unused in this test'))) as typeof fetch;

describe('openai_compatible baseUrl validation', () => {
  it('accepts https and loopback http when the operator allows it', () => {
    expect(assertSafeBaseUrl('https://llm.example.com/v1/', DENY_LOOPBACK)).toBe(
      'https://llm.example.com/v1',
    );
    expect(isSafeBaseUrl('http://localhost:11434/v1', ALLOW_LOOPBACK)).toBe(true);
    expect(isSafeBaseUrl('http://127.0.0.1:1234/v1', ALLOW_LOOPBACK)).toBe(true);
  });

  it('rejects loopback http when the operator has not allowed it (issue #334)', () => {
    expect(isSafeBaseUrl('http://localhost:11434/v1', DENY_LOOPBACK)).toBe(false);
    expect(isSafeBaseUrl('http://127.0.0.1:1234/v1', DENY_LOOPBACK)).toBe(false);
    // https is unaffected by the flag either way.
    expect(isSafeBaseUrl('https://llm.example.com/v1', DENY_LOOPBACK)).toBe(true);
  });

  it('rejects plain http off loopback, other schemes, credentials and garbage', () => {
    for (const bad of [
      undefined,
      '',
      'http://llm.example.com/v1',
      'http://localhost.evil.com/v1',
      'ftp://example.com',
      'javascript:alert(1)',
      'https://user:pass@example.com/v1',
      'not a url',
    ]) {
      expect(isSafeBaseUrl(bad, ALLOW_LOOPBACK), String(bad)).toBe(false);
    }
  });

  it('refuses to build a model for an unsafe baseUrl', () => {
    expect(() =>
      createLanguageModel(
        {
          provider: 'openai_compatible',
          model: 'm',
          maxOutputTokens: 10,
          baseUrl: 'http://10.0.0.5',
        },
        'k',
        { fetch: STUB_FETCH, allowLoopbackHttp: true },
      ),
    ).toThrow(/https/);
  });
});

describe('cost estimate', () => {
  it('prices listed models per million tokens, OpenAI included', () => {
    expect(estimateCostUsd('anthropic', 'claude-opus-5-5', 1_000_000, 1_000_000)).toBeCloseTo(24);
    expect(estimateCostUsd('anthropic', 'claude-haiku-5-5', 2_000_000, 0)).toBeCloseTo(0.2);
    expect(estimateCost('openai', 'gpt-5.4-mini', 1_000_000, 1_000_000)).toEqual({
      usd: 5.25,
      fallback: false,
    });
  });

  it('charges unlisted models the highest listed prices and flags them', () => {
    const all = Object.values(PRICING).flatMap((m) => Object.values(m));
    expect(FALLBACK_PRICE.inputPerMTok).toBe(Math.max(...all.map((p) => p.inputPerMTok)));
    expect(FALLBACK_PRICE.outputPerMTok).toBe(Math.max(...all.map((p) => p.outputPerMTok)));
    for (const [provider, model] of [
      ['openai_compatible', 'llama'],
      ['anthropic', 'claude-unlisted'],
      ['anthropic', '__proto__'],
    ] as const) {
      const est = estimateCost(provider, model, 1_000_000, 1_000_000);
      expect(est.fallback).toBe(true);
      expect(est.usd).toBeCloseTo(FALLBACK_PRICE.inputPerMTok + FALLBACK_PRICE.outputPerMTok);
    }
  });

  it('policy price overrides beat the table and the fallback', () => {
    const both = { inputUsdPerMTok: 1, outputUsdPerMTok: 3 };
    expect(estimateCost('anthropic', 'claude-opus-5-5', 1_000_000, 1_000_000, both)).toEqual({
      usd: 4,
      fallback: false,
    });
    expect(estimateCost('openai_compatible', 'llama', 1_000_000, 1_000_000, both)).toEqual({
      usd: 4,
      fallback: false,
    });
    // Zero is a real price (a free local model), not "unset".
    expect(
      estimateCost('openai_compatible', 'llama', 1_000_000, 1_000_000, {
        inputUsdPerMTok: 0,
        outputUsdPerMTok: 0,
      }),
    ).toEqual({ usd: 0, fallback: false });
  });

  it('a single override field fills only its side; the other comes from the table or fallback', () => {
    expect(
      estimateCost('anthropic', 'claude-opus-5-5', 1_000_000, 1_000_000, { inputUsdPerMTok: 1 }),
    ).toEqual({ usd: 21, fallback: false });
    const partial = estimateCost('openai_compatible', 'llama', 1_000_000, 1_000_000, {
      outputUsdPerMTok: 2,
    });
    expect(partial.fallback).toBe(true);
    expect(partial.usd).toBeCloseTo(FALLBACK_PRICE.inputPerMTok + 2);
  });
});
