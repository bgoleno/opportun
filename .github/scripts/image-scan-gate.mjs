// The gate on the image's OS-package scan (#728, sec's supply-chain review): reads osv-scanner's
// JSON for `scan image` and fails on a finding the image could already be rid of.
//
// The rule: a vulnerability group whose max_severity is at least MIN_SCORE (CVSS 7.0, High or
// Critical), in a package for which the image's own release has a fix. Most findings in a Debian
// base have no fix in that release yet, and failing on those would fail every run with nothing to
// do. A fix the release already has means the base digest (kept current by Dependabot, #619) or
// the package needs bumping. A finding with no score is listed and does not fail.
//
// "Has a fix" reads the OSV record's affected entries for exactly this package (its source name)
// in exactly this ecosystem (for example Debian:12) and looks for a `fixed` event. osv-scanner
// already listed the package as affected, so a fixed version is one the image does not have yet.
// An entry for another release (Debian:13) or another source package (zlib's minizip entry) is not
// a fix for this one.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIN_SCORE = 7.0;

/** The fixed versions this package's own release has for one OSV record. */
function fixesFor(vuln, pkg) {
  const out = [];
  for (const affected of vuln?.affected ?? []) {
    if (affected?.package?.ecosystem !== pkg.ecosystem) continue;
    if (affected?.package?.name !== pkg.name) continue;
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (typeof event?.fixed === 'string' && event.fixed !== '') out.push(event.fixed);
      }
    }
  }
  return out;
}

/**
 * Every finding, each with its score (null when there is none) and the fixed versions its release
 * has. Throws on a report that does not have osv-scanner's shape: a scan that wrote nothing usable
 * must not read as a clean one.
 */
export function findings(report) {
  if (report === null || typeof report !== 'object' || !Array.isArray(report.results)) {
    throw new Error('not an osv-scanner report: no results array');
  }
  const out = [];
  for (const result of report.results) {
    for (const entry of result?.packages ?? []) {
      const pkg = entry?.package;
      if (typeof pkg?.name !== 'string' || typeof pkg?.ecosystem !== 'string') continue;
      const byId = new Map((entry.vulnerabilities ?? []).map((v) => [v?.id, v]));
      for (const group of entry.groups ?? []) {
        const raw = Number.parseFloat(group?.max_severity ?? '');
        const ids = Array.isArray(group?.ids) ? group.ids : [];
        const fixed = [...new Set(ids.flatMap((id) => fixesFor(byId.get(id), pkg)))];
        out.push({
          package: pkg.name,
          version: String(pkg.version ?? ''),
          ecosystem: pkg.ecosystem,
          ids,
          score: Number.isFinite(raw) ? raw : null,
          fixed,
        });
      }
    }
  }
  return out;
}

/** The findings that fail the job. */
export function failing(all, minScore = MIN_SCORE) {
  return all.filter((f) => f.score !== null && f.score >= minScore && f.fixed.length > 0);
}

function line(f) {
  const score = f.score === null ? 'no score' : f.score.toFixed(1);
  const fix = f.fixed.length > 0 ? `fixed in ${f.fixed.join(', ')}` : 'no fix in this release';
  return `| ${f.package} ${f.version} (${f.ecosystem}) | ${f.ids.join(', ')} | ${score} | ${fix} |`;
}

function main(path) {
  const all = findings(JSON.parse(readFileSync(path, 'utf8')));
  const bad = failing(all);
  const fixable = all.filter((f) => f.fixed.length > 0);
  const out = [
    `Image OS packages: ${all.length} finding(s), ${fixable.length} with a fix in the image's release,`,
    `${bad.length} at CVSS ${MIN_SCORE.toFixed(1)} or above with a fix (these fail the job).`,
    '',
  ];
  if (fixable.length > 0) {
    out.push('| Package | Vulnerability | Score | Fix |', '| --- | --- | --- | --- |');
    for (const f of fixable) out.push(line(f));
  }
  const text = out.join('\n');
  console.log(text);
  // Appended, so the job's summary keeps whatever earlier steps wrote.
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  for (const f of bad) {
    console.log(
      `::error::${f.package} ${f.version}: ${f.ids.join(', ')} (${f.score}) is fixed in ${f.fixed.join(', ')}`,
    );
  }
  return bad.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: node image-scan-gate.mjs <osv-scanner JSON>');
    process.exit(2);
  }
  process.exit(main(path));
}
