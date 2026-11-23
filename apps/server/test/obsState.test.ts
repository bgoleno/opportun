// obs/state.ts holds what obs/tracing, the span store and the span rebuild read from obs/index, so
// that none of them imports obs/index (https://github.com/bgoleno/opportun/issues/803). obs/index
// re-exports the same functions, not copies: one collecting flag and one suppression context.
import { describe, expect, it } from 'vitest';
import * as index from '../src/obs';
import * as state from '../src/obs/state';

describe('obs/index and obs/state share one state (#803)', () => {
  it('re-exports the same functions', () => {
    expect(index.isCollecting).toBe(state.isCollecting);
    expect(index.isSuppressed).toBe(state.isSuppressed);
    expect(index.runSuppressed).toBe(state.runSuppressed);
    expect(index.spanExportSink).toBe(state.spanExportSink);
  });

  it('sees the suppression one sets inside the other', () => {
    expect(index.runSuppressed(() => state.isSuppressed())).toBe(true);
    expect(state.runSuppressed(() => index.isSuppressed())).toBe(true);
    expect(index.isSuppressed()).toBe(false);
  });
});
