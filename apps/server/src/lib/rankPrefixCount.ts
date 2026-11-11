// Sizing discovery.rank's cacheable prefix (https://github.com/bgoleno/opportun/issues/388).
// scripts/countRankPrefix.ts captures the Messages request the router builds for a rank call and
// asks Anthropic's token counter about it. These are the parts it can test without a key.

/** A count_tokens request body. */
export type CountBody = Record<string, unknown>;

/**
 * Request fields that render before the system prompt (the provider renders tools, then system,
 * then messages) or that add text there (output_config.format: the structured-output schema).
 * count_tokens takes each of them. Tools are in the cacheable prefix by the documented render
 * order. The schema is assumed to be: Anthropic documents only that it adds a system prompt
 * explaining the output format, not where that sits against the breakpoint. The script's
 * discovery.company_tags control, against a cache write measured live, settles it
 * (https://github.com/bgoleno/opportun/issues/388).
 */
function leadingFields(captured: Record<string, unknown>): CountBody {
  const { tools, tool_choice, output_config } = captured;
  return {
    ...(tools === undefined ? {} : { tools }),
    ...(tool_choice === undefined ? {} : { tool_choice }),
    ...(output_config === undefined ? {} : { output_config }),
  };
}

/** One character of user message: count_tokens needs a message, and every body has the same one. */
const PROBE_MESSAGES = [{ role: 'user', content: '.' }];

/**
 * Three count_tokens bodies for one call. `prefix` minus `baseline` is the system prefix alone;
 * `prefixWithSchema` minus `baseline` adds the structured-output schema. The two bound what the
 * provider caches at the breakpoint (the schema's place is assumed; see above). Only the prefix goes: the posting and
 * the rest of the call are never sent.
 */
export function prefixCountBodies(
  captured: Record<string, unknown>,
  prefix: string,
): { baseline: CountBody; prefix: CountBody; prefixWithSchema: CountBody } {
  const model = captured['model'];
  if (typeof model !== 'string' || model === '') {
    throw new Error('The captured request names no model.');
  }
  const baseline: CountBody = { model, messages: PROBE_MESSAGES };
  const withPrefix: CountBody = { ...baseline, system: [{ type: 'text', text: prefix }] };
  return {
    baseline,
    prefix: withPrefix,
    prefixWithSchema: { ...withPrefix, ...leadingFields(captured) },
  };
}

const SECTION = '\n\n## ';

/**
 * The template with its "## Output" section moved to just before its "## Posting" section, so
 * the output instructions, which are the same for every call, join the cacheable prefix. Every
 * section keeps its text; a template already in that order, or without both sections, comes back
 * unchanged.
 */
export function outputBeforePosting(template: string): string {
  const parts = template.split(SECTION);
  const output = parts.findIndex((p, i) => i > 0 && p.startsWith('Output\n'));
  const posting = parts.findIndex((p, i) => i > 0 && p.startsWith('Posting\n'));
  if (output === -1 || posting === -1 || output < posting) return template;
  const [section] = parts.splice(output, 1);
  parts.splice(posting, 0, section as string);
  return parts.join(SECTION);
}
