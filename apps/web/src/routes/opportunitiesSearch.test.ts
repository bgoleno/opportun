// The opportunity page's tab in the URL (https://github.com/bgoleno/opportun/issues/428).
import { describe, expect, it } from 'vitest';
import { parseOpportunitySearch } from './opportunities.$id';

describe('parseOpportunitySearch', () => {
  it('keeps a known tab', () => {
    for (const tab of ['timeline', 'details', 'resume', 'communications', 'referrals'] as const) {
      expect(parseOpportunitySearch({ tab })).toEqual({ tab });
    }
  });

  it('drops anything else: a deep link names only a real tab', () => {
    expect(parseOpportunitySearch({})).toEqual({});
    expect(parseOpportunitySearch({ tab: 'settings' })).toEqual({});
    expect(parseOpportunitySearch({ tab: ['resume'] })).toEqual({});
    expect(parseOpportunitySearch({ tab: 'resume', other: 'x' })).toEqual({ tab: 'resume' });
  });
});
