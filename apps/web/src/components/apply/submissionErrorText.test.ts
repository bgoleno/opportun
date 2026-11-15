// The words for a refusal of a change to an attempt started in another session on a shared demo
// account (https://github.com/bgoleno/opportun/issues/545; tl on #566). The server sends only the
// code, so this is the text the visitor reads, and it has to fit both the other visitor and the
// one who started it after their session ended.
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { submissionErrorText } from './api';

describe('submissionErrorText: not_your_application (#545)', () => {
  it('says the attempt belongs to another session, and that it can be read or cancelled', () => {
    expect(submissionErrorText(new ApiError(403, 'not_your_application'))).toBe(
      'This application was started in another session on this shared demo account. You can read it or cancel it; only that session can change it.',
    );
  });
});
