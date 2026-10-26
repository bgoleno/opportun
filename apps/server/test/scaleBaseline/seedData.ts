// Synthetic, realistically-SHAPED data for #186's performance baseline. Generated, never a
// copy of the owner's actual data and never derived from it: every name below is built from
// word lists, not sampled from anything real, and nothing here is ever pointed at his live
// instance.
//
// Shape matters as much as volume. The owner's 272-item discovery queue and 145 opportunities
// are not 272 and 145 unrelated rows: a real job search clusters around a handful of companies
// that are actively hiring (the same recruiter re-posting, a company with several open reqs),
// and titles at one company vary by seniority prefix and suffix far more than they vary by
// role. That clustering is exactly what exercises opportunityDedupe.ts's near-miss heuristic
// (companyMatchKey, then titleOverlap for same-company rows) differently than 272 uniformly
// random rows would: uniform random data would make almost every pair an early companyMatchKey
// miss, understating the real cost of the loop this baseline exists to measure.
import { companyMatchKey, dedupeKey, newId } from '@opportun/core';
import type { OpportunityStage } from '@opportun/core';

/**
 * Deterministic PRNG (mulberry32): the same seed produces the same dataset every run. A
 * baseline taken on a different random dataset each time would make "did bulk make this
 * worse" unanswerable, since a changed number could be the data or the code.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANY_PREFIXES = [
  'Northwind',
  'Cobalt',
  'Summit',
  'Vertex',
  'Lumen',
  'Harbor',
  'Granite',
  'Meridian',
  'Atlas',
  'Cascade',
  'Juniper',
  'Fathom',
  'Beacon',
  'Orbital',
  'Fulcrum',
  'Anchor',
  'Pinnacle',
  'Riverside',
  'Ironwood',
  'Westfield',
  'Brightline',
  'Northstar',
  'Cedarbrook',
  'Hollowpoint',
  'Sable',
  'Quarryview',
  'Driftwood',
  'Longmarsh',
  'Copperline',
  'Fernbridge',
] as const;
const COMPANY_SUFFIXES = [
  'Systems',
  'Robotics',
  'Analytics',
  'Labs',
  'Technologies',
  'Health',
  'Dynamics',
  'Networks',
  'Software',
  'Industries',
  'Digital',
  'Platforms',
] as const;

/** Every (prefix, suffix) pair, in a fixed order: index 0 and up are the "hot" companies once
 *  `pickCompanyIndex` below skews toward low indices, the same way a real search ends up with
 *  a handful of companies it keeps hearing from. */
const COMPANY_POOL: string[] = COMPANY_PREFIXES.flatMap((p) =>
  COMPANY_SUFFIXES.map((s) => `${p} ${s}`),
);

const SENIORITY = ['', 'Senior ', 'Staff ', 'Principal ', 'Lead ', 'Junior '] as const;
const ROLES = [
  'Backend Engineer',
  'Frontend Engineer',
  'Platform Engineer',
  'Software Engineer',
  'Product Manager',
  'Engineering Manager',
  'Data Engineer',
  'DevOps Engineer',
  'Site Reliability Engineer',
  'Full Stack Engineer',
  'Mobile Engineer',
  'Security Engineer',
] as const;
const TITLE_SUFFIXES = ['', ' II', ' III', ', Platform', ', Growth', ' (Remote)'] as const;

const LOCATIONS = [
  'Remote',
  'Austin, TX',
  'Seattle, WA',
  'New York, NY',
  'Denver, CO',
  'Chicago, IL',
  null,
] as const;

/** Squaring a uniform [0,1) draw biases it toward 0: a cheap, deterministic stand-in for a
 *  Zipf-like skew, so low pool indices (the "hot" companies) get picked disproportionately
 *  often without a real Zipf implementation this task does not need. */
function pickCompanyIndex(rng: () => number, poolSize: number): number {
  return Math.floor(rng() * rng() * poolSize);
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function title(rng: () => number): string {
  return `${pick(rng, SENIORITY)}${pick(rng, ROLES)}${pick(rng, TITLE_SUFFIXES)}`;
}

export interface SeedCompanyRow {
  id: string;
  userId: string;
  name: string;
  companyMatchKey: string;
  status: 'none';
  createdAt: number;
  updatedAt: number;
}

export interface SeedOpportunityRow {
  id: string;
  userId: string;
  companyId: string;
  title: string;
  sourceKind: 'manual';
  stage: OpportunityStage;
  priority: number;
  dedupeKey: string;
  location: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SeedPosting {
  company: string;
  title: string;
  location: string | null;
  remote: boolean | null;
  compNote: string | null;
  descriptionMd: string | null;
  postingUrl: string;
}

export interface SeedDiscoveryResultRow {
  id: string;
  userId: string;
  runId: string;
  posting: SeedPosting;
  dedupeKey: string;
  aiScore: number;
  resolution: 'full';
  disposition: 'pending';
  createdAt: number;
  updatedAt: number;
}

export interface SeedCommunicationRow {
  id: string;
  userId: string;
  channel: 'gmail';
  externalId: string;
  threadKey: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  sentAt: number;
  classification: 'solicitation' | 'other' | null;
  outreachKind: 'targeted' | 'broadcast_spam' | null;
  needsReview: boolean;
  triageDecision: 'passed';
  createdAt: number;
  updatedAt: number;
}

export interface ScaleDataset {
  companies: SeedCompanyRow[];
  opportunities: SeedOpportunityRow[];
  discoveryResults: SeedDiscoveryResultRow[];
  communications: SeedCommunicationRow[];
}

/** The owner's instance tonight (#186): 4,504 communications, 145 opportunities, 272 pending
 *  discovery results, on Postgres. `scale` multiplies all three together, so a ratio taken
 *  between two scales compares datasets of the same shape, just different size. */
const REAL_SCALE = { communications: 4504, opportunities: 145, discoveryResults: 272 };

const STAGE_WEIGHTS: readonly [OpportunityStage, number][] = [
  ['discovered', 30],
  ['interested', 20],
  ['preparing', 15],
  ['applied', 15],
  ['in_process', 10],
  ['offer', 3],
  ['dismissed', 5],
  ['closed', 2],
];
const STAGE_TOTAL = STAGE_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

/** A realistic funnel shape (most opportunities early, few surviving to offer/closed), not a
 *  uniform pick across the eight stages. */
function pickStage(rng: () => number): OpportunityStage {
  let r = rng() * STAGE_TOTAL;
  for (const [stage, weight] of STAGE_WEIGHTS) {
    if (r < weight) return stage;
    r -= weight;
  }
  return 'discovered';
}

export function buildScaleDataset(userId: string, scale: number, seed = 1): ScaleDataset {
  const rng = mulberry32(seed);
  const now = Date.now();
  const nOpportunities = Math.max(1, Math.round(REAL_SCALE.opportunities * scale));
  const nResults = Math.max(1, Math.round(REAL_SCALE.discoveryResults * scale));
  const nComms = Math.max(1, Math.round(REAL_SCALE.communications * scale));

  // One company row per distinct name actually used, created on first use so the table never
  // holds names nothing references. company_match_key is set here the same way a migrated,
  // repaired production row would be (issue #193): leaving it null would make findMatches'
  // own SQL filter miss every seeded row, understating exactly the cost this file measures.
  const companyIdByName = new Map<string, string>();
  const companies: SeedCompanyRow[] = [];
  function companyIdFor(name: string): string {
    const existing = companyIdByName.get(name);
    if (existing !== undefined) return existing;
    const id = newId();
    companyIdByName.set(name, id);
    companies.push({
      id,
      userId,
      name,
      companyMatchKey: companyMatchKey(name),
      status: 'none',
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  // The real opportunities_user_dedupe_uq index refuses two live opportunities sharing one
  // dedupeKey; the seeded data has to honor that too, or a bulk insert fails on exactly the
  // collisions this clustered, limited-pool-of-companies-and-titles shape makes likely by
  // design. Retried with fresh draws rather than skipped, so every requested row still exists.
  const usedKeys = new Set<string>();
  const opportunities: SeedOpportunityRow[] = [];
  for (let i = 0; i < nOpportunities; i += 1) {
    let company: string;
    let t: string;
    let location: (typeof LOCATIONS)[number];
    let key: string;
    do {
      company = COMPANY_POOL[pickCompanyIndex(rng, COMPANY_POOL.length)] as string;
      t = title(rng);
      location = pick(rng, LOCATIONS);
      key = dedupeKey(company, t, location);
    } while (usedKeys.has(key));
    usedKeys.add(key);
    opportunities.push({
      id: newId(),
      userId,
      companyId: companyIdFor(company),
      title: t,
      sourceKind: 'manual',
      stage: pickStage(rng),
      priority: 1 + Math.floor(rng() * 3),
      dedupeKey: key,
      location,
      createdAt: now - Math.floor(rng() * 90 * 86_400_000),
      updatedAt: now,
    });
  }

  // One source + one run to hang every seeded discovery result off, matching the FK chain
  // (discovery_results.run_id -> discovery_runs.id -> discovery_sources.id) without needing a
  // distinct run per result: the baseline measures the queue, not the run history.
  const runId = newId();

  const discoveryResults: SeedDiscoveryResultRow[] = [];
  for (let i = 0; i < nResults; i += 1) {
    const company = COMPANY_POOL[pickCompanyIndex(rng, COMPANY_POOL.length)] as string;
    const t = title(rng);
    const location = pick(rng, LOCATIONS);
    discoveryResults.push({
      id: newId(),
      userId,
      runId,
      posting: {
        company,
        title: t,
        location,
        remote: location === 'Remote',
        compNote:
          rng() < 0.5
            ? null
            : `$${120 + Math.floor(rng() * 120)}k - $${180 + Math.floor(rng() * 120)}k`,
        descriptionMd: `Role at ${company}. ${t}. Generated for #186, not a real posting.`,
        postingUrl: `https://example.invalid/jobs/${newId()}`,
      },
      dedupeKey: dedupeKey(company, t, location),
      aiScore: Math.round(rng() * 100),
      resolution: 'full',
      disposition: 'pending',
      createdAt: now - Math.floor(rng() * 14 * 86_400_000),
      updatedAt: now,
    });
  }

  // A smaller pool of senders than messages, so most senders appear many times: a real inbox
  // is dominated by a handful of recruiters and ATS systems, not one message per sender.
  const SENDER_COUNT = Math.max(8, Math.round(nComms / 20));
  const senders = Array.from({ length: SENDER_COUNT }, (_, i) => {
    const company = COMPANY_POOL[i % COMPANY_POOL.length];
    return `Recruiter ${i} <recruiter${i}@${company?.toLowerCase().replace(/\s+/g, '')}.example>`;
  });

  const communications: SeedCommunicationRow[] = [];
  for (let i = 0; i < nComms; i += 1) {
    const from = pick(rng, senders);
    const threadSeed = Math.floor(rng() * nComms * 0.6); // several messages share a thread
    const classified = rng() < 0.85;
    communications.push({
      id: newId(),
      userId,
      channel: 'gmail',
      externalId: `seed-${seed}-${i}`,
      threadKey: `thread-${threadSeed}`,
      from,
      to: ['me@example.invalid'],
      subject: `Re: ${title(rng)}`,
      snippet: 'Generated message body for the #186 performance baseline.',
      sentAt: now - Math.floor(rng() * 180 * 86_400_000),
      classification: classified ? (rng() < 0.7 ? 'solicitation' : 'other') : null,
      outreachKind:
        classified && rng() < 0.7 ? (rng() < 0.8 ? 'targeted' : 'broadcast_spam') : null,
      needsReview: rng() < 0.1,
      triageDecision: 'passed',
      createdAt: now,
      updatedAt: now,
    });
  }

  return { companies, opportunities, discoveryResults, communications };
}

/** The real company name a measured accept/create call should use, so it lands in the same
 *  clustered pool the seeded opportunities already occupy, rather than a name guaranteed not
 *  to collide with anything (which would make the near-miss loop's companyMatchKey check a
 *  guaranteed miss on every seeded row, understating its cost). */
export function hotCompanyName(index = 0): string {
  return COMPANY_POOL[index % COMPANY_POOL.length] as string;
}

/** A title in the same style as the seeded rows, for a measured accept/create call to use. */
export function randomTitle(seed: number): string {
  return title(mulberry32(seed));
}

export { REAL_SCALE };
