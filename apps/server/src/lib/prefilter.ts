// The discovery pre-filter (https://github.com/bgoleno/opportun/issues/217, tl's proposal section 4
// on #190): whether a new board posting is worth a ranking call, judged in process from its
// title, location and remote setting against the user's role targets. Pure, no AI and no I/O.
//
// The verdict is stored on the result and measured (its recall on the user's own accepted
// postings). Until that recall holds it acts on nothing: every posting is ranked as before. Once it
// holds, a filtered posting gets no ranking call and waits for Rank anyway (#218, the owner's
// decision 5 on #190). prefilterRecall in repos/discovery.ts is the gate.
//
// Built for recall (a missed good posting costs more than a wasted call): a rule only filters on
// what the posting clearly states. A posting with no location, or one naming no particular place,
// or no remote setting, is not filtered for it, and a title passes when at least half of a
// variant's words are in it.
import type {
  NormalizedPosting,
  PrefilterOutcome,
  PrefilterRule,
  RemotePref,
} from '@opportun/core';

/** An ATS board: the sources the pre-filter judges. Mail, MCP and captures are not. */
export const isBoardSource = (kind: string): boolean => kind.startsWith('ats_');

/** The bar for acting on the verdicts: at least 95% of at least 20 of the user's own positives. */
export const PREFILTER_ON_RECALL_PERCENT = 95;
export const PREFILTER_ON_POSITIVES = 20;

/** Whether recall holds. In whole numbers, so 94.9% cannot round its way over the bar. */
export const prefilterHolds = (kept: number, positives: number): boolean =>
  positives >= PREFILTER_ON_POSITIVES && kept * 100 >= positives * PREFILTER_ON_RECALL_PERCENT;

/** A title passes when its score (0 to 1) is at least this. */
export const TITLE_PASS_SCORE = 0.5;

/** The parts of a posting the filter reads. */
export type PrefilterPosting = Pick<NormalizedPosting, 'title' | 'location' | 'remote'>;

/** The parts of a role target the filter reads. */
export interface PrefilterTarget {
  name: string;
  titleFamily: string;
  titleVariants: readonly string[];
  locations: readonly string[];
  remotePref: RemotePref;
}

export interface PrefilterVerdict {
  outcome: PrefilterOutcome;
  /** The rule that filtered it; null when it passed. */
  rule: PrefilterRule | null;
  /** The best title match over the targets, 0 to 1, two decimals. */
  score: number;
}

/**
 * Words that say nothing about which job it is: seniority and level, and small words. "Senior
 * Platform Engineer" is a "Platform Engineer" for the title rule; seniority is the ranker's call.
 */
const IGNORED = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'to',
  'in',
  'at',
  'on',
  'with',
  'or',
  'senior',
  'sr',
  'junior',
  'jr',
  'staff',
  'principal',
  'lead',
  'chief',
  'head',
  'associate',
  'intern',
  'entry',
  'level',
  'mid',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
]);

/** A text's words, lower case, accents folded, punctuation dropped, ignored words removed. */
export function titleWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !IGNORED.has(w));
}

/** The share of a phrase's words found in the title, best over the phrases (0 when none). */
export function titleScore(postingTitle: string, phrases: readonly string[]): number {
  const words = new Set(titleWords(postingTitle));
  let best = 0;
  for (const phrase of phrases) {
    const want = [...new Set(titleWords(phrase))];
    if (want.length === 0) continue;
    const hit = want.filter((w) => words.has(w)).length;
    best = Math.max(best, hit / want.length);
  }
  return Math.round(best * 100) / 100;
}

/** Whether the posting's remote setting rules it out for this target, from what it states. */
function remoteRefuses(posting: PrefilterPosting, pref: RemotePref): boolean {
  if (posting.remote === true) return pref === 'onsite';
  if (posting.remote === false) return pref === 'remote';
  return false;
}

/**
 * Names too broad to rule a posting in or out: countries, US states and regions, with the usual
 * short forms. "Texas" holds Austin and "Germany" holds Berlin, and the filter does not know that,
 * so neither a target nor a posting naming only these can be judged. Small on purpose: a country
 * missing from it (a target "Kenya", a posting "Nairobi") is a known miss. "New York" and
 * "Washington" are left out because they are usually the city.
 */
const BROAD_PLACES = new Set([
  // Regions.
  'africa',
  'americas',
  'apac',
  'asia',
  'bay area',
  'central america',
  'eea',
  'emea',
  'eu',
  'europe',
  'european union',
  'latam',
  'latin america',
  'middle east',
  'nordics',
  'north america',
  'northeast',
  'northwest',
  'oceania',
  'silicon valley',
  'south america',
  'southeast',
  'southwest',
  'west coast',
  'east coast',
  'midwest',
  // Countries.
  'argentina',
  'australia',
  'austria',
  'belgium',
  'brazil',
  'bulgaria',
  'canada',
  'chile',
  'china',
  'colombia',
  'costa rica',
  'croatia',
  'czech republic',
  'czechia',
  'denmark',
  'egypt',
  'england',
  'estonia',
  'finland',
  'france',
  'germany',
  'great britain',
  'greece',
  'hong kong',
  'hungary',
  'india',
  'indonesia',
  'ireland',
  'israel',
  'italy',
  'japan',
  'latvia',
  'lithuania',
  'luxembourg',
  'malaysia',
  'mexico',
  'netherlands',
  'new zealand',
  'nigeria',
  'norway',
  'pakistan',
  'peru',
  'philippines',
  'poland',
  'portugal',
  'romania',
  'scotland',
  'serbia',
  'singapore',
  'slovakia',
  'slovenia',
  'south africa',
  'south korea',
  'spain',
  'sweden',
  'switzerland',
  'taiwan',
  'thailand',
  'turkey',
  'u s',
  'u k',
  'uae',
  'uk',
  'ukraine',
  'united arab emirates',
  'united kingdom',
  'united states',
  'united states america',
  'us',
  'usa',
  'vietnam',
  'wales',
  // Canadian provinces.
  'alberta',
  'british columbia',
  'ontario',
  'quebec',
  // US states and their abbreviations.
  'alabama',
  'al',
  'alaska',
  'ak',
  'arizona',
  'az',
  'arkansas',
  'ar',
  'california',
  'ca',
  'colorado',
  'co',
  'connecticut',
  'ct',
  'delaware',
  'de',
  'dc',
  'd c',
  'district columbia',
  'florida',
  'fl',
  'georgia',
  'ga',
  'hawaii',
  'hi',
  'idaho',
  'id',
  'illinois',
  'il',
  'indiana',
  'iowa',
  'ia',
  'kansas',
  'ks',
  'kentucky',
  'ky',
  'louisiana',
  'la',
  'maine',
  'me',
  'maryland',
  'md',
  'massachusetts',
  'ma',
  'michigan',
  'mi',
  'minnesota',
  'mn',
  'mississippi',
  'ms',
  'missouri',
  'mo',
  'montana',
  'mt',
  'nebraska',
  'ne',
  'nevada',
  'nv',
  'new hampshire',
  'nh',
  'new jersey',
  'nj',
  'new mexico',
  'nm',
  'ny',
  'north carolina',
  'nc',
  'north dakota',
  'nd',
  'ohio',
  'oh',
  'oklahoma',
  'ok',
  'oregon',
  'pennsylvania',
  'pa',
  'rhode island',
  'ri',
  'south carolina',
  'sc',
  'south dakota',
  'sd',
  'tennessee',
  'tn',
  'texas',
  'tx',
  'utah',
  'ut',
  'vermont',
  'vt',
  'virginia',
  'va',
  'wa',
  'west virginia',
  'wv',
  'wisconsin',
  'wi',
  'wyoming',
  'wy',
]);

/** The most words a BROAD_PLACES name has. */
const LONGEST_BROAD_PLACE = 3;

/**
 * Words in a location that name no particular place: how the job is worked ("Hybrid", "Multiple
 * locations"), and the parts many places share, so that San Francisco and San Diego do not match
 * on "san", nor New York and New Orleans on "new".
 */
const NOT_A_PLACE = new Set([
  'anywhere',
  'area',
  'bay',
  'city',
  'county',
  'distributed',
  'downtown',
  'east',
  'el',
  'flexible',
  'fort',
  'from',
  'ft',
  'global',
  'globally',
  'greater',
  'headquarters',
  'home',
  'hq',
  'hybrid',
  'lake',
  'las',
  'location',
  'locations',
  'los',
  'metro',
  'metropolitan',
  'multiple',
  'nationwide',
  'new',
  'north',
  'office',
  'offices',
  'onsite',
  'port',
  'region',
  'remote',
  'saint',
  'san',
  'santa',
  'several',
  'site',
  'south',
  'st',
  'tbd',
  'various',
  'virtual',
  'west',
  'wfh',
  'work',
  'worldwide',
]);

/** Short forms people type for a city; each stands for the words of its full name. */
const PLACE_SHORT_FORMS: ReadonlyMap<string, readonly string[]> = new Map([
  ['nyc', ['new', 'york']],
  ['sf', ['san', 'francisco']],
]);

/**
 * The words of a location that name a particular place: short forms spelled out, then broad names
 * and NOT_A_PLACE words dropped. "San Francisco Bay Area" is ["francisco"], "Austin, TX" is
 * ["austin"], and "United States" or "Multiple locations" is nothing at all.
 */
function placeWords(text: string): string[] {
  const words = titleWords(text).flatMap((w) => PLACE_SHORT_FORMS.get(w) ?? [w]);
  const out: string[] = [];
  for (let i = 0; i < words.length;) {
    let broad = 0;
    for (let n = Math.min(LONGEST_BROAD_PLACE, words.length - i); n > 0 && broad === 0; n--) {
      if (BROAD_PLACES.has(words.slice(i, i + n).join(' '))) broad = n;
    }
    if (broad > 0) {
      i += broad;
      continue;
    }
    const word = words.at(i)!;
    if (!NOT_A_PLACE.has(word)) out.push(word);
    i += 1;
  }
  return out;
}

/**
 * Whether the posting names a place that is clearly none of the target's. It is kept when:
 * - the target has no places, or any of them is too broad to judge ("Texas", "Europe", "Remote"),
 *   since the filter cannot tell what lies inside it;
 * - it is remote by its flag or its location, and the target would take that;
 * - a place of the target's shares a particular word with it (only the part before a comma counts:
 *   "Austin, TX" is "austin");
 * - it states no location, or one naming no particular place ("Multiple locations", "USA").
 *
 * Known misses, accepted: the filter has no idea which towns surround a city, so a target
 * "Seattle" filters a posting "Bellevue, WA", and "Washington, DC" is taken as "washington".
 */
function locationRefuses(posting: PrefilterPosting, target: PrefilterTarget): boolean {
  if (target.locations.length === 0) return false;
  if (posting.remote === true && target.remotePref !== 'onsite') return false;
  const stated = posting.location?.trim() ?? '';
  if (stated === '') return false;
  const isRemote = titleWords(stated).includes('remote');
  if (isRemote && target.remotePref !== 'onsite') return false;
  const wanted = target.locations.map((place) => placeWords(place.split(',')[0] ?? ''));
  if (wanted.some((words) => words.length === 0)) return false;
  const here = new Set(placeWords(stated));
  if (wanted.some((words) => words.some((w) => here.has(w)))) return false;
  // Remote work, for a target that wants an office, is refused whatever else it names.
  return isRemote || here.size > 0;
}

/** One target's verdict: the title first, then remote, then location. */
function judgeFor(posting: PrefilterPosting, target: PrefilterTarget): PrefilterVerdict {
  const score = titleScore(posting.title, [
    target.name,
    target.titleFamily,
    ...target.titleVariants,
  ]);
  const rule: PrefilterRule | null =
    score < TITLE_PASS_SCORE
      ? 'title'
      : remoteRefuses(posting, target.remotePref)
        ? 'remote'
        : locationRefuses(posting, target)
          ? 'location'
          : null;
  return { outcome: rule === null ? 'pass' : 'filtered', rule, score };
}

/**
 * The verdict over the role targets a source ranks against: it passes when any target passes.
 * Otherwise it is filtered by the rule of the target its title matches best. Null with no target
 * to judge against (the user has none active): nothing can be said.
 */
export function prefilter(
  posting: PrefilterPosting,
  targets: readonly PrefilterTarget[],
): PrefilterVerdict | null {
  if (targets.length === 0) return null;
  const verdicts = targets.map((t) => judgeFor(posting, t));
  const best = Math.max(...verdicts.map((v) => v.score));
  const passed = verdicts.find((v) => v.outcome === 'pass');
  if (passed !== undefined) return { outcome: 'pass', rule: null, score: best };
  const closest = verdicts.find((v) => v.score === best) ?? verdicts[0]!;
  return { outcome: 'filtered', rule: closest.rule, score: best };
}
