import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { stageErrorMessage, stageRefusal, stageTargets } from './opportunities';

// #397: a refused move says what is allowed, from the list the stage control offers.
describe('stageRefusal', () => {
  it('names every stage the control offers, in its order', () => {
    expect(stageRefusal('in_process', 'in_process')).toBe(
      'In process can move to New, Interested, Preparing, Applied, Offer, Dismissed or Closed.',
    );
  });

  it('keeps the Reopen sentence for a chain stage out of closed or dismissed', () => {
    expect(stageRefusal('closed', 'preparing')).toBe(
      'Use Reopen to move a closed opportunity back to Preparing.',
    );
    expect(stageRefusal('dismissed', 'interested')).toBe(
      'Use Reopen to move a dismissed opportunity back to Interested.',
    );
  });

  it('names a single allowed stage without a list', () => {
    expect(stageTargets('closed')).toEqual(['dismissed']);
    expect(stageRefusal('closed', 'closed')).toBe('Closed can move to Dismissed.');
  });
});

describe('stageErrorMessage', () => {
  const refused = (details: Record<string, unknown>, message = 'Invalid stage transition') =>
    new ApiError(422, 'invalid_transition', message, undefined, details);

  it("builds the sentence from the server's from and to, not its raw text", () => {
    const err = refused(
      { from: 'in_process', to: 'in_process' },
      'Invalid stage transition in_process -> in_process',
    );
    expect(stageErrorMessage(err)).toBe(
      'In process can move to New, Interested, Preparing, Applied, Offer, Dismissed or Closed.',
    );
  });

  it('says to use Reopen when the server refuses a move out of a closed opportunity', () => {
    const err = refused({ from: 'closed', to: 'applied' });
    expect(stageErrorMessage(err)).toBe('Use Reopen to move a closed opportunity back to Applied.');
  });

  it("falls back to the server's message when from or to is missing or not a stage", () => {
    expect(stageErrorMessage(refused({}, 'Invalid stage transition x -> y'))).toBe(
      'Invalid stage transition x -> y',
    );
    expect(stageErrorMessage(refused({ from: 'nowhere', to: 'applied' }, 'raw'))).toBe('raw');
  });

  it("falls back to the server's message for a move the rule allows (a close with no reason)", () => {
    const err = refused(
      { from: 'offer', to: 'closed' },
      'Invalid stage transition offer -> closed: closedReason is required',
    );
    expect(stageErrorMessage(err)).toBe(
      'Invalid stage transition offer -> closed: closedReason is required',
    );
  });

  it('leaves other errors to errorMessage', () => {
    expect(stageErrorMessage(new ApiError(404, 'not_found'))).toBe('Not found.');
    expect(stageErrorMessage(new Error('offline'))).toBe('offline');
  });
});
