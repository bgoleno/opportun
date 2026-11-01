// Pins the tour copy the owner asked for by name, so a later edit to it is deliberate
// (https://github.com/bgoleno/opportun/issues/28, https://github.com/bgoleno/opportun/issues/29).
import type { Checklist, TourStepId } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { TOUR_STEPS, type StepView } from './steps';

const NOTHING_DONE: Checklist = {
  aiKey: false,
  mail: false,
  firstOpportunity: false,
  dismissed: false,
  activatedAt: null,
};
const ALL_DONE: Checklist = { ...NOTHING_DONE, aiKey: true, mail: true, firstOpportunity: true };

/** The step as the tour can open it: nothing or everything set up, on a real or demo instance. */
function views(id: TourStepId): StepView[] {
  const step = TOUR_STEPS.find((s) => s.id === id);
  if (step === undefined) throw new Error(`no tour step ${id}`);
  return [NOTHING_DONE, ALL_DONE].flatMap((c) => [step.view(c, false), step.view(c, true)]);
}

describe('tour copy', () => {
  it('the resumes step says several base resumes can be registered, from each source offered (#28)', () => {
    for (const view of views('resumes')) {
      expect(view.title).toBe('One resume, tailored for every role');
      // Google Docs and Reactive Resume are the stores a resume can be registered from
      // (RegisterBody in apps/server/src/routes/resumes.ts). local_file is in RESUME_STORES
      // too, but only the demo seed and tailored copies of a local_file base create one, so
      // naming it here would promise an upload the app does not offer.
      expect(view.body).toBe(
        'Register as many base resumes as you need, from Google Docs or Reactive Resume, then make a tailored copy for each opportunity with an AI chat that proposes edits. Nothing changes in your document until you apply an edit.',
      );
    }
  });

  it('the discovery step is headed "New opportunities, ranked for you" (#29)', () => {
    for (const view of views('discovery')) {
      expect(view.title).toBe('New opportunities, ranked for you');
    }
  });
});
