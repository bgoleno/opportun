// Workflow spans (design.md 14.5, 14.6; https://github.com/bgoleno/opportun/issues/344, FR-T4
// part 2). Where one user action leads to several AI calls, an `invoke_workflow {name}` span
// holds them in one trace: the six workflows of the table in 14.5, each started where that table
// says. Opportun's own code decides the control flow, so these are workflows, not agents.
//
// workflow() also puts its user in the context, so the router's inference spans for that user
// are its children (packages/ai starts a new trace for a call whose user is not the context's).
//
// continuesTrace() is what a workflow's enqueue passes as `continueTrace` (14.6): true only
// inside a span the local store keeps, which is a workflow span, a span under one, or the span of
// a job that already continues one. So an enqueue that some other path shares (a classify queued
// by a route, not by the mail sync) starts its job's own trace, and nothing but a workflow's own
// continuation crosses the job queue.
//
// With collection off each returns after one check (14.11).
import { ATTR, OPERATION_INVOKE_WORKFLOW, withUser } from '@opportun/ai';
import { trace } from '@opentelemetry/api';
import type { Workflow } from './catalog';
import { isCollecting, obs } from './index';

/** Set by obs/tracing.ts once the span store runs: whether it keeps the span with this id. */
let keptCheck: (spanId: string) => boolean = () => false;

export function setKeptCheck(check: (spanId: string) => boolean): void {
  keptCheck = check;
}

export interface WorkflowOptions {
  /** The user the action is for: the workflow's trace is theirs (14.6, 14.7). */
  userId: string;
  /** The tailoring session id, for `tailoring_chat` only. Never made up. */
  conversationId?: string;
}

/** Runs `fn` inside the `invoke_workflow {name}` span of one user action. */
export async function workflow<T>(
  name: Workflow,
  opts: WorkflowOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isCollecting()) return fn();
  return withUser(opts.userId, () =>
    obs.span(
      'gen_ai.workflow',
      {
        [ATTR.operationName]: OPERATION_INVOKE_WORKFLOW,
        [ATTR.agentName]: name,
        [ATTR.userId]: opts.userId,
        ...(opts.conversationId === undefined
          ? {}
          : { [ATTR.conversationId]: opts.conversationId }),
      },
      () => fn(),
    ),
  );
}

/** Whether an enqueue made here continues a workflow's trace: see the header. */
export function continuesTrace(): boolean {
  if (!isCollecting()) return false;
  const active = trace.getActiveSpan();
  return active !== undefined && keptCheck(active.spanContext().spanId);
}
