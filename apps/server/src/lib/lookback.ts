// The ingestion window (spec D0, Stage 0): how far back Opportun reads, for every channel.
//
// There is ONE window, not one per channel. It is the largest single cut in Stage 0, and the
// reason this module exists rather than a `linkedin_lookback_days` twin: a second knob would let
// the two drift, and a user who narrowed their mail window would not expect an import to ignore
// it. Issue #53 was the first time that mattered, when a LinkedIn export put twenty years of
// messages into a database whose mail window was 180 days.
//
// Where it is STORED is a wrinkle worth knowing. The window lives inside the user's Gmail query
// string (`newer_than:180d -in:spam -in:trash`), because that is where it was first written, and
// `adapters/gmail` reads it back out. Moving it to a setting of its own would be a migration of
// live user data for no change in behaviour, so what is generalized here is the concept and the
// names, not the storage. The two ways it is applied follow from the channel:
//
//   Gmail      the window is part of the query, so the provider never returns older mail.
//   an archive the whole export arrives at once, so the window is a date predicate on the rows.
//
// A channel that pushes to Opportun (the Apple Mail connector) decides its own scope on the Mac
// and is not bounded here: the server never asks it for anything.

/** The window a user who has set nothing gets (spec D0). */
export const DEFAULT_LOOKBACK_DAYS = 180;

/** The ceiling, which is Gmail's own limit for `newer_than` in days (3 years). */
export const MAX_LOOKBACK_DAYS = 1095;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window encoded in a stored Gmail query, or null when the query was hand-edited into a
 * shape this cannot read. Null means "Opportun does not know this user's window", which each
 * caller answers differently: the Gmail sync sends the query as written, and a channel that has
 * to apply the window itself falls back to the default.
 */
export function lookbackDaysFromQuery(query: string): number | null {
  const match = /^newer_than:(\d{1,4})d -in:spam -in:trash$/.exec(query);
  return match === null ? null : Number(match[1]);
}

/** The oldest `sentAt` a window admits, as epoch milliseconds. */
export function lookbackCutoff(days: number, now: number = Date.now()): number {
  return now - days * DAY_MS;
}
