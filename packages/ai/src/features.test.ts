// The feature map (https://github.com/bgoleno/opportun/issues/341): every AI task belongs to exactly
// one product feature, so Settings > AI > Usage can group by feature and O4 and O6 can label by it.
// The Record type makes a new task key without a feature a type error; these tests pin the rest.
import { describe, expect, it } from 'vitest';
import { FEATURES, TASK_FEATURE, TASK_KEYS, tasksOfFeature } from './index';

describe('FEATURES and TASK_FEATURE (#341)', () => {
  it('lists the features in order, each with a label', () => {
    expect(FEATURES.map((f) => f.label)).toEqual([
      'Resume tailoring',
      'Matching',
      'Discovery',
      'Capture',
      'Mail',
      'Companies',
      'Referrals',
      'Duplicates',
      'Integrations',
    ]);
    expect(new Set(FEATURES.map((f) => f.key)).size).toBe(FEATURES.length);
  });

  it('maps every task key to a listed feature, and nothing else', () => {
    const keys = new Set(FEATURES.map((f) => f.key));
    expect(Object.keys(TASK_FEATURE).sort()).toEqual([...TASK_KEYS].sort());
    for (const task of TASK_KEYS) expect(keys.has(TASK_FEATURE[task]), task).toBe(true);
  });

  it('gives every feature at least one task, in registry order', () => {
    for (const f of FEATURES) expect(tasksOfFeature(f.key).length, f.key).toBeGreaterThan(0);
    expect(FEATURES.flatMap((f) => tasksOfFeature(f.key)).sort()).toEqual([...TASK_KEYS].sort());
    expect(tasksOfFeature('capture')).toEqual([
      'capture.extract',
      'capture.linkedin',
      'capture.job',
      'posting.merge',
    ]);
  });

  it('puts each task where its name says', () => {
    expect(TASK_FEATURE['resume.tailor']).toBe('resume_tailoring');
    expect(TASK_FEATURE['resume.match']).toBe('matching');
    expect(TASK_FEATURE['discovery.rank']).toBe('discovery');
    expect(TASK_FEATURE['discovery.company_tags']).toBe('discovery');
    expect(TASK_FEATURE['comms.triage']).toBe('mail');
    expect(TASK_FEATURE['comms.classify']).toBe('mail');
    expect(TASK_FEATURE['company.suggest']).toBe('companies');
    expect(TASK_FEATURE['referral.rationale']).toBe('referrals');
    expect(TASK_FEATURE['opportunity.dedupe']).toBe('duplicates');
    expect(TASK_FEATURE['integration.diagnose']).toBe('integrations');
  });
});
