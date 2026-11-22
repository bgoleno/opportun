// Reports the lockfile scan's findings and fails on any (#733). It does what the reporter action
// did before (google/osv-scanner-action/osv-reporter-action with --gh-annotations and
// --fail-on-vuln), without running that action: it is a container action whose image is named by
// tag, so pinning its commit did not pin the code that ran. The scanner itself now runs by digest
// (security.yml), and writes SARIF that this reads.
//
// The message text comes from the OSV database, so it is outside input. It is escaped as GitHub's
// workflow commands require before it is printed in one: a finding cannot end the command early,
// add a property, or start a command of its own.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A workflow command's data: %, CR and LF escaped. */
export function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** A workflow command's property value: as data, plus : and , escaped. */
export function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** A result's file, relative to the workspace when it is under it, else its last path part. */
function fileOf(result, workspace) {
  const uri = result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
  if (typeof uri !== 'string' || uri === '') return null;
  let path = uri;
  if (uri.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(uri).pathname);
    } catch {
      return null;
    }
  }
  const base = workspace.endsWith('/') ? workspace : `${workspace}/`;
  if (workspace !== '' && path.startsWith(base)) return path.slice(base.length);
  return path.split('/').pop() || null;
}

/** The findings in a SARIF log. Throws when it is not one, so a broken scan is not a clean one. */
export function findings(sarif, workspace = '') {
  if (sarif === null || typeof sarif !== 'object' || !Array.isArray(sarif.runs)) {
    throw new Error('not a SARIF log: no runs array');
  }
  const out = [];
  for (const run of sarif.runs) {
    for (const result of run?.results ?? []) {
      out.push({
        rule: typeof result?.ruleId === 'string' ? result.ruleId : 'unknown',
        text: typeof result?.message?.text === 'string' ? result.message.text : '',
        file: fileOf(result, workspace),
      });
    }
  }
  return out;
}

/** The workflow command for one finding. */
export function annotation(f) {
  const props = f.file === null ? '' : ` file=${escapeProperty(f.file)}`;
  return `::error${props}::${escapeData(`${f.rule}: ${f.text}`)}`;
}

function main(path, workspace) {
  const all = findings(JSON.parse(readFileSync(path, 'utf8')), workspace);
  for (const f of all) console.log(annotation(f));
  console.log(`OSV lockfile scan: ${all.length} finding(s).`);
  return all.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: node osv-sarif-report.mjs <SARIF file>');
    process.exit(2);
  }
  process.exit(main(path, process.env.GITHUB_WORKSPACE ?? ''));
}
