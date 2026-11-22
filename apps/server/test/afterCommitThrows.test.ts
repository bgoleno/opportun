// tl on https://github.com/bgoleno/opportun/pull/822 (#807): what afterCommit runs must not hide
// the deliberate test-time throw for a telemetry key the catalog does not list (obs/gate.ts), or
// CI would stop catching a field missing from the catalog. Under the test runner it throws, on
// both paths: at once outside a transaction, and after the commit inside one.
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { afterCommit, withTransaction } from '../src/db/client';
import { obs, setCollecting } from '../src/obs';
import { UnknownTelemetryKeyError } from '../src/obs/gate';
import { testApp } from './helpers';

let app: FastifyInstance;

beforeEach(async () => {
  // The app starts telemetry; with collection off obs.event returns before it reads a key.
  ({ app } = await testApp());
  await setCollecting(true);
});

afterEach(async () => {
  await setCollecting(false);
  await app.close();
});

const unknownKey = () => obs.event('auth.login', { 'opportun.not.a.catalogued.key': 'x' } as never);

describe('afterCommit keeps the unknown-telemetry-key throw under the test runner (#807)', () => {
  it('outside a transaction', () => {
    expect(() => afterCommit(app.db, unknownKey)).toThrow(UnknownTelemetryKeyError);
  });

  it('after the commit of a transaction', async () => {
    await expect(
      withTransaction(app.db, async (tx) => {
        afterCommit(tx, unknownKey);
      }),
    ).rejects.toThrow(UnknownTelemetryKeyError);
  });
});
