// The image scan's gate (#728): which osv-scanner findings fail the job. The reports here are
// small, made in the shape `osv-scanner scan image --format json` writes (read off a real scan of
// the pinned node:22-slim base, 2026-11-21).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failing, findings, MIN_SCORE } from './image-scan-gate.mjs';

const pkg = {
  name: 'zlib',
  os_package_name: 'zlib1g',
  version: '1:1.2.13.dfsg-1',
  ecosystem: 'Debian:12',
};

/** One package with one vulnerability group; `affected` is that record's affected list. */
function report(score, affected, extra = {}) {
  return {
    results: [
      {
        source: { path: 'image.tar', type: 'docker' },
        packages: [
          {
            package: { ...pkg, ...extra },
            groups: [{ ids: ['DEBIAN-CVE-1'], aliases: ['CVE-1'], max_severity: score }],
            vulnerabilities: [{ id: 'DEBIAN-CVE-1', affected }],
          },
        ],
      },
    ],
  };
}

const entry = (ecosystem, name, events) => ({
  package: { ecosystem, name },
  ranges: [{ type: 'ECOSYSTEM', events }],
});

test('a High finding the image release has a fix for fails the job', () => {
  const r = report('7.5', [
    entry('Debian:12', 'zlib', [{ introduced: '0' }, { fixed: '1:1.2.13.dfsg-1+deb12u1' }]),
  ]);
  const bad = failing(findings(r));
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0].fixed, ['1:1.2.13.dfsg-1+deb12u1']);
});

test('the threshold is CVSS 7.0, inclusive', () => {
  assert.equal(MIN_SCORE, 7.0);
  const fix = [entry('Debian:12', 'zlib', [{ introduced: '0' }, { fixed: '2' }])];
  assert.equal(failing(findings(report('7.0', fix))).length, 1);
  assert.equal(failing(findings(report('6.9', fix))).length, 0);
});

test('a fix only in a later release (Debian:13) is not a fix for this image', () => {
  const r = report('9.8', [
    entry('Debian:12', 'zlib', [{ introduced: '0' }]),
    entry('Debian:13', 'zlib', [{ introduced: '0' }, { fixed: '1:1.3.dfsg-2' }]),
  ]);
  assert.equal(failing(findings(r)).length, 0);
});

test("a fix for another source package in the same release (zlib's minizip) is not this one's", () => {
  const r = report('9.8', [
    entry('Debian:12', 'minizip', [{ introduced: '0' }, { fixed: '1.1-8+deb12u1' }]),
    entry('Debian:12', 'zlib', [{ introduced: '0' }]),
  ]);
  assert.equal(failing(findings(r)).length, 0);
});

test('a finding with no score is listed but does not fail', () => {
  const r = report('', [entry('Debian:12', 'zlib', [{ introduced: '0' }, { fixed: '2' }])]);
  const all = findings(r);
  assert.equal(all.length, 1);
  assert.equal(all[0].score, null);
  assert.equal(failing(all).length, 0);
});

test('a report without osv-scanner results is refused, not read as clean', () => {
  assert.throws(() => findings({}), /not an osv-scanner report/);
  assert.throws(() => findings(null), /not an osv-scanner report/);
  assert.deepEqual(findings({ results: [] }), []);
});
