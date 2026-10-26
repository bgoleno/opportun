// zod probes for eval support the first time a schema is built, and the CSP reports that
// probe as a violation. The config must therefore run before any module that builds a
// schema at load time. A static import cannot guarantee that once the bundler hoists
// shared modules into chunks that evaluate first, so the app loads only after it.
import './lib/zodConfig';

void import('./app');
