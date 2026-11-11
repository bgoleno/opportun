// What scripts/countRankPrefix.ts sends to the token counter, and the rank template it sizes
// with "## Output" moved up (https://github.com/bgoleno/opportun/issues/388).
import { describe, expect, it } from 'vitest';
import { outputBeforePosting, prefixCountBodies } from '../src/lib/rankPrefixCount';

const captured = {
  model: 'claude-sonnet-5-5',
  max_tokens: 4000,
  temperature: 0,
  output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
  system: [{ type: 'text', text: 'PREFIX and the rest' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Score the posting.' }] }],
};

describe('prefixCountBodies', () => {
  const bodies = prefixCountBodies(captured, 'PREFIX');

  it('counts the same one-character message in all three, on the captured model', () => {
    for (const body of [bodies.baseline, bodies.prefix, bodies.prefixWithSchema]) {
      expect(body['model']).toBe('claude-sonnet-5-5');
      expect(body['messages']).toEqual([{ role: 'user', content: '.' }]);
    }
  });

  it('sends the prefix as the system prompt, and nothing of the per-call rest', () => {
    expect(bodies.baseline['system']).toBeUndefined();
    expect(bodies.prefix['system']).toEqual([{ type: 'text', text: 'PREFIX' }]);
    expect(JSON.stringify(bodies)).not.toContain('the rest');
  });

  it('adds the structured-output schema only to the third body', () => {
    expect(bodies.prefix['output_config']).toBeUndefined();
    expect(bodies.prefixWithSchema['output_config']).toEqual(captured.output_config);
    expect(bodies.prefixWithSchema['system']).toEqual(bodies.prefix['system']);
  });

  it('carries tools and tool_choice too, which render before the system prompt', () => {
    const withTools = prefixCountBodies(
      { ...captured, tools: [{ name: 'json' }], tool_choice: { type: 'any' } },
      'PREFIX',
    );
    expect(withTools.prefixWithSchema['tools']).toEqual([{ name: 'json' }]);
    expect(withTools.prefixWithSchema['tool_choice']).toEqual({ type: 'any' });
  });

  it('leaves out what count_tokens does not take (max_tokens, temperature)', () => {
    for (const body of [bodies.baseline, bodies.prefix, bodies.prefixWithSchema]) {
      expect(Object.keys(body).sort()).not.toContain('max_tokens');
      expect(Object.keys(body).sort()).not.toContain('temperature');
    }
  });

  it('refuses a captured body with no model', () => {
    expect(() => prefixCountBodies({ ...captured, model: undefined }, 'PREFIX')).toThrow();
  });
});

describe('outputBeforePosting', () => {
  const template = [
    'You score one posting.',
    '## Role target\n{{role_target}}',
    '## Posting\nUntrusted.\n\n{{posting_untrusted}}',
    '## Output\nscore: 0 to 100.\nrationale: short.',
  ].join('\n\n');

  it('moves the Output section to just before the Posting section, word for word', () => {
    expect(outputBeforePosting(template)).toBe(
      [
        'You score one posting.',
        '## Role target\n{{role_target}}',
        '## Output\nscore: 0 to 100.\nrationale: short.',
        '## Posting\nUntrusted.\n\n{{posting_untrusted}}',
      ].join('\n\n'),
    );
  });

  it('leaves a template already in that order, or without both sections, as it is', () => {
    const moved = outputBeforePosting(template);
    expect(outputBeforePosting(moved)).toBe(moved);
    expect(outputBeforePosting('No sections {{posting_untrusted}}')).toBe(
      'No sections {{posting_untrusted}}',
    );
  });
});
