// Mail filter rules (spec D1 rules 0-2, D7). The table holds the user's OWN rules; the
// consumer-domain veto of rule 2 is a built-in list behind one per-user toggle, not sixty
// seeded rows, because the spec models it as a rule in its own right rather than as deny-list
// entries, and D7 asks for it to read as a single toggleable item.
import { CONSUMER_EMAIL_DOMAINS } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/errors';
import {
  createRule,
  deleteRule,
  listRules,
  readConsumerVeto,
  updateRule,
  writeConsumerVeto,
} from '../src/repos/mailFilters';
import { useApi } from './api';

const boot = useApi();
const ctxOf = (userId: string) => ({ userId, isAdmin: false });

describe('mail filter rules', () => {
  it("stores a created rule as the user's own", async () => {
    const { app, a } = await boot();
    const rule = await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@gmail.com',
      effect: 'deny',
    });
    expect(rule).toMatchObject({ pattern: '*@gmail.com', effect: 'deny', source: 'user' });
    expect(rule.enabled).toBe(true);
  });

  it('rejects a pattern the matcher cannot parse', async () => {
    const { app, a } = await boot();
    await expect(
      createRule(app.db, ctxOf(a.userId), { pattern: 'nodot', effect: 'deny' }),
    ).rejects.toMatchObject({ code: 'invalid_pattern' });
  });

  it('rejects a duplicate pattern for the same effect', async () => {
    const { app, a } = await boot();
    const input = { pattern: '*@gmail.com', effect: 'deny' } as const;
    await createRule(app.db, ctxOf(a.userId), input);
    await expect(createRule(app.db, ctxOf(a.userId), input)).rejects.toBeInstanceOf(HttpError);
  });

  it('allows the same pattern under a different effect', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), { pattern: '*@gmail.com', effect: 'deny' });
    const allow = await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@gmail.com',
      effect: 'allow',
    });
    expect(allow.effect).toBe('allow');
  });

  it("never returns another user's rules", async () => {
    const { app, a, b } = await boot();
    await createRule(app.db, ctxOf(a.userId), { pattern: '*@acme.test', effect: 'deny' });
    const theirs = await listRules(app.db, ctxOf(b.userId));
    expect(theirs.map((r) => r.pattern)).not.toContain('*@acme.test');
  });

  it('updates and deletes a rule', async () => {
    const { app, a } = await boot();
    const rule = await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@acme.test',
      effect: 'deny',
    });

    const off = await updateRule(app.db, ctxOf(a.userId), rule.id, { enabled: false });
    expect(off.enabled).toBe(false);

    await deleteRule(app.db, ctxOf(a.userId), rule.id);
    expect((await listRules(app.db, ctxOf(a.userId))).map((r) => r.id)).not.toContain(rule.id);
  });

  it("refuses to touch another user's rule", async () => {
    const { app, a, b } = await boot();
    const rule = await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@acme.test',
      effect: 'deny',
    });
    await expect(
      updateRule(app.db, ctxOf(b.userId), rule.id, { enabled: false }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe('the consumer-domain veto (rule 2)', () => {
  it('is on by default and carries the well-known providers', async () => {
    const { app, a } = await boot();
    expect(await readConsumerVeto(app.db, ctxOf(a.userId))).toBe(true);
    expect(CONSUMER_EMAIL_DOMAINS).toContain('gmail.com');
    expect(CONSUMER_EMAIL_DOMAINS).toContain('icloud.com');
    expect(CONSUMER_EMAIL_DOMAINS).toContain('comcast.net');
  });

  it('is a single toggle rather than one rule per domain', async () => {
    const { app, a } = await boot();
    await writeConsumerVeto(app.db, ctxOf(a.userId), false);
    expect(await readConsumerVeto(app.db, ctxOf(a.userId))).toBe(false);
    // Turning it off must not have written sixty rows into the user's own list.
    expect(await listRules(app.db, ctxOf(a.userId))).toHaveLength(0);
  });
});
