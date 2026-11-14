// A parked company's wait across a daylight-saving change (https://github.com/bgoleno/opportun/issues/535,
// tl's optional point on #533). The nightly sweep runs at 05:15 in the server's own time, and a
// company whose own request stopped a vendor is parked for 2^(stops-1) nights (#518): across a
// 23- or 25-hour day the park must still last exactly that many nights, neither one short nor
// one long.
//
// CI runs in UTC, which has no such change, and a test may not set process.env.TZ (it leaks to
// every file in the worker, #292), so the zone is passed to the night functions as the parameter
// they take for this, and every time here is computed in that zone with Intl.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { companies } from '../src/db/schema';
import { nightStart, parkedUntil, pickNetworkCompanies } from '../src/jobs/networkBoardProbe';
import { useApi } from './api';
import type { TestClient } from './isolation';

const TZ = 'America/New_York';
const boot = useApi();
const HOUR = 60 * 60_000;

/** The wall-clock parts of `t` in TZ. */
function local(t: number): { day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** 05:20 in TZ on a day of 2026 (month 0-based), just after that night's sweep. */
function at0520(month: number, day: number): number {
  // New York is UTC-5 in winter and UTC-4 in summer: take whichever reads 05:20 there.
  for (const offset of [4, 5]) {
    const t = Date.UTC(2026, month, day, 5 + offset, 20);
    const l = local(t);
    if (l.day === new Date(Date.UTC(2026, month, day)).getUTCDate() && l.hour === 5) return t;
  }
  throw new Error(`no 05:20 on 2026-${month + 1}-${day} in ${TZ}`);
}

/** A company the user knows someone at, through the route a contact is added by. */
async function inNetwork(c: TestClient, company: string): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/network',
    payload: { name: `Contact at ${company}`, company },
  });
  expect(res.statusCode, res.body).toBe(201);
  const list = await c.request({ method: 'GET', url: '/api/v1/companies?limit=200' });
  return list
    .json<{ items: { id: string; name: string }[] }>()
    .items.find((x) => x.name === company)!.id;
}

/** The days, from `first` on, on whose night the pick includes the company, for `nights` nights. */
async function pickedNights(
  app: FastifyInstance,
  c: TestClient,
  id: string,
  month: number,
  first: number,
  nights: number,
): Promise<number[]> {
  const picked: number[] = [];
  const ctx = { userId: c.userId, isAdmin: false };
  for (let d = first; d < first + nights; d++) {
    const picks = await pickNetworkCompanies(app.db, ctx, 20, nightStart(at0520(month, d), TZ));
    if (picks.includes(id)) picked.push(d);
  }
  return picked;
}

// America/New_York in 2026: clocks go forward on Sunday 8 March (a 23-hour day) and back on
// Sunday 1 November (a 25-hour day), both at 02:00, before the 05:15 sweep.
const CHANGES = [
  { name: 'spring (a 23-hour day)', month: 2, day: 8 },
  { name: 'autumn (a 25-hour day)', month: 10, day: 1 },
] as const;

describe('a park across a daylight-saving change lasts exactly its nights (#535)', () => {
  it('the night across each change is 23 or 25 hours, so the cases below are not vacuous', () => {
    for (const c of CHANGES) {
      const span =
        nightStart(at0520(c.month, c.day), TZ) - nightStart(at0520(c.month, c.day - 1), TZ);
      expect(Math.abs(span - 24 * HOUR), c.name).toBe(HOUR);
      // Each night still starts at 05:15 there.
      expect(local(nightStart(at0520(c.month, c.day), TZ)), c.name).toMatchObject({
        hour: 5,
        minute: 15,
      });
    }
  });

  for (const c of CHANGES) {
    for (const [stops, nights] of [
      [1, 1],
      [2, 2],
      [3, 4],
      [4, 8],
    ] as const) {
      it(`${c.name}: parked the night before for ${nights} night(s) (stop ${stops}), it is picked again on night ${nights + 1}`, async () => {
        const { app, a } = await boot();
        const id = await inNetwork(a, 'Initech');
        // Stopped on the night before the change.
        const stopNight = c.day - 1;
        const until = parkedUntil(at0520(c.month, stopNight), stops, TZ);
        await app.db
          .update(companies)
          .set({ boardProbeStops: stops, boardProbeParkedUntil: until })
          .where(eq(companies.id, id))
          .run();
        // The park ends at the start of a night, 05:15 there, on the right day.
        expect(until).toBe(nightStart(at0520(c.month, stopNight + nights + 1), TZ));
        expect(local(until)).toMatchObject({ hour: 5, minute: 15 });
        // Not picked on the parked nights, picked again on the next one, and the night after.
        const picked = await pickedNights(app, a, id, c.month, stopNight + 1, nights + 2);
        expect(picked).toEqual([stopNight + nights + 1, stopNight + nights + 2]);
      });
    }
  }
});
