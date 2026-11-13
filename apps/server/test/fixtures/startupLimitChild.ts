// A separate process that runs the server's main() with no configuration, so it stops at the
// first missing setting, and prints the stack frame limit it left behind (stackTraceLimit.test.ts,
// #436).
import { main } from '../../src/index';

main().then(
  () => {
    process.stdout.write(`${JSON.stringify({ limit: Error.stackTraceLimit, stoppedAt: null })}\n`);
    process.exit(0);
  },
  (err: unknown) => {
    const stoppedAt = err instanceof Error ? err.constructor.name : typeof err;
    process.stdout.write(`${JSON.stringify({ limit: Error.stackTraceLimit, stoppedAt })}\n`);
    process.exit(0);
  },
);
