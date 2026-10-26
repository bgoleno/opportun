// zod v4 compiles object parsers with `new Function` when it can. The server's CSP has
// no 'unsafe-eval', so even zod's feature probe logs a violation. Turn the JIT off; this
// module is imported first in main.tsx so it runs before any schema parses.
import { z } from 'zod';

z.config({ jitless: true });
