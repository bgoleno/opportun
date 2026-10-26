// Stage 0 (spec D0): what Opportun asks Gmail for at all. Mail excluded here never leaves the
// user's provider, which makes it the strongest control in the system.
import { describe, expect, it } from 'vitest';
import {
  buildGmailQuery,
  DEFAULT_GMAIL_QUERY,
  effectiveGmailQuery,
  GMAIL_QUERY_MAX_CHARS,
  MAIL_LABEL_SETTING,
  writeGmailQuery,
} from '../src/adapters/gmail';
import { createRule } from '../src/repos/mailFilters';
import { writeUserSetting } from '../src/repos/userSettings';
import { useApi } from './api';

const boot = useApi();
const ctxOf = (userId: string) => ({ userId, isAdmin: false });

describe('buildGmailQuery', () => {
  it('matches the existing default when nothing is configured', () => {
    expect(buildGmailQuery({ days: 180, label: null, denyDomains: [] })).toBe(DEFAULT_GMAIL_QUERY);
  });

  it('scopes to a label when one is set', () => {
    expect(buildGmailQuery({ days: 180, label: 'JobSearch', denyDomains: [] })).toBe(
      'label:JobSearch newer_than:180d -in:spam -in:trash',
    );
  });

  it('quotes a label containing a space', () => {
    expect(buildGmailQuery({ days: 180, label: 'Job Search', denyDomains: [] })).toContain(
      'label:"Job Search"',
    );
  });

  it('excludes denied senders so their mail is never fetched', () => {
    expect(buildGmailQuery({ days: 180, label: null, denyDomains: ['clinic-a.example'] })).toBe(
      'newer_than:180d -in:spam -in:trash -from:clinic-a.example',
    );
  });

  it('caps exclusions so the query cannot wedge the sync', () => {
    // Review Focus 3: an over-long query is rejected by Gmail, which would stop sync entirely.
    // Stage 1 still enforces whatever is dropped here, so truncating is safe.
    const many = Array.from({ length: 400 }, (_, i) => `domain-number-${i}.example`);
    const q = buildGmailQuery({ days: 180, label: null, denyDomains: many });
    expect(q.length).toBeLessThanOrEqual(GMAIL_QUERY_MAX_CHARS);
    expect(q).toContain('-from:domain-number-0.example');
    expect(q).toContain('newer_than:180d');
  });

  it('keeps the lookback window when a label is also set', () => {
    const q = buildGmailQuery({ days: 30, label: 'JobSearch', denyDomains: ['gmail.com'] });
    expect(q).toContain('label:JobSearch');
    expect(q).toContain('newer_than:30d');
    expect(q).toContain('-from:gmail.com');
  });

  it('drops a label that would need escaping rather than building a broken query', () => {
    expect(buildGmailQuery({ days: 180, label: 'bad"label', denyDomains: [] })).toBe(
      DEFAULT_GMAIL_QUERY,
    );
  });
});

describe('effectiveGmailQuery', () => {
  it('is the default for a user who has configured nothing', async () => {
    const { app, a } = await boot();
    expect(await effectiveGmailQuery(app.db, ctxOf(a.userId))).toBe(DEFAULT_GMAIL_QUERY);
  });

  it('adds the chosen label', async () => {
    const { app, a } = await boot();
    await writeUserSetting(app.db, ctxOf(a.userId), MAIL_LABEL_SETTING, 'JobSearch');
    expect(await effectiveGmailQuery(app.db, ctxOf(a.userId))).toContain('label:JobSearch');
  });

  it('excludes a denied whole domain so its mail is never fetched', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@clinic-a.example',
      effect: 'deny',
    });
    expect(await effectiveGmailQuery(app.db, ctxOf(a.userId))).toContain('-from:clinic-a.example');
  });

  it('leaves a single denied address to Stage 1 rather than guessing a domain exclusion', async () => {
    const { app, a } = await boot();
    await createRule(app.db, ctxOf(a.userId), {
      pattern: 'recruiter@agency-c.example',
      effect: 'deny',
    });
    expect(await effectiveGmailQuery(app.db, ctxOf(a.userId))).not.toContain('-from:');
  });

  it('never rewrites a query the user hand-edited', async () => {
    const { app, a } = await boot();
    await writeGmailQuery(app.db, ctxOf(a.userId), 'from:me label:odd');
    await writeUserSetting(app.db, ctxOf(a.userId), MAIL_LABEL_SETTING, 'JobSearch');
    expect(await effectiveGmailQuery(app.db, ctxOf(a.userId))).toBe('from:me label:odd');
  });

  it('ignores a disabled deny rule', async () => {
    const { app, a } = await boot();
    const rule = await createRule(app.db, ctxOf(a.userId), {
      pattern: '*@clinic-a.example',
      effect: 'deny',
    });
    const { updateRule } = await import('../src/repos/mailFilters');
    await updateRule(app.db, ctxOf(a.userId), rule.id, { enabled: false });
    expect(await effectiveGmailQuery(app.db, ctxOf(a.userId))).not.toContain('-from:');
  });
});
