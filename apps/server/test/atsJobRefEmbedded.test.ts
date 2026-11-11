// Greenhouse jobs embedded on a company's own careers page (https://github.com/bgoleno/opportun/issues/398):
// the one rule every posting writer uses to keep, drop or (from a board read) record a verified
// identity, without a request of its own.
import { describe, expect, it } from 'vitest';
import {
  boardReadAtsJobRef,
  postingAtsJobRef,
  postingAtsJobRefKeeping,
  type AtsJobRef,
} from '../src/lib/atsJobRef';

const CAREERS = 'https://careers.example.com/jobs?gh_jid=8136554';
const VERIFIED: AtsJobRef = {
  kind: 'ats_greenhouse',
  org: 'examplecorp',
  externalId: '8136554',
  url: 'https://job-boards.greenhouse.io/examplecorp/jobs/8136554',
  verifiedVia: 'gh_jid',
  verifiedAt: 1_700_000_000_000,
};

describe('postingAtsJobRefKeeping: the writers that ask nobody (#398 criterion 3)', () => {
  it('a board-host URL gives its identity exactly as postingAtsJobRef does', () => {
    const board = 'https://job-boards.greenhouse.io/examplecorp/jobs/8136554';
    expect(postingAtsJobRefKeeping(board, null)).toEqual(postingAtsJobRef(board));
    expect(postingAtsJobRefKeeping(board, VERIFIED)).toEqual(postingAtsJobRef(board));
  });

  it("keeps a verified identity while the link's gh_jid is its job id", () => {
    expect(postingAtsJobRefKeeping(CAREERS, VERIFIED)).toEqual(VERIFIED);
    // Another page of the same company, same job: still the same job.
    expect(
      postingAtsJobRefKeeping('https://example.com/careers/eng?gh_jid=8136554&src=x', VERIFIED),
    ).toEqual(VERIFIED);
  });

  it('drops it when the link names another job, no job, or is not a link', () => {
    expect(postingAtsJobRefKeeping('https://careers.example.com/jobs?gh_jid=999', VERIFIED)).toBe(
      null,
    );
    expect(postingAtsJobRefKeeping('https://careers.example.com/jobs', VERIFIED)).toBeNull();
    expect(postingAtsJobRefKeeping(null, VERIFIED)).toBeNull();
  });

  it('never makes one up: a careers link with no verified identity gives none', () => {
    expect(postingAtsJobRefKeeping(CAREERS, null)).toBeNull();
    // An identity of another kind, or one not verified for a gh_jid link, is not kept.
    const unverified: AtsJobRef = {
      kind: 'ats_greenhouse',
      org: 'examplecorp',
      externalId: '8136554',
      url: VERIFIED.url,
    };
    expect(postingAtsJobRefKeeping(CAREERS, unverified)).toBeNull();
    expect(postingAtsJobRefKeeping(CAREERS, { ...VERIFIED, kind: 'ats_lever' })).toBeNull();
  });
});

describe('boardReadAtsJobRef: a posting that came out of a Greenhouse board read (tl on #398)', () => {
  const read = { kind: 'ats_greenhouse' as const, org: 'examplecorp' };
  const at = 1_700_000_000_000;

  it("records the board's identity when the posting's link carries its own id as gh_jid", () => {
    expect(boardReadAtsJobRef({ postingUrl: CAREERS, externalId: '8136554' }, read, at)).toEqual(
      VERIFIED,
    );
  });

  it("the token is the board that was read, never the link's board= parameter", () => {
    const ref = boardReadAtsJobRef(
      { postingUrl: `${CAREERS}&board=othercorp`, externalId: '8136554' },
      read,
      at,
    );
    expect(ref?.org).toBe('examplecorp');
    expect(ref?.url).toBe('https://job-boards.greenhouse.io/examplecorp/jobs/8136554');
  });

  it("gives none when the link's gh_jid differs from the posting's id, or is missing", () => {
    expect(
      boardReadAtsJobRef(
        { postingUrl: 'https://careers.example.com/jobs?gh_jid=1', externalId: '8136554' },
        read,
        at,
      ),
    ).toBeNull();
    expect(
      boardReadAtsJobRef(
        { postingUrl: 'https://careers.example.com/jobs/8136554', externalId: '8136554' },
        read,
        at,
      ),
    ).toBeNull();
    expect(boardReadAtsJobRef({ postingUrl: CAREERS, externalId: null }, read, at)).toBeNull();
  });

  it('only a Greenhouse read counts', () => {
    expect(
      boardReadAtsJobRef(
        { postingUrl: CAREERS, externalId: '8136554' },
        { kind: 'ats_lever', org: 'examplecorp' },
        at,
      ),
    ).toBeNull();
  });

  it('a board-host link gives its identity as postingAtsJobRef does', () => {
    const board = 'https://job-boards.greenhouse.io/examplecorp/jobs/8136554';
    expect(boardReadAtsJobRef({ postingUrl: board, externalId: '8136554' }, read, at)).toEqual(
      postingAtsJobRef(board),
    );
  });
});
