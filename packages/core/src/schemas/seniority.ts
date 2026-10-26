// Canonical seniority ladder. Role targets store seniority as an ordinal integer; this ladder
// gives the ordinals shared names so the form and the AI prompts mean the same thing by them.
// Values outside the ladder (legacy or API-written) stay valid and render as "Level N".

export const SENIORITY_LEVELS = [
  { value: 1, label: 'Junior' },
  { value: 2, label: 'Mid-level' },
  { value: 3, label: 'Senior' },
  { value: 4, label: 'Staff' },
  { value: 5, label: 'Principal' },
  { value: 6, label: 'Distinguished' },
  { value: 7, label: 'Director' },
  { value: 8, label: 'Senior Director' },
  { value: 9, label: 'VP' },
  { value: 10, label: 'Executive' },
] as const;

/** Ladder name for an ordinal: exact match, else `Level N`; null for no value. */
export function seniorityLabel(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const level = SENIORITY_LEVELS.find((l) => l.value === value);
  return level ? level.label : `Level ${value}`;
}

/**
 * A seniority range in words for prompt context: "Staff to Principal", "Senior or above",
 * "up to Principal", "Staff" (min equals max) or "any" (open at both ends).
 */
export function seniorityRangeText(
  min: number | null | undefined,
  max: number | null | undefined,
): string {
  const lo = seniorityLabel(min);
  const hi = seniorityLabel(max);
  if (lo === null && hi === null) return 'any';
  if (lo !== null && hi !== null) return min === max ? lo : `${lo} to ${hi}`;
  return lo !== null ? `${lo} or above` : `up to ${hi}`;
}
