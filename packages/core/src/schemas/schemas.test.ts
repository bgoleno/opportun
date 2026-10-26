import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { newId } from '../ids';
import {
  ActivitySchema,
  CommunicationSchema,
  CompanySchema,
  NextStepSchema,
  OpportunitySchema,
  participantName,
  ProfileSchema,
  PromptSchema,
  referralBody,
  referralNoteOf,
  referralStatusOf,
  ResumeRuleSchema,
  ResumeSchema,
  RoleTargetSchema,
  UserSchema,
} from './index';

const NOW = 1_760_000_000_000;
const userId = newId();
const opportunityId = newId();

interface SchemaCase {
  name: string;
  schema: z.ZodType;
  valid: Record<string, unknown>;
  requiredField: string;
  enumField: string | null;
  timestampField: string;
}

const cases: SchemaCase[] = [
  {
    name: 'UserSchema',
    schema: UserSchema,
    valid: {
      id: userId,
      email: 'ada@example.com',
      displayName: 'Ada',
      isAdmin: true,
      createdAt: NOW,
    },
    requiredField: 'email',
    enumField: null,
    timestampField: 'createdAt',
  },
  {
    name: 'ProfileSchema',
    schema: ProfileSchema,
    valid: {
      userId,
      fullName: 'Ada Lovelace',
      headline: 'Product leader',
      links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/ada' }],
      location: 'Seattle, WA',
      workAuth: 'US citizen',
      updatedAt: NOW,
    },
    requiredField: 'userId',
    enumField: null,
    timestampField: 'updatedAt',
  },
  {
    name: 'RoleTargetSchema',
    schema: RoleTargetSchema,
    valid: {
      id: newId(),
      userId,
      name: 'AI PM',
      titleFamily: 'Product Manager',
      seniorityMin: 3,
      seniorityMax: 5,
      industries: ['devtools'],
      keywords: ['agents'],
      locations: ['Remote'],
      remotePref: 'remote',
      compMin: 200000,
      compMax: 300000,
      currency: 'USD',
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
    requiredField: 'name',
    enumField: 'remotePref',
    timestampField: 'createdAt',
  },
  {
    name: 'ResumeRuleSchema',
    schema: ResumeRuleSchema,
    valid: {
      id: newId(),
      userId,
      ruleText: 'Never list my home address.',
      category: 'redaction',
      active: true,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    },
    requiredField: 'ruleText',
    enumField: 'category',
    timestampField: 'updatedAt',
  },
  {
    name: 'CompanySchema',
    schema: CompanySchema,
    valid: {
      id: newId(),
      userId,
      name: 'Initech',
      domain: 'initech.example',
      status: 'followed',
      createdAt: NOW,
      updatedAt: NOW,
    },
    requiredField: 'name',
    enumField: 'status',
    timestampField: 'createdAt',
  },
  {
    name: 'OpportunitySchema',
    schema: OpportunitySchema,
    valid: {
      id: opportunityId,
      userId,
      companyId: newId(),
      title: 'Principal PM, Widget Builder',
      postingUrl: 'https://jobs.example.com/123',
      sourceKind: 'manual',
      remote: true,
      stage: 'applied',
      priority: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    requiredField: 'title',
    enumField: 'stage',
    timestampField: 'updatedAt',
  },
  {
    name: 'ActivitySchema',
    schema: ActivitySchema,
    valid: {
      id: newId(),
      userId,
      opportunityId,
      kind: 'interview',
      title: 'Hiring manager screen',
      occurredAt: NOW,
      participants: ['Jane Doe'],
      createdAt: NOW,
      updatedAt: NOW,
    },
    requiredField: 'opportunityId',
    enumField: 'kind',
    timestampField: 'occurredAt',
  },
  {
    name: 'NextStepSchema',
    schema: NextStepSchema,
    valid: {
      id: newId(),
      userId,
      opportunityId,
      action: 'Send thank-you note',
      dueAt: NOW,
      doneAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    requiredField: 'action',
    enumField: null,
    timestampField: 'dueAt',
  },
  {
    name: 'ResumeSchema',
    schema: ResumeSchema,
    valid: {
      id: newId(),
      userId,
      kind: 'tailored',
      opportunityId,
      title: 'Ada Lovelace, Initech',
      store: 'google_doc',
      docRef: '1AbCdEf',
      status: 'draft',
      createdAt: NOW,
      updatedAt: NOW,
    },
    requiredField: 'docRef',
    enumField: 'store',
    timestampField: 'createdAt',
  },
  {
    name: 'CommunicationSchema',
    schema: CommunicationSchema,
    valid: {
      id: newId(),
      userId,
      channel: 'gmail',
      externalId: 'msg-1',
      from: 'recruiter@example.com',
      to: ['ada@example.com'],
      subject: 'Opportunity at Initech',
      sentAt: NOW,
      classification: 'solicitation',
      outreachKind: 'targeted',
      confidence: 0.9,
      needsReview: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
    requiredField: 'externalId',
    enumField: 'outreachKind',
    timestampField: 'sentAt',
  },
  {
    name: 'PromptSchema',
    schema: PromptSchema,
    valid: {
      id: newId(),
      userId: null,
      taskKey: 'resume.tailor',
      name: 'Default tailoring prompt',
      body: 'Tailor {{resume}} for {{posting}}.',
      version: 1,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
    requiredField: 'body',
    enumField: null,
    timestampField: 'createdAt',
  },
];

describe.each(cases)('$name', ({ schema, valid, requiredField, timestampField }) => {
  it('accepts a valid fixture', () => {
    const result = schema.safeParse(valid);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it(`rejects a fixture missing required field ${requiredField}`, () => {
    const fixture = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== requiredField));
    expect(schema.safeParse(fixture).success).toBe(false);
  });

  it(`rejects a negative timestamp in ${timestampField}`, () => {
    expect(schema.safeParse({ ...valid, [timestampField]: -1 }).success).toBe(false);
  });

  it(`rejects a fractional timestamp in ${timestampField}`, () => {
    expect(schema.safeParse({ ...valid, [timestampField]: NOW + 0.5 }).success).toBe(false);
  });
});

const enumCases = cases.flatMap((c) =>
  c.enumField === null ? [] : [{ ...c, enumField: c.enumField }],
);

describe.each(enumCases)('$name enum', ({ schema, valid, enumField }) => {
  it(`rejects a wrong enum value for ${enumField}`, () => {
    expect(schema.safeParse({ ...valid, [enumField]: 'not_a_real_value' }).success).toBe(false);
  });
});

describe('OpportunitySchema specifics', () => {
  const base = cases.find((c) => c.name === 'OpportunitySchema')?.valid ?? {};

  it('defaults priority to 2', () => {
    const rest = Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'priority'));
    expect(OpportunitySchema.parse(rest).priority).toBe(2);
  });

  it('rejects priority outside 1-3', () => {
    expect(OpportunitySchema.safeParse({ ...base, priority: 0 }).success).toBe(false);
    expect(OpportunitySchema.safeParse({ ...base, priority: 4 }).success).toBe(false);
  });

  it('rejects an unknown closedReason and dismissedReason', () => {
    expect(OpportunitySchema.safeParse({ ...base, closedReason: 'bored' }).success).toBe(false);
    expect(OpportunitySchema.safeParse({ ...base, dismissedReason: 'bored' }).success).toBe(false);
  });
});

describe('ResumeSchema specifics', () => {
  const base = cases.find((c) => c.name === 'ResumeSchema')?.valid ?? {};

  it('accepts every document store, Reactive Resume included (FR-R7)', () => {
    for (const store of ['google_doc', 'local_file', 'reactive_resume']) {
      expect(ResumeSchema.safeParse({ ...base, store }).success).toBe(true);
    }
  });
});

describe('RoleTargetSchema specifics', () => {
  const base = cases.find((c) => c.name === 'RoleTargetSchema')?.valid ?? {};

  it('rejects seniorityMin greater than seniorityMax', () => {
    expect(RoleTargetSchema.safeParse({ ...base, seniorityMin: 6, seniorityMax: 4 }).success).toBe(
      false,
    );
  });
});

describe('newId', () => {
  it('returns a 36-char lowercase UUIDv7', () => {
    const id = newId();
    expect(id).toHaveLength(36);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is time-ordered across 100 calls', () => {
    const ids = Array.from({ length: 100 }, () => newId());
    expect(new Set(ids).size).toBe(100);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('referral activity helpers (FR-C4)', () => {
  it('round-trips status and note through the body, and reads names off participants', () => {
    const body = referralBody('asked', '  Sent my resume.\n\nFollow up Friday. ');
    expect(body).toBe('Status: asked\n\nSent my resume.\n\nFollow up Friday.');
    expect(referralStatusOf(body)).toBe('asked');
    expect(referralNoteOf(body)).toBe('Sent my resume.\n\nFollow up Friday.');
    expect(referralBody('declined', null)).toBe('Status: declined');
    expect(referralStatusOf('Status: declined')).toBe('declined');
    expect(referralNoteOf('Status: declined')).toBeNull();
    // Only a leading, exact status line counts.
    expect(referralStatusOf('Note first\nStatus: agreed')).toBeNull();
    expect(referralStatusOf('Status: maybe')).toBeNull();
    expect(referralStatusOf(null)).toBeNull();
    expect(participantName('Jane Doe')).toBe('Jane Doe');
    expect(participantName({ contactId: 'c1', name: 'Sam Lee' })).toBe('Sam Lee');
    expect(
      ActivitySchema.shape.participants.safeParse(['Jane', { contactId: 'c1', name: 'Sam' }])
        .success,
    ).toBe(true);
    expect(ActivitySchema.shape.participants.safeParse([{ name: 'No id' }]).success).toBe(false);
  });
});

describe('OpportunitySchema posting reconciliation fields', () => {
  it('carries the ATS ref and the reconciliation state', () => {
    const shape = Object.keys(OpportunitySchema.shape);
    expect(shape).toEqual(
      expect.arrayContaining(['atsJobRef', 'postingState', 'postingStateDetail']),
    );
  });

  it('omits descriptionFingerprint, which is an internal guard and not API surface', () => {
    expect(Object.keys(OpportunitySchema.shape)).not.toContain('descriptionFingerprint');
  });

  it('accepts an opportunity with every reconciliation field absent', () => {
    const base = {
      id: '01a14851-2ce2-7e92-b8e6-7b6f1d8011d0',
      userId: '01a143a8-4ff1-734d-9fd4-8e6f0cc03467',
      companyId: '01a143a8-4ff1-734d-9fd4-8e6f0cc03468',
      title: 'Staff PM',
      sourceKind: 'discovery',
      stage: 'interested',
      createdAt: 1792394891061,
      updatedAt: 1792394891061,
    };
    expect(OpportunitySchema.safeParse(base).success).toBe(true);
  });
});
