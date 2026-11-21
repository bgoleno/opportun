// The referral candidate pre-filter (https://github.com/bgoleno/opportun/issues/590 criterion 3, tl's
// condition): the SQL reads only contacts that can match the opportunity's company, and never leaves
// out one the JS matcher (scoreContact) accepts. The matcher's own cases (classify.test.ts's
// sameCompany pairs) and accents, case, punctuation and multi-word names go through both, on the
// dialect the run uses. All names are made up.
import { newId } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { companies, networkContacts } from '../src/db/schema';
import type { OpportunityView } from '../src/repos/opportunities';
import { candidateContacts, scoreContact } from '../src/routes/referrals';
import { useApi } from './api';

const boot = useApi();

/** History company names, each on its own contact with no current company. */
const HISTORY = [
  'Acme Inc',
  'ACME',
  'Acme Robotics',
  'acme robotics, inc.',
  'Acme-Robotics GmbH',
  'Box',
  'Boxed Water',
  'Initech',
  'Initrode',
  'Société Générale',
  'Societe Generale',
  'SOCIÉTÉ GÉNÉRALE SA',
  'Ünited Widgets',
  'United Widgets',
  'Müller & Söhne',
  'Mueller und Soehne',
  'O’Brien Partners',
  "O'Brien Partners",
  '100% Juice Co',
  'Under_Score Labs',
  'Inc',
  'Hooli',
  'Globex',
];

/** Opportunity company names the history above is matched against. */
const OPPORTUNITIES = [
  'Acme',
  'ACME Inc.',
  'Acme Robotics',
  'Box',
  'Initech',
  'Société Générale',
  'societe generale',
  'United Widgets',
  'Müller & Söhne',
  "O'Brien Partners",
  '100% Juice Co',
  'Under_Score Labs',
  'Inc',
  'Hooli',
  'Nobody Here',
];

describe('#590 criterion 3: the pre-filter keeps every contact the matcher accepts', () => {
  it('for each company name, read rows contain all matches, and an unrelated ASCII contact is left out', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const now = Date.now();
    const rows = HISTORY.map((company, i) => ({
      id: newId(),
      userId: a.userId,
      name: `Sample Person ${i}`,
      history: [{ company, title: 'Engineer', from: null, to: null }],
      createdAt: now,
      updatedAt: now,
    }));
    await app.db.insert(networkContacts).values(rows).run();
    const all = await app.db.select().from(networkContacts).all();

    for (const companyName of OPPORTUNITIES) {
      const companyId = newId();
      await app.db
        .insert(companies)
        .values({
          id: companyId,
          userId: a.userId,
          name: companyName,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const opp = { companyId, companyName } as OpportunityView;
      const names = new Map([[companyId, companyName]]);
      const read = new Set((await candidateContacts(app.db, ctx, opp, names)).map((r) => r.id));
      const accepted = all.filter((r) => scoreContact(r, names, opp) !== null).map((r) => r.id);
      for (const id of accepted) {
        const company = HISTORY[rows.findIndex((r) => r.id === id)];
        expect(read.has(id), `${companyName}: kept ${company}`).toBe(true);
      }
      if (companyName === 'Hooli') {
        // Not every contact: Globex and the others are not read for Hooli.
        expect(read.size).toBeLessThan(all.length);
        const globex = rows[HISTORY.indexOf('Globex')]!.id;
        expect(read.has(globex)).toBe(false);
      }
    }
  });

  it("a contact at the opportunity's company by its current company id is read, whatever its history", async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const now = Date.now();
    const companyId = newId();
    await app.db
      .insert(companies)
      .values({ id: companyId, userId: a.userId, name: 'Initech', createdAt: now, updatedAt: now })
      .run();
    const id = newId();
    await app.db
      .insert(networkContacts)
      .values({
        id,
        userId: a.userId,
        name: 'Jane Doe',
        currentCompanyId: companyId,
        history: [],
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const opp = { companyId, companyName: 'Initech' } as OpportunityView;
    const read = await candidateContacts(app.db, ctx, opp, new Map([[companyId, 'Initech']]));
    expect(read.map((r) => r.id)).toEqual([id]);
  });
});
