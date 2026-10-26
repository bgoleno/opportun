// Static demo dataset (issue #280): invented, on RFC 2606 reserved domains, per the fixture
// rule in docs/pre-publication-checklist.md section 4. Never a real company, posting id or
// person. IDs are pinned, literal UUIDv7 strings generated once offline with newId() and
// hardcoded here, not generated at seed time: a delete-and-reseed nightly reset only keeps a
// bookmarked opportunity URL stable if the seeder gives it the same id every time, and every
// id here matches newId()'s own format (uuidv7) so nothing about these rows looks different
// from a row the app created itself, now or if an id validation is ever added later.
//
// Timestamps are expressed as offsets from the seed's own `now` ("applied 9 days ago"), not
// absolute dates, so the demo does not visibly age between resets; seedDemo.ts resolves them.
//
// Resumes (local_file, #284) and match reports: one base resume per account plus a tailored
// variant for every opportunity at 'preparing' or later, since those are the ones a real
// candidate would actually have a resume for. 'discovered'/'interested' opportunities have
// none, same as a real pipeline, and the ambiguous/needs_review posting is left out too --
// nobody tailors a resume for a job they are not sure is real yet. Match reports follow the
// same set, scored around the time preparation started.

const DAY = 24 * 60 * 60 * 1000;

export interface DemoUser {
  id: string;
  email: string;
  displayName: string;
  /** Offset from seed time, strictly increasing so the five sort admin-first by createdAt
   *  alone, not by the id tiebreak (GET /admin/users orders by createdAt then id). */
  createdAtOffsetMs: number;
}

/** The first to register becomes admin (FR-S2); registered in this order. */
export const DEMO_USERS: readonly DemoUser[] = [
  {
    id: '01a16262-25d9-7e83-a0a8-d7b092905e81',
    email: 'demo-admin@opportun-demo.example',
    displayName: 'Demo Admin',
    createdAtOffsetMs: -30 * DAY,
  },
  {
    id: '01a16262-25da-7993-b4a8-f45db5ff2fa0',
    email: 'demo-user1@opportun-demo.example',
    displayName: 'Demo User 1',
    createdAtOffsetMs: -30 * DAY + 1000,
  },
  {
    id: '01a16262-25da-7993-b4a8-f45e84056f1c',
    email: 'demo-user2@opportun-demo.example',
    displayName: 'Demo User 2',
    createdAtOffsetMs: -30 * DAY + 2000,
  },
  {
    id: '01a16262-25da-7993-b4a8-f45fd107dd86',
    email: 'demo-user3@opportun-demo.example',
    displayName: 'Demo User 3',
    createdAtOffsetMs: -30 * DAY + 3000,
  },
  {
    id: '01a16262-25da-7993-b4a8-f4608a59655c',
    email: 'demo-user4@opportun-demo.example',
    displayName: 'Demo User 4',
    createdAtOffsetMs: -30 * DAY + 4000,
  },
] as const;

export interface DemoCompany {
  id: string;
  name: string;
  domain: string;
  careersUrl: string;
  atsKind: 'ats_greenhouse' | 'ats_lever' | 'ats_workday' | null;
  atsRef: string | null;
}

/** A mix of ats_kind values so the ATS and careers-page surfaces are actually exercised. */
export const DEMO_COMPANIES: readonly DemoCompany[] = [
  {
    id: '01a16262-25da-7993-b4a8-f461eccbb2df',
    name: 'Clinic-A Health',
    domain: 'clinic-a.example',
    careersUrl: 'https://clinic-a.example/careers',
    atsKind: 'ats_greenhouse',
    atsRef: 'clinic-a',
  },
  {
    id: '01a16262-25da-7993-b4a8-f4621c13cbfd',
    name: 'Northwind Analytics',
    domain: 'northwind-analytics.example',
    careersUrl: 'https://northwind-analytics.example/jobs',
    atsKind: 'ats_lever',
    atsRef: 'northwind-analytics',
  },
  {
    id: '01a16262-25da-7993-b4a8-f463426c2423',
    name: 'Fourth Coffee Logistics',
    domain: 'fourthcoffee-logistics.example',
    careersUrl: 'https://fourthcoffee-logistics.example/careers',
    atsKind: 'ats_workday',
    atsRef: 'fourthcoffeelogistics',
  },
  {
    id: '01a16262-25da-7993-b4a8-f464263a7998',
    name: 'Contoso Robotics',
    domain: 'contoso-robotics.example',
    careersUrl: 'https://contoso-robotics.example/careers',
    atsKind: null,
    atsRef: null,
  },
] as const;

export interface DemoOpportunity {
  id: string;
  companyId: string;
  title: string;
  descriptionMd: string;
  location: string;
  remote: boolean;
  compNote: string | null;
  stage:
    | 'discovered'
    | 'interested'
    | 'preparing'
    | 'applied'
    | 'in_process'
    | 'offer'
    | 'dismissed'
    | 'closed';
  dismissedReason?: 'stale';
  closedReason?: 'accepted';
  possibleDuplicateOf?: string;
  postingState?: 'needs_review';
  postingStateDetail?: 'ambiguous';
  /** Each stage this opportunity passed through, oldest first, as an offset from seed time. */
  stageHistory: { stage: DemoOpportunity['stage'] | 'discovered'; offsetMs: number }[];
}

const JOB_DESC = (role: string, company: string) =>
  `## About the role\n\n${company} is hiring a ${role}. You will own problems end to end, ` +
  `from design through rollout, working closely with product and design.\n\n` +
  `## What you will do\n\n- Design and ship features used by thousands of customers daily\n` +
  `- Partner with product and design on roadmap\n- Mentor other engineers on the team\n\n` +
  `## What we are looking for\n\n- Several years of relevant experience\n- Strong written ` +
  `and verbal communication\n- Comfort with ambiguity`;

export const DEMO_OPPORTUNITIES: readonly DemoOpportunity[] = [
  {
    id: '01a16262-25da-7993-b4a8-f4657997972a',
    companyId: DEMO_COMPANIES[0]!.id,
    title: 'Senior Platform Engineer',
    descriptionMd: JOB_DESC('Senior Platform Engineer', 'Clinic-A Health'),
    location: 'Remote (US)',
    remote: true,
    compNote: '$170k-$200k',
    stage: 'discovered',
    stageHistory: [{ stage: 'discovered', offsetMs: -2 * DAY }],
  },
  {
    id: '01a16262-25da-7993-b4a8-f46686370791',
    companyId: DEMO_COMPANIES[1]!.id,
    title: 'Staff Software Engineer, Data',
    descriptionMd: JOB_DESC('Staff Software Engineer, Data', 'Northwind Analytics'),
    location: 'Austin, TX',
    remote: false,
    compNote: null,
    stage: 'interested',
    stageHistory: [
      { stage: 'discovered', offsetMs: -14 * DAY },
      { stage: 'interested', offsetMs: -12 * DAY },
    ],
  },
  {
    id: '01a16262-25da-7993-b4a8-f467ed3f334e',
    companyId: DEMO_COMPANIES[2]!.id,
    title: 'Engineering Manager, Logistics',
    descriptionMd: JOB_DESC('Engineering Manager, Logistics', 'Fourth Coffee Logistics'),
    location: 'Remote (US)',
    remote: true,
    compNote: '$190k-$220k + equity',
    stage: 'preparing',
    stageHistory: [
      { stage: 'discovered', offsetMs: -16 * DAY },
      { stage: 'interested', offsetMs: -15 * DAY },
      { stage: 'preparing', offsetMs: -10 * DAY },
    ],
  },
  {
    id: '01a16262-25da-7993-b4a8-f468401e5c9d',
    companyId: DEMO_COMPANIES[3]!.id,
    title: 'Senior Backend Engineer',
    descriptionMd: JOB_DESC('Senior Backend Engineer', 'Contoso Robotics'),
    location: 'Seattle, WA',
    remote: false,
    compNote: '$180k-$210k',
    stage: 'applied',
    stageHistory: [
      { stage: 'discovered', offsetMs: -20 * DAY },
      { stage: 'interested', offsetMs: -19 * DAY },
      { stage: 'preparing', offsetMs: -16 * DAY },
      { stage: 'applied', offsetMs: -9 * DAY },
    ],
  },
  {
    id: '01a16262-25da-7993-b4a8-f46935645ee7',
    companyId: DEMO_COMPANIES[0]!.id,
    title: 'Engineering Lead, Platform',
    descriptionMd: JOB_DESC('Engineering Lead, Platform', 'Clinic-A Health'),
    location: 'Remote (US)',
    remote: true,
    compNote: '$200k-$230k',
    stage: 'in_process',
    stageHistory: [
      { stage: 'discovered', offsetMs: -25 * DAY },
      { stage: 'interested', offsetMs: -24 * DAY },
      { stage: 'preparing', offsetMs: -22 * DAY },
      { stage: 'applied', offsetMs: -18 * DAY },
      { stage: 'in_process', offsetMs: -6 * DAY },
    ],
  },
  {
    id: '01a16262-25da-7993-b4a8-f46adf0ee997',
    companyId: DEMO_COMPANIES[1]!.id,
    title: 'Principal Engineer',
    descriptionMd: JOB_DESC('Principal Engineer', 'Northwind Analytics'),
    location: 'Remote (US)',
    remote: true,
    compNote: '$230k-$260k + equity',
    stage: 'offer',
    stageHistory: [
      { stage: 'discovered', offsetMs: -35 * DAY },
      { stage: 'interested', offsetMs: -34 * DAY },
      { stage: 'preparing', offsetMs: -31 * DAY },
      { stage: 'applied', offsetMs: -27 * DAY },
      { stage: 'in_process', offsetMs: -17 * DAY },
      { stage: 'offer', offsetMs: -3 * DAY },
    ],
  },
  {
    id: '01a16262-25da-7993-b4a8-f46bc4356986',
    companyId: DEMO_COMPANIES[2]!.id,
    title: 'Software Engineer, Warehouse Systems',
    descriptionMd: JOB_DESC('Software Engineer, Warehouse Systems', 'Fourth Coffee Logistics'),
    location: 'Remote (US)',
    remote: true,
    compNote: null,
    stage: 'dismissed',
    dismissedReason: 'stale',
    stageHistory: [
      { stage: 'discovered', offsetMs: -40 * DAY },
      { stage: 'interested', offsetMs: -38 * DAY },
      { stage: 'dismissed', offsetMs: -20 * DAY },
    ],
  },
  {
    id: '01a16262-25da-7993-b4a8-f46c60862ed3',
    companyId: DEMO_COMPANIES[3]!.id,
    title: 'Staff Engineer, Robotics Platform',
    descriptionMd: JOB_DESC('Staff Engineer, Robotics Platform', 'Contoso Robotics'),
    location: 'Seattle, WA',
    remote: false,
    compNote: '$210k-$240k',
    stage: 'closed',
    closedReason: 'accepted',
    stageHistory: [
      { stage: 'discovered', offsetMs: -60 * DAY },
      { stage: 'interested', offsetMs: -58 * DAY },
      { stage: 'preparing', offsetMs: -55 * DAY },
      { stage: 'applied', offsetMs: -50 * DAY },
      { stage: 'in_process', offsetMs: -40 * DAY },
      { stage: 'offer', offsetMs: -25 * DAY },
      { stage: 'closed', offsetMs: -22 * DAY },
    ],
  },
  // A possible-duplicate pair (#9): the same posting, discovered twice. The second carries
  // possibleDuplicateOf rather than its own dedupeKey (claimDedupeKey's own rule: only one
  // live row per (user, dedupeKey) holds the key; an override keeps the key null).
  {
    id: '01a16262-25da-7993-b4a8-f46df357a800',
    companyId: DEMO_COMPANIES[1]!.id,
    title: 'Product Engineer',
    descriptionMd: JOB_DESC('Product Engineer', 'Northwind Analytics'),
    location: 'Austin, TX',
    remote: false,
    compNote: null,
    stage: 'discovered',
    stageHistory: [{ stage: 'discovered', offsetMs: -5 * DAY }],
  },
  {
    id: '01a16262-25da-7993-b4a8-f46e320e780a',
    companyId: DEMO_COMPANIES[1]!.id,
    title: 'Product Engineer',
    descriptionMd: JOB_DESC('Product Engineer', 'Northwind Analytics'),
    location: 'Austin, TX',
    remote: false,
    compNote: null,
    stage: 'discovered',
    possibleDuplicateOf: '01a16262-25da-7993-b4a8-f46df357a800',
    stageHistory: [{ stage: 'discovered', offsetMs: -4 * DAY }],
  },
  // An unconfirmed posting (#11): the board search never confirmed which req this is.
  {
    id: '01a16262-25da-7993-b4a8-f46f070bfb2a',
    companyId: DEMO_COMPANIES[0]!.id,
    title: 'Backend Engineer, Patient Systems',
    descriptionMd: JOB_DESC('Backend Engineer, Patient Systems', 'Clinic-A Health'),
    location: 'Remote (US)',
    remote: true,
    compNote: null,
    stage: 'preparing',
    postingState: 'needs_review',
    postingStateDetail: 'ambiguous',
    stageHistory: [
      { stage: 'discovered', offsetMs: -7 * DAY },
      { stage: 'interested', offsetMs: -6 * DAY },
      { stage: 'preparing', offsetMs: -3 * DAY },
    ],
  },
] as const;

export interface DemoCommunication {
  id: string;
  opportunityId: string | null;
  from: string;
  subject: string;
  snippet: string;
  classification: 'solicitation' | 'scheduling' | 'rejection';
  /** With confidence and opportunityId, what needsReviewFor (repos/communications.ts) needs
   *  to compute needsReview the same way the real classify-and-save path does, rather than
   *  seedDemo.ts hardcoding it (#280 acceptance: an unlinked row seeded with needsReview
   *  left at its schema default, false, was invisible in every inbox tab). */
  outreachKind: 'targeted';
  confidence: number;
  offsetMs: number;
}

/** snippet only, bodyRef stays null (issue #219): postingSearch and alertEmail both fall
 *  back to snippet for a body-less message, so this is the only text those surfaces have. */
export const DEMO_COMMUNICATIONS: readonly DemoCommunication[] = [
  {
    id: '01a16262-25da-7993-b4a8-f470c0b40d3f',
    opportunityId: null,
    from: 'recruiting@talent-partners.example',
    subject: 'Senior Platform roles at a healthtech client',
    snippet:
      "Hi, I'm working with a healthtech company on a Senior Platform Engineer search, fully " +
      'remote, and your background looks like a strong match. Open to a quick call this week?',
    classification: 'solicitation',
    outreachKind: 'targeted',
    confidence: 0.9,
    offsetMs: -9 * DAY,
  },
  {
    id: '01a16262-25da-7993-b4a8-f4713f817334',
    opportunityId: DEMO_OPPORTUNITIES[4]!.id,
    from: 'recruiting@clinic-a.example',
    subject: 'Next steps: Engineering Lead, Platform',
    snippet:
      "Thanks for the great conversation yesterday. We'd like to move forward with a " +
      'technical interview. Are you available Tuesday or Wednesday next week?',
    classification: 'scheduling',
    outreachKind: 'targeted',
    confidence: 0.95,
    offsetMs: -6 * DAY,
  },
  {
    id: '01a16262-25da-7993-b4a8-f472402c4516',
    opportunityId: DEMO_OPPORTUNITIES[6]!.id,
    from: 'recruiting@fourthcoffee-logistics.example',
    subject: 'Update on your application',
    snippet:
      "Thank you for your interest in the Warehouse Systems role. We've decided to move " +
      'forward with other candidates whose experience more closely matches our current needs.',
    classification: 'rejection',
    outreachKind: 'targeted',
    confidence: 0.95,
    offsetMs: -20 * DAY,
  },
] as const;

export interface DemoActivity {
  id: string;
  opportunityId: string;
  kind: 'note' | 'meeting' | 'interview' | 'application';
  title: string;
  bodyMd: string | null;
  offsetMs: number;
}

export const DEMO_ACTIVITIES: readonly DemoActivity[] = [
  {
    id: '01a16262-25da-7993-b4a8-f4740e2acae6',
    opportunityId: DEMO_OPPORTUNITIES[3]!.id,
    kind: 'application',
    title: 'Applied via careers page',
    bodyMd: 'Submitted the standard application form along with the tailored resume.',
    offsetMs: -9 * DAY,
  },
  {
    id: '01a16262-25da-7993-b4a8-f475e54e7dbf',
    opportunityId: DEMO_OPPORTUNITIES[4]!.id,
    kind: 'interview',
    title: 'Hiring manager screen',
    bodyMd:
      'Went well. Discussed the platform migration project and on-call philosophy. Next step ' +
      'is a technical interview.',
    offsetMs: -6 * DAY,
  },
  {
    id: '01a16262-25da-7993-b4a8-f47624b09407',
    opportunityId: DEMO_OPPORTUNITIES[5]!.id,
    kind: 'meeting',
    title: 'Offer call',
    bodyMd: 'Verbal offer extended. Written offer to follow within the week.',
    offsetMs: -3 * DAY,
  },
] as const;

export interface DemoNextStep {
  id: string;
  opportunityId: string;
  action: string;
  dueOffsetMs: number;
}

export const DEMO_NEXT_STEPS: readonly DemoNextStep[] = [
  {
    id: '01a16262-25da-7993-b4a8-f47dad35e06',
    opportunityId: DEMO_OPPORTUNITIES[4]!.id,
    action: 'Prepare for technical interview',
    dueOffsetMs: 2 * DAY,
  },
  {
    id: '01a16262-25da-7993-b4a8-f478ea30a0e0',
    opportunityId: DEMO_OPPORTUNITIES[5]!.id,
    action: 'Review written offer and respond',
    dueOffsetMs: 3 * DAY,
  },
] as const;

// ---------------------------------------------------------------------------
// Resumes (local_file, #284) and match reports.

export const DEMO_RESUME_BASE_ID = 'da834374-13f5-4080-934e-f77f91b99819';
export const DEMO_RESUME_BASE_TITLE = 'Avery Chen - Resume';

/** One invented candidate, shared across every copy of the fixture: the demo's five accounts
 *  are five independent operators of the same story, not five different candidates. */
/** The base resume's Summary paragraph, pulled out so seedDemo.ts can swap it for a tailored
 *  one by exact string replacement rather than rebuilding the whole document line by line. */
export const DEMO_RESUME_BASE_SUMMARY =
  'Backend-focused engineer with 8 years building and operating distributed systems, platform ' +
  'tooling and developer-facing APIs. Comfortable owning a project from design through ' +
  'production, and partnering closely with product on roadmap.';

export const DEMO_RESUME_BASE_TEXT = [
  'Avery Chen',
  'Senior Software Engineer',
  'avery.chen@opportun-demo.example | Remote (US)',
  '',
  'Summary',
  DEMO_RESUME_BASE_SUMMARY,
  '',
  'Experience',
  'Lead Engineer, Platform Team, Meridian Systems (2021-Present)',
  '- Led the migration of the core billing service from a monolith to Go microservices, ' +
    'cutting p99 latency by 40 percent',
  '- Built the internal deployment platform now used by 30+ engineering teams',
  '- Mentored four engineers through promotion to senior',
  '',
  'Senior Software Engineer, Vantage Cloud (2018-2021)',
  '- Designed and shipped the multi-region failover system for the primary data store',
  '- Partnered with product and design on the public API roadmap',
  '- On-call lead for the payments team',
  '',
  'Software Engineer, Early-Stage Startups (2015-2018)',
  '- Built the first version of the customer-facing analytics dashboard',
  '- Wrote the original Kubernetes deployment tooling still in use today',
  '',
  'Skills',
  'Go, Python, TypeScript, Kubernetes, Terraform, PostgreSQL, distributed systems, API design, ' +
    'mentoring',
  '',
  'Education',
  'B.S. Computer Science, State University',
].join('\n');

export interface DemoTailoredResume {
  id: string;
  opportunityId: string;
  title: string;
  /** Replaces the base resume's Summary paragraph; everything else is identical to the base. */
  summary: string;
  status: 'final' | 'submitted';
  /** Only meaningful when status is 'submitted'. */
  submittedTo?: string;
  /** Offset for createdAt/updatedAt (and submittedAt, when submitted): when this variant was
   *  prepared, a little before the opportunity's own 'preparing' or 'applied' stage change. */
  preparedOffsetMs: number;
}

/** A tailored variant only for opportunities at 'preparing' or later (DEMO_OPPORTUNITIES[2,
 *  3, 4, 5, 7]): the ones a real candidate would actually have built a resume for. */
export const DEMO_TAILORED_RESUMES: readonly DemoTailoredResume[] = [
  {
    id: '7a15a56a-0f5e-4d1b-bf44-91adf1ce0688',
    opportunityId: DEMO_OPPORTUNITIES[2]!.id, // Engineering Manager, Logistics -- preparing
    title: 'Avery Chen - Fourth Coffee Logistics',
    summary:
      'Backend-focused engineer with 8 years building and operating distributed systems, now ' +
      'looking to bring that platform experience to leading the engineering team behind Fourth ' +
      'Coffee Logistics’ warehouse and routing systems.',
    status: 'final',
    preparedOffsetMs: -11 * DAY,
  },
  {
    id: '15bbb782-9781-478c-9ef6-79e1dec3cb6a',
    opportunityId: DEMO_OPPORTUNITIES[3]!.id, // Senior Backend Engineer -- applied
    title: 'Avery Chen - Contoso Robotics',
    summary:
      'Backend-focused engineer with 8 years building and operating distributed systems and ' +
      'developer-facing APIs, excited to bring that same rigor to the backend services behind ' +
      'Contoso Robotics’ fleet platform.',
    status: 'submitted',
    submittedTo: 'Contoso Robotics careers page',
    preparedOffsetMs: -17 * DAY,
  },
  {
    id: '95fa485c-6c72-48e5-a8f0-8a50d86849d4',
    opportunityId: DEMO_OPPORTUNITIES[4]!.id, // Engineering Lead, Platform -- in_process
    title: 'Avery Chen - Clinic-A Health',
    summary:
      'Backend-focused engineer with 8 years building and operating distributed systems, ' +
      'including leading a platform team through a major migration, looking to lead the ' +
      'platform engineering effort behind Clinic-A Health’s patient systems.',
    status: 'submitted',
    submittedTo: 'Clinic-A Health careers page',
    preparedOffsetMs: -23 * DAY,
  },
  {
    id: 'd66c9026-e049-4b16-8e7b-7ec117fdb13a',
    opportunityId: DEMO_OPPORTUNITIES[5]!.id, // Principal Engineer -- offer
    title: 'Avery Chen - Northwind Analytics',
    summary:
      'Backend-focused engineer with 8 years building and operating distributed systems at ' +
      'increasing scope, ready for a principal-level role shaping Northwind Analytics’ ' +
      'data platform architecture.',
    status: 'submitted',
    submittedTo: 'Northwind Analytics careers page',
    preparedOffsetMs: -32 * DAY,
  },
  {
    id: 'c108e7fd-3e3f-4946-8c9f-cc4a6065b266',
    opportunityId: DEMO_OPPORTUNITIES[7]!.id, // Staff Engineer, Robotics Platform -- closed/accepted
    title: 'Avery Chen - Contoso Robotics (Staff)',
    summary:
      'Backend-focused engineer with 8 years building and operating distributed systems, ' +
      'bringing platform and deployment-tooling experience to a staff-level role on Contoso ' +
      'Robotics’ robotics platform team.',
    status: 'submitted',
    submittedTo: 'Contoso Robotics careers page',
    preparedOffsetMs: -56 * DAY,
  },
] as const;

export interface DemoMatchReport {
  /** The tailored resume this report is for; same (resumeId, opportunityId) pair. */
  resumeId: string;
  opportunityId: string;
  score: number;
  missingKeywords: string[];
  weakAreas: { area: string; suggestion: string }[];
  summary: string;
  /** A little after the resume was prepared: the score reflects that version of the resume. */
  scoredOffsetMs: number;
}

/** One report per DEMO_TAILORED_RESUMES entry, same order. */
export const DEMO_MATCH_REPORTS: readonly DemoMatchReport[] = [
  {
    resumeId: DEMO_TAILORED_RESUMES[0]!.id,
    opportunityId: DEMO_TAILORED_RESUMES[0]!.opportunityId,
    score: 74,
    missingKeywords: ['people management', 'logistics'],
    weakAreas: [
      {
        area: 'People management',
        suggestion:
          'The role leads a team; call out the four engineers mentored more directly as management experience.',
      },
    ],
    summary: 'Strong technical fit; the role wants more direct people-management evidence.',
    scoredOffsetMs: -11 * DAY + 2 * 60 * 60 * 1000,
  },
  {
    resumeId: DEMO_TAILORED_RESUMES[1]!.id,
    opportunityId: DEMO_TAILORED_RESUMES[1]!.opportunityId,
    score: 88,
    missingKeywords: ['robotics'],
    weakAreas: [],
    summary: 'Strong match on backend systems experience; no notable gaps for this posting.',
    scoredOffsetMs: -17 * DAY + 2 * 60 * 60 * 1000,
  },
  {
    resumeId: DEMO_TAILORED_RESUMES[2]!.id,
    opportunityId: DEMO_TAILORED_RESUMES[2]!.opportunityId,
    score: 91,
    missingKeywords: [],
    weakAreas: [],
    summary:
      'Excellent match: the platform migration and mentoring experience map directly onto this role.',
    scoredOffsetMs: -23 * DAY + 2 * 60 * 60 * 1000,
  },
  {
    resumeId: DEMO_TAILORED_RESUMES[3]!.id,
    opportunityId: DEMO_TAILORED_RESUMES[3]!.opportunityId,
    score: 85,
    missingKeywords: ['data platform'],
    weakAreas: [
      {
        area: 'Data platform depth',
        suggestion: 'Add a bullet naming a specific data-platform project if one exists.',
      },
    ],
    summary:
      'Strong senior-level match; a named data-platform project would strengthen it further.',
    scoredOffsetMs: -32 * DAY + 2 * 60 * 60 * 1000,
  },
  {
    resumeId: DEMO_TAILORED_RESUMES[4]!.id,
    opportunityId: DEMO_TAILORED_RESUMES[4]!.opportunityId,
    score: 89,
    missingKeywords: [],
    weakAreas: [],
    summary: 'Strong staff-level match; the deployment-tooling background fits this team well.',
    scoredOffsetMs: -56 * DAY + 2 * 60 * 60 * 1000,
  },
] as const;
