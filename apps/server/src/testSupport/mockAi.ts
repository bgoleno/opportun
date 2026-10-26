// End-to-end AI mock (OPPORTUN_AI_MOCK=1). A canned OpenAI-compatible chat endpoint served by
// this same process on loopback, plus an AiOverride that points every task at it. Calls still
// go through the real router, the AI SDK's openai-compatible client, prompt rendering, the
// budget check and the task_runs ledger: only the model is fake. Never enabled in production
// (see testSupport/index.ts).
import type { ModelPolicy, TaskKey } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiOverride } from '../lib/ai';

export const MOCK_AI_PATH = '/__mock/ai/v1';
const MODEL_PREFIX = 'mock-';
const MOCK_KEY = 'mock-key';

/** Every task goes to the loopback mock; the model name carries the task key. */
export function mockAiOverride(port: number): AiOverride {
  return {
    policyFor(task: TaskKey): ModelPolicy {
      return {
        provider: 'openai_compatible',
        model: `${MODEL_PREFIX}${task}`,
        baseUrl: `http://127.0.0.1:${port}${MOCK_AI_PATH}`,
        maxOutputTokens: 2048,
      };
    },
    getKey: () => MOCK_KEY,
  };
}

// ---------------------------------------------------------------------------
// Canned answers. Fixture text lives in mockGoogle.ts (mail) and mockDocs.ts (resume).

/** The resume line the tailoring reply proposes to change (present in the mock document). */
export const TAILOR_FIND = 'Built the billing platform in Go';
export const TAILOR_REPLACE = 'Built the Go billing platform on Kubernetes';

const TAILOR_REPLY = [
  'Your Go platform work maps well to this role. ',
  'Here is one change that mirrors the posting.\n\n```json\n',
  JSON.stringify({
    edits: [
      {
        find: TAILOR_FIND,
        replace: TAILOR_REPLACE,
        rationale: 'The posting asks for Kubernetes experience.',
      },
    ],
  }),
  '\n```',
];

export const MATCH_REPORT = {
  score: 82,
  missingKeywords: ['Terraform', 'On-call leadership'],
  weakAreas: [
    {
      area: 'Infrastructure as code',
      suggestion: 'Name the provisioning tools you used for the billing platform.',
    },
  ],
  summary: 'Strong backend and platform match; infrastructure tooling is the main gap.',
};

const NONE = {
  classification: 'other',
  outreachKind: null,
  mismatchReason: null,
  opportunityMatch: null,
  proposedTransition: null,
  confidence: 0.9,
  hardConstraintViolation: null,
};

/** Classification by the message's Subject line (the fixtures in mockGoogle.ts). */
const CLASSIFY_RULES: { subject: RegExp; output: Record<string, unknown> }[] = [
  {
    subject: /Staff Platform Engineer/i,
    output: {
      classification: 'solicitation',
      outreachKind: 'targeted',
      mismatchReason: null,
      opportunityMatch: { company: 'Northwind Labs', title: 'Staff Platform Engineer' },
      proposedTransition: null,
      confidence: 0.92,
      hardConstraintViolation: null,
    },
  },
  {
    subject: /hot remote jobs/i,
    output: {
      classification: 'solicitation',
      outreachKind: 'broadcast_spam',
      mismatchReason: null,
      opportunityMatch: null,
      proposedTransition: null,
      confidence: 0.95,
      hardConstraintViolation: null,
    },
  },
  {
    subject: /Interview availability/i,
    output: {
      classification: 'scheduling',
      outreachKind: null,
      mismatchReason: null,
      opportunityMatch: { company: 'Contoso', title: 'Senior Product Manager' },
      proposedTransition: 'in_process',
      confidence: 0.9,
      hardConstraintViolation: null,
    },
  },
];

/** discovery.rank scores by the posting's title (the source fixtures in mockSources.ts). */
const RANK_RULES: { title: RegExp; score: number; rationale: string }[] = [
  { title: /Staff Platform Engineer/i, score: 92, rationale: 'Strong platform match.' },
  { title: /Office Coordinator/i, score: 18, rationale: 'Not an engineering role.' },
];

function rank(promptText: string): Record<string, unknown> {
  // The posting is rendered as "Title: ..." inside its untrusted fence; take the last one.
  const titles = [...promptText.matchAll(/^Title: (.*)$/gm)].map((m) => m[1] ?? '');
  const title = titles.at(-1) ?? '';
  const rule = RANK_RULES.find((r) => r.title.test(title));
  return {
    score: rule?.score ?? 70,
    rationale: rule?.rationale ?? 'Mock answer.',
    disqualifiers: [],
  };
}

/** The one company company.suggest proposes (its board is a fixture in mockSources.ts). */
export const SUGGESTED_COMPANY = {
  name: 'Pied Piper',
  rationale: 'Builds developer platforms like the companies in your pipeline.',
  domainGuess: 'piedpiper.example',
};

function classify(promptText: string): Record<string, unknown> {
  // The message is rendered as "Subject: ..." inside its untrusted fence; open opportunities
  // are "- company | title | stage" lines, so they never match here.
  const subjects = [...promptText.matchAll(/^Subject: (.*)$/gm)].map((m) => m[1] ?? '');
  const subject = subjects.at(-1) ?? '';
  return CLASSIFY_RULES.find((r) => r.subject.test(subject))?.output ?? NONE;
}

/** A schema-valid answer for every structured task. */
function structured(task: string, promptText: string): Record<string, unknown> {
  switch (task) {
    case 'comms.classify':
      return classify(promptText);
    // Stage 1's gate, asked about every message the rules passed on a positive signal. It agrees
    // with the rules here: the mock mailbox is job mail, and a gate that dropped it would make
    // every end to end inbox expectation fail for a reason that had nothing to do with the test.
    // Without this case the answer is {}, which fails the schema and reaches the gate as
    // "unavailable", so the e2e run would exercise the fail-open path instead of the real one.
    case 'comms.triage':
      return { jobRelated: true, reason: 'Mock answer.', confidence: 0.9 };
    case 'resume.match':
      return MATCH_REPORT;
    case 'resume.tailor':
      return JSON.parse(TAILOR_REPLY[2] ?? '{}') as Record<string, unknown>;
    case 'discovery.refine_prompt':
      return { proposedPrompt: 'Mock refined prompt.', changeSummary: 'No change (mock).' };
    case 'discovery.rank':
      return rank(promptText);
    case 'opportunity.dedupe':
      return { duplicateOfRef: null, confidence: 0.5, reason: 'Mock answer.' };
    case 'referral.rationale': {
      // Ranks the candidates in the order sent (ids echoed from the contacts lines).
      const ids = [...promptText.matchAll(/^- id: (\S+) \|/gm)].map((m) => m[1] ?? '');
      return {
        ranked: ids
          .slice(0, 20)
          .map((contactId, i) => ({ contactId, rank: i + 1, rationale: 'Mock answer.' })),
      };
    }
    case 'capture.extract':
      return {
        companyName: null,
        title: null,
        location: null,
        remote: null,
        compNote: null,
        descriptionMd: null,
        postingUrl: null,
      };
    case 'capture.linkedin':
      // 'other' keeps the server's deterministic reading of the page.
      return {
        kind: 'other',
        name: null,
        headline: null,
        company: null,
        title: null,
        location: null,
        compNote: null,
        descriptionMd: null,
      };
    case 'company.suggest':
      return { suggestions: [SUGGESTED_COMPANY] };
    case 'integration.diagnose':
      return { explanation: 'Mock answer.', fix: 'Mock fix.' };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// The OpenAI-compatible wire format (chat completions), just enough for the AI SDK.

const ChatRequest = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('\n');
  }
  return '';
}

/** The mock answers only this process's own calls (IPv4, IPv6 and IPv4-mapped loopback). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const USAGE = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };

/** Registers the mock endpoint on the app (no session, outside /api, loopback callers only). */
export async function mockAiRoutes(app: FastifyInstance): Promise<void> {
  app.post(`${MOCK_AI_PATH}/chat/completions`, async (req, reply) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      return reply.code(403).send({ error: { message: 'loopback only' } });
    }
    const body = ChatRequest.parse(req.body);
    const task = body.model.startsWith(MODEL_PREFIX)
      ? body.model.slice(MODEL_PREFIX.length)
      : body.model;
    const promptText = body.messages.map((m) => messageText(m.content)).join('\n');
    const id = `chatcmpl-mock-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    if (body.stream === true) {
      // Chat (resume.tailor): the reply streams in a few deltas, then usage and [DONE].
      const deltas = task === 'resume.tailor' ? TAILOR_REPLY : ['Mock reply.'];
      const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: object) =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage === undefined ? {} : { usage }),
        })}\n\n`;
      const frames = [
        chunk({ role: 'assistant', content: '' }, null),
        ...deltas.map((d) => chunk({ content: d }, null)),
        chunk({}, 'stop', USAGE),
        'data: [DONE]\n\n',
      ];
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const frame of frames) reply.raw.write(frame);
      reply.raw.end();
      return reply;
    }

    return reply.send({
      id,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(structured(task, promptText)) },
          finish_reason: 'stop',
        },
      ],
      usage: USAGE,
    });
  });
}
