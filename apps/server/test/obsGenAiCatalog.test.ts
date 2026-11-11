// The Gen AI entries of the observability catalog (design.md 14.4, 14.5, 14.8;
// https://github.com/bgoleno/opportun/issues/344, FR-T4 part 2). The names come from
// @opportun/ai's telemetry.ts, the one file that holds them; the catalog gives each its type.
import {
  ATTR,
  FEATURES,
  FINISH_REASONS,
  GEN_AI_METRIC,
  KEY_CHECK_TASK,
  PROVIDERS,
  TASK_KEYS,
} from '@opportun/ai';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTES,
  ATTRIBUTE_TYPES,
  isLocalOnly,
  METRICS,
  OTHER,
  SPANS,
  WORKFLOWS,
} from '../src/obs/catalog';
import { checkValue } from '../src/obs/gate';

/** The content attributes of the conventions: never catalogued, so never stored or sent (14.5). */
const CONTENT_KEYS = [
  'gen_ai.input.messages',
  'gen_ai.input.messages_ref',
  'gen_ai.output.messages',
  'gen_ai.output.messages_ref',
  'gen_ai.system_instructions',
  'gen_ai.system_instructions_ref',
  'gen_ai.tool.definitions',
  'gen_ai.tool.definitions_ref',
  'gen_ai.prompt.variable',
];

/** What packages/ai's InferenceSpan may set (its own allowlist test pins the same list). */
const INFERENCE_KEYS = [
  ATTR.operationName,
  ATTR.providerName,
  ATTR.requestModel,
  ATTR.responseModel,
  ATTR.requestMaxTokens,
  ATTR.requestTemperature,
  ATTR.requestStream,
  ATTR.outputType,
  ATTR.promptName,
  ATTR.promptVersion,
  ATTR.usageInputTokens,
  ATTR.usageOutputTokens,
  ATTR.usageCacheReadInputTokens,
  ATTR.usageCacheWriteInputTokens,
  ATTR.responseId,
  ATTR.responseFinishReasons,
  ATTR.responseTimeToFirstChunk,
  ATTR.conversationId,
  ATTR.errorType,
  ATTR.userId,
  ATTR.aiProvider,
  ATTR.aiTask,
  ATTR.aiFeature,
  ATTR.aiPromptId,
  ATTR.aiAttempts,
  ATTR.usageCost,
];

const typeOf = (key: string) => {
  const type = ATTRIBUTE_TYPES.get(key);
  if (type === undefined) throw new Error(`not catalogued: ${key}`);
  return type;
};

describe('the inference span in the catalog (#344)', () => {
  it('lists every key the router sets, and each key is catalogued', () => {
    expect([...SPANS['gen_ai.inference'].attributes].sort()).toEqual([...INFERENCE_KEYS].sort());
    for (const key of INFERENCE_KEYS) expect(ATTRIBUTE_TYPES.has(key), key).toBe(true);
    expect(SPANS['gen_ai.inference']).toMatchObject({
      template: 'chat {gen_ai.request.model}',
      kind: 'client',
    });
  });

  it('catalogues no content attribute of the conventions, on any record', () => {
    for (const key of CONTENT_KEYS) expect(Object.keys(ATTRIBUTES), key).not.toContain(key);
  });

  it('keeps the user, the conversation, the prompt row and the response id local (14.5, 14.8)', () => {
    for (const key of [ATTR.userId, ATTR.conversationId, ATTR.aiPromptId, ATTR.responseId]) {
      expect(isLocalOnly(key as keyof typeof ATTRIBUTES), key).toBe(true);
    }
    // What export may send: everything else on the span that is not an id.
    for (const key of [ATTR.aiTask, ATTR.requestModel, ATTR.usageInputTokens, ATTR.errorType]) {
      expect(isLocalOnly(key as keyof typeof ATTRIBUTES), key).toBe(false);
    }
  });

  it('types each value narrowly: closed lists from @opportun/ai, models, codes and numbers', () => {
    expect(checkValue(typeOf(ATTR.aiTask), 'resume.tailor')).toBe('resume.tailor');
    expect(checkValue(typeOf(ATTR.aiTask), KEY_CHECK_TASK)).toBe(KEY_CHECK_TASK);
    expect(checkValue(typeOf(ATTR.aiTask), 'Jane Doe')).toBeUndefined();
    for (const t of TASK_KEYS) expect(checkValue(typeOf(ATTR.promptName), t), t).toBe(t);
    for (const f of FEATURES) expect(checkValue(typeOf(ATTR.aiFeature), f.key), f.key).toBe(f.key);
    for (const p of PROVIDERS) expect(checkValue(typeOf(ATTR.aiProvider), p), p).toBe(p);
    expect(checkValue(typeOf(ATTR.providerName), 'openai_compatible')).toBeUndefined();
    expect(checkValue(typeOf(ATTR.responseFinishReasons), [...FINISH_REASONS])).toEqual([
      ...FINISH_REASONS,
    ]);
    expect(checkValue(typeOf(ATTR.responseFinishReasons), ['end_turn'])).toBeUndefined();
    expect(checkValue(typeOf(ATTR.requestModel), 'my-org/llama-3.1:70b')).toBe(
      'my-org/llama-3.1:70b',
    );
    expect(checkValue(typeOf(ATTR.requestModel), '/srv/models/private')).toBe(OTHER);
    expect(checkValue(typeOf(ATTR.responseId), 'msg_01AbC')).toBe('msg_01AbC');
    expect(checkValue(typeOf(ATTR.responseId), 'jane.doe@example.com')).toBeUndefined();
    expect(checkValue(typeOf(ATTR.conversationId), 'session-7')).toBeUndefined();
    expect(checkValue(typeOf(ATTR.usageInputTokens), 12.5)).toBeUndefined();
    expect(checkValue(typeOf(ATTR.usageCost), 0.0125)).toBe(0.0125);
  });
});

describe('the workflow span in the catalog (#344)', () => {
  it('is invoke_workflow {name} over the six workflows of 14.5', () => {
    expect(SPANS['gen_ai.workflow']).toMatchObject({
      template: 'invoke_workflow {gen_ai.agent.name}',
      kind: 'internal',
    });
    expect([...WORKFLOWS].sort()).toEqual([
      'capture',
      'company_tags',
      'discovery_run',
      'mail_sync',
      'rank_backlog',
      'tailoring_chat',
    ]);
    expect(checkValue(typeOf(ATTR.agentName), 'mail_sync')).toBe('mail_sync');
    expect(checkValue(typeOf(ATTR.agentName), 'my agent')).toBeUndefined();
    expect(checkValue(typeOf(ATTR.operationName), 'invoke_workflow')).toBe('invoke_workflow');
    expect(checkValue(typeOf(ATTR.operationName), 'execute_tool')).toBeUndefined();
  });
});

describe('the Gen AI metrics in the catalog (#344, 14.4)', () => {
  const base = [
    ATTR.operationName,
    ATTR.providerName,
    ATTR.requestModel,
    ATTR.aiTask,
    ATTR.aiFeature,
    ATTR.aiProvider,
  ];

  it('are the user-scoped metrics of 14.4, with the attributes it lists', () => {
    expect(METRICS[GEN_AI_METRIC.inferenceDuration]).toMatchObject({
      instrument: 'histogram',
      unit: 's',
      scope: 'user',
    });
    expect([...METRICS[GEN_AI_METRIC.inferenceDuration].attributes].sort()).toEqual(
      [...base, ATTR.errorType].sort(),
    );
    for (const m of [GEN_AI_METRIC.inputTokens, GEN_AI_METRIC.outputTokens]) {
      expect(METRICS[m], m).toMatchObject({
        instrument: 'counter',
        unit: '{token}',
        scope: 'user',
      });
      expect([...METRICS[m].attributes].sort(), m).toEqual([...base, ATTR.tokenModality].sort());
    }
    expect(METRICS[GEN_AI_METRIC.cost]).toMatchObject({
      instrument: 'counter',
      unit: '{USD}',
      scope: 'user',
    });
    expect([...METRICS[GEN_AI_METRIC.cost].attributes].sort()).toEqual(
      [...base, ATTR.costEstimated].sort(),
    );
    expect(checkValue(typeOf(ATTR.tokenModality), 'text')).toBe('text');
    expect(checkValue(typeOf(ATTR.tokenModality), 'image')).toBeUndefined();
  });
});
