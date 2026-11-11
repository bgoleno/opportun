// A child process for obsProcessHandlers.test.ts (#345): installs the server's process handlers,
// then fails in the way the first argument names, with personal data in the error.
import { installProcessHandlers } from '../../src/obs/log';

const CANARY = 'Jane Doe <jane.doe@example.com> +1 (206) 555-0142';
installProcessHandlers();
const how = process.argv[2];
if (how === 'warning') {
  process.emitWarning(`deprecated for ${CANARY}`, { code: 'XDEP900', type: 'DeprecationWarning' });
  setTimeout(() => process.exit(0), 200);
} else if (how === 'rejection') {
  void Promise.reject(Object.assign(new TypeError(`no mail for ${CANARY}`), { person: CANARY }));
} else {
  setTimeout(() => {
    throw Object.assign(
      new Error(`boom for ${CANARY}\n    at Leak.Name (${process.cwd()}/x.ts:1:1)`),
      {
        person: CANARY,
      },
    );
  }, 10);
}
