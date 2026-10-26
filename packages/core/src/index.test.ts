import { describe, expect, it } from 'vitest';
import { VERSION } from './index';

describe('core package', () => {
  it('exports a semver VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
