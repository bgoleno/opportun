// The opportun-connector executable: wires main() to the real process. Ctrl-C (or launchd's
// SIGTERM) stops `watch` between batches; a second Ctrl-C exits at once.
import { main } from './cli';
import { defaultConfigDir } from './config';
import { nodeIo } from './nodeIo';
import { EXIT } from './types';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  });
}

let configDir: string;
try {
  configDir = defaultConfigDir(process.env);
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(EXIT.USAGE);
}

// Set by deploy/opportun-connector.plist so watch's own file logging (nodeIo.ts, #21) can
// replace launchd's unbounded StandardOutPath/StandardErrorPath redirection with a rotated one.
const logFile = process.env.OPPORTUN_CONNECTOR_LOG_FILE?.trim();
process.exitCode = await main(
  process.argv.slice(2),
  nodeIo(configDir, logFile === undefined || logFile === '' ? undefined : logFile),
  { signal: controller.signal },
);
