// Pure display rules for a provider key row: the status chip and the Expires column.
import type { AiKey, KeyValidation } from './api';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A valid key this close to its stored expiry is shown as a warning. */
export const EXPIRY_WARNING_DAYS = 14;

export type ChipVariant = 'success' | 'destructive' | 'warning' | 'outline';

export interface KeyChip {
  variant: ChipVariant;
  label: string;
  /** Secondary text (checked date or the short failure reason). Rendered as a text node. */
  detail: string | null;
}

const checkedFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** Expiry dates are stored as UTC midnight of the chosen day, so format them in UTC. */
export const expiryFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

/** Whole days until (positive) or since (negative) an expiry, by calendar day in UTC. */
export function daysUntil(expiresAt: number, now: number): number {
  const today = Math.floor(now / DAY_MS);
  const day = Math.floor(expiresAt / DAY_MS);
  return day - today;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The server's prefix for Anthropic's "not scoped to a workspace" model error. */
export const WORKSPACE_SCOPING_PREFIX = 'workspace scoping: ';

/**
 * For a key that authenticated: null when every checked model works, otherwise the label
 * for the degraded state. "Bad scope" only when every failure is the workspace scoping class.
 */
export function degradedLabel(v: KeyValidation): 'Bad scope' | 'Model errors' | null {
  const failing = v.models.filter((m) => !m.ok);
  if (failing.length === 0) return null;
  return failing.every((m) => m.error?.startsWith(WORKSPACE_SCOPING_PREFIX) === true)
    ? 'Bad scope'
    : 'Model errors';
}

export function keyChip(key: AiKey, now: number): KeyChip {
  const v = key.validation;
  if (v === null) return { variant: 'outline', label: 'Not checked', detail: null };
  if (!v.ok) return { variant: 'destructive', label: 'Invalid', detail: v.error ?? 'Rejected' };
  const checked = `Checked ${checkedFmt.format(v.checkedAt)}`;
  // A key that authenticates but cannot run its models does not work: never green. This
  // wins over the expiry warning; the Expires column still shows the date.
  const degraded = degradedLabel(v);
  if (degraded !== null) return { variant: 'warning', label: degraded, detail: checked };
  if (key.expiresAt !== null) {
    const days = daysUntil(key.expiresAt, now);
    if (days < 0)
      return { variant: 'warning', label: 'Valid, expiry date passed', detail: checked };
    if (days <= EXPIRY_WARNING_DAYS) {
      const label =
        days === 0 ? 'Valid, expires today' : `Valid, expires in ${plural(days, 'day')}`;
      return { variant: 'warning', label, detail: checked };
    }
  }
  return { variant: 'success', label: 'Valid', detail: checked };
}

export interface ExpiryText {
  text: string;
  expired: boolean;
  title: string | null;
}

/**
 * The Expires column. Providers expose no key expiry, so this is the date the user entered
 * (from their provider console), or "Not provided".
 */
export function expiryText(expiresAt: number | null, now: number): ExpiryText {
  if (expiresAt === null) return { text: 'Not provided', expired: false, title: null };
  const days = daysUntil(expiresAt, now);
  const title = expiryFmt.format(expiresAt);
  if (days < 0) return { text: `Expired ${plural(-days, 'day')} ago`, expired: true, title };
  if (days === 0) return { text: 'Today', expired: false, title };
  return { text: `in ${plural(days, 'day')}`, expired: false, title };
}

/** "YYYY-MM-DD" from a date input to UTC midnight epoch ms; null for blank or invalid. */
export function dateInputToEpoch(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (m === null) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

export function epochToDateInput(epoch: number | null): string {
  return epoch === null ? '' : new Date(epoch).toISOString().slice(0, 10);
}
