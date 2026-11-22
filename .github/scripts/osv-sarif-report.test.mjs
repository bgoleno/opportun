// The lockfile scan's reporter (#733): findings from the scanner's SARIF become annotations, and
// any finding fails the job. The SARIF here is shaped as osv-scanner v2.7.0 writes it (read off a
// real scan, 2026-11-21).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotation, escapeData, escapeProperty, findings } from './osv-sarif-report.mjs';

const WORKSPACE = '/home/runner/work/opportun/opportun';

const sarif = (results) => ({ runs: [{ tool: { driver: { name: 'osv-scanner' } }, results }] });
const result = (ruleId, text, uri = `file://${WORKSPACE}/pnpm-lock.yaml`) => ({
  ruleId,
  message: { text },
  locations: [{ physicalLocation: { artifactLocation: { uri } } }],
});

test('every finding is listed, with its file relative to the workspace', () => {
  const all = findings(
    sarif([result('CVE-2020-28500', "Package 'lodash@4.17.15' is vulnerable")]),
    WORKSPACE,
  );
  assert.deepEqual(all, [
    {
      rule: 'CVE-2020-28500',
      text: "Package 'lodash@4.17.15' is vulnerable",
      file: 'pnpm-lock.yaml',
    },
  ]);
  assert.equal(
    annotation(all[0]),
    "::error file=pnpm-lock.yaml::CVE-2020-28500: Package 'lodash@4.17.15' is vulnerable",
  );
});

test('no findings is an empty list', () => {
  assert.deepEqual(findings(sarif([]), WORKSPACE), []);
  assert.deepEqual(findings({ runs: [{}] }, WORKSPACE), []);
});

test('a log that is not SARIF is refused, never read as clean', () => {
  assert.throws(() => findings({}, WORKSPACE), /not a SARIF log/);
  assert.throws(() => findings(null, WORKSPACE), /not a SARIF log/);
});

test("a finding's text cannot end the command, add a property or start another", () => {
  const hostile = result('X-1', 'bad\n::warning::injected %0A and 100%', 'file:///tmp/a,b:c.yaml');
  const line = annotation(findings(sarif([hostile]), WORKSPACE)[0]);
  assert.equal(line.split('\n').length, 1);
  assert.equal(
    line,
    '::error file=a%2Cb%3Ac.yaml::X-1: bad%0A::warning::injected %250A and 100%25',
  );
  assert.equal(escapeData('a\r\nb%'), 'a%0D%0Ab%25');
  assert.equal(escapeProperty('a:b,c'), 'a%3Ab%2Cc');
});
