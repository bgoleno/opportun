// CI guard for the Postgres leg (iteration 4 Task 13): the live tests are written with
// describe.runIf(TEST_DATABASE_URL), so a misconfigured job would skip them and still be
// green. This reads vitest's JSON report and fails unless every required test ran and passed.
//
//   node scripts/requireTests.mjs <report.json> <name substring>...
//
// Each substring must match at least one test's full name, and every match must be 'passed'.
import { existsSync, readFileSync } from 'node:fs';

const [reportPath, ...required] = process.argv.slice(2);
if (reportPath === undefined || required.length === 0) {
  console.error('usage: requireTests.mjs <report.json> <name substring>...');
  process.exit(2);
}

// A missing report means the suite step never ran (an earlier step failed): say so
// plainly instead of crashing with a stack trace.
if (!existsSync(reportPath)) {
  console.error(`requireTests: report not found at ${reportPath}: the test step did not run.`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const tests = report.testResults.flatMap((file) =>
  file.assertionResults.map((t) => ({ name: t.fullName, status: t.status })),
);

let failed = false;
for (const needle of required) {
  const matches = tests.filter((t) => t.name.includes(needle));
  if (matches.length === 0) {
    console.error(`MISSING  ${needle}`);
    failed = true;
    continue;
  }
  for (const t of matches) {
    const ok = t.status === 'passed';
    if (!ok) failed = true;
    console.log(`${ok ? 'ok      ' : t.status.toUpperCase().padEnd(8)} ${t.name}`);
  }
}
// A file whose hook or import failed has no failed test of its own: name it too.
for (const file of report.testResults) {
  if (file.status !== 'passed' && file.status !== 'skipped') {
    failed = true;
    console.error(
      `FILE ${file.status.toUpperCase()}  ${file.name}\n${(file.message ?? '').trim()}`,
    );
  }
}
console.log(
  `report: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests} skipped of ${report.numTotalTests}`,
);
process.exit(failed ? 1 : 0);
