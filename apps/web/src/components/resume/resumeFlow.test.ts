// The resume flow's state, from real data (https://github.com/bgoleno/opportun/issues/428, tl's
// table A to H on #400): one test per row, and the precedence between them.
import { describe, expect, it } from 'vitest';
import { appliedAttempt, type SubmissionView } from '@/components/apply/api';
import type { Resume, ResumeSend } from './api';
import { flowSentence, resumeFlowState, type FlowInput } from './resumeFlow';

const resume = (over: Partial<Resume>): Resume =>
  ({
    id: 'r',
    kind: 'tailored',
    opportunityId: 'opp-1',
    title: 'Acme Staff Engineer resume',
    store: 'google_doc',
    docRef: 'd',
    url: null,
    parentResumeId: 'base',
    status: 'draft',
    submittedAt: null,
    submittedTo: null,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as Resume;

const BASE = resume({
  id: 'base',
  kind: 'base',
  opportunityId: null,
  parentResumeId: null,
  title: 'Jane base',
});
const attempt = (over: Partial<SubmissionView>): SubmissionView =>
  ({
    id: 's',
    opportunityId: 'opp-1',
    status: 'draft',
    atsKind: 'ats_greenhouse',
    ...over,
  }) as SubmissionView;
const send = (over: Partial<ResumeSend>): ResumeSend =>
  ({
    id: 'send',
    opportunityId: 'opp-1',
    opportunityTitle: 'Staff Engineer',
    companyName: 'Acme',
    resumeId: 'base',
    resumeTitle: 'Jane base',
    resumeKind: 'base',
    sentAt: 2,
    sentVia: 'Indeed',
    submissionId: null,
    createdAt: 2,
    ...over,
  }) as ResumeSend;

const input = (over: Partial<FlowInput>): FlowInput => ({
  opportunityId: 'opp-1',
  resumes: [],
  sends: [],
  attempts: [],
  applyBlocked: null,
  ...over,
});

describe('resumeFlowState: one state for each row of the table (#428)', () => {
  it('A: no base resume registered', () => {
    expect(resumeFlowState(input({}))).toMatchObject({ state: 'A', step: 1 });
  });

  it('B: a base exists, and nothing for this opportunity', () => {
    expect(resumeFlowState(input({ resumes: [BASE] }))).toMatchObject({ state: 'B', step: 1 });
    // Another opportunity's tailored copy is not this one's.
    expect(
      resumeFlowState(input({ resumes: [BASE, resume({ opportunityId: 'opp-2' })] })),
    ).toMatchObject({ state: 'B' });
  });

  it('C: a tailored copy in Draft', () => {
    const r = resume({ status: 'draft' });
    expect(resumeFlowState(input({ resumes: [BASE, r] }))).toMatchObject({
      state: 'C',
      step: 2,
      resume: r,
    });
  });

  it('D: a tailored copy In review', () => {
    const r = resume({ status: 'in_review' });
    expect(resumeFlowState(input({ resumes: [BASE, r] }))).toMatchObject({
      state: 'D',
      step: 3,
      resume: r,
    });
  });

  it('E: a Final tailored copy, and assisted apply can start', () => {
    const r = resume({ status: 'final' });
    expect(resumeFlowState(input({ resumes: [BASE, r] }))).toMatchObject({
      state: 'E',
      step: 4,
      resume: r,
    });
  });

  it('F: Final, but assisted apply cannot start, with its reason', () => {
    const r = resume({ status: 'final' });
    expect(
      resumeFlowState(input({ resumes: [BASE, r], applyBlocked: 'Confirm the posting first.' })),
    ).toMatchObject({ state: 'F', step: 4, resume: r, reason: 'Confirm the posting first.' });
  });

  it('G: an assisted apply attempt in progress', () => {
    const live = attempt({ status: 'reviewed' });
    expect(
      resumeFlowState(input({ resumes: [BASE, resume({ status: 'final' })], attempts: [live] })),
    ).toMatchObject({ state: 'G', step: 4, attempt: live });
  });

  it('H: a send is recorded, or the resume is Submitted', () => {
    expect(resumeFlowState(input({ resumes: [BASE], sends: [send({})] }))).toMatchObject({
      state: 'H',
      step: 'done',
    });
    const submitted = resume({ status: 'submitted' });
    expect(resumeFlowState(input({ resumes: [BASE, submitted] }))).toMatchObject({
      state: 'H',
      resume: submitted,
    });
  });
});

describe('resumeFlowState: which state wins', () => {
  it("H is #426's applied state: the attempt appliedAttempt picks, over an older Final resume", () => {
    const done = attempt({ id: 'done', status: 'confirmed' });
    const attempts = [attempt({ id: 'gone', status: 'abandoned' }), done];
    const state = resumeFlowState(
      input({ resumes: [BASE, resume({ status: 'final' })], attempts }),
    );
    expect(state).toMatchObject({ state: 'H', attempt: done });
    expect(state.state === 'H' ? state.attempt : undefined).toBe(appliedAttempt(attempts));
  });

  it('an attempt in progress (G) comes before an earlier application (H)', () => {
    const attempts = [
      attempt({ id: 'live', status: 'draft' }),
      attempt({ id: 'old', status: 'submitted' }),
    ];
    expect(resumeFlowState(input({ resumes: [BASE], attempts }))).toMatchObject({ state: 'G' });
  });

  // tl on #431: a send means the user has applied, whatever copy is tailored afterwards.
  it('a recorded send comes before a tailored copy in Draft (H, not C)', () => {
    const draft = resume({ status: 'draft' });
    expect(
      resumeFlowState(input({ resumes: [BASE, draft], sends: [send({})] })),
    ).toMatchObject({ state: 'H', send: { id: 'send' } });
  });

  it("this opportunity's resume is its newest tailored one that is not archived", () => {
    const older = resume({ id: 'old', status: 'final', createdAt: 1 });
    const newer = resume({ id: 'new', status: 'in_review', createdAt: 5 });
    const archived = resume({ id: 'arch', status: 'draft', createdAt: 9, archivedAt: 10 });
    expect(resumeFlowState(input({ resumes: [BASE, older, newer, archived] }))).toMatchObject({
      state: 'D',
      resume: newer,
    });
  });

  it('an archived base does not count as a base', () => {
    expect(resumeFlowState(input({ resumes: [{ ...BASE, archivedAt: 3 }] }))).toMatchObject({
      state: 'A',
    });
  });
});

describe("flowSentence: the panel's words for the resume states", () => {
  it('says what to do, naming the resume', () => {
    expect(flowSentence(resumeFlowState(input({})))).toBe('Add a base resume to start.');
    expect(flowSentence(resumeFlowState(input({ resumes: [BASE] })))).toBe(
      'Choose the resume to start from.',
    );
    expect(
      flowSentence(resumeFlowState(input({ resumes: [BASE, resume({ status: 'draft' })] }))),
    ).toBe(
      '"Acme Staff Engineer resume" is still a Draft. Tailor it, then mark it as final to apply.',
    );
    expect(
      flowSentence(resumeFlowState(input({ resumes: [BASE, resume({ status: 'in_review' })] }))),
    ).toBe('"Acme Staff Engineer resume" is still In review. Mark it as final to apply.');
  });

  it('H through a send: says it was sent, and what applying here too needs (tl on #428)', () => {
    expect(flowSentence(resumeFlowState(input({ resumes: [BASE], sends: [send({})] })))).toBe(
      'A resume is already recorded as sent for this opportunity. To apply here too, mark a resume as final.',
    );
  });

  it('has nothing to say once the resume is not what blocks applying', () => {
    expect(
      flowSentence(resumeFlowState(input({ resumes: [BASE, resume({ status: 'final' })] }))),
    ).toBeNull();
  });
});
