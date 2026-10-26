import { describe, expect, it } from 'vitest';
import { ACTIVITY_KINDS } from '@opportun/core';
import { activityKindLabel } from './opportunities';

describe('activityKindLabel', () => {
  it('names every activity kind, so no badge ever shows a raw enum key', () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(activityKindLabel(kind), kind).not.toBe(kind);
    }
  });

  it('names the browser capture readably', () => {
    expect(activityKindLabel('capture')).toBe('Captured page');
  });
});
