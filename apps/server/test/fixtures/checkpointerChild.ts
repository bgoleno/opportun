// A child process for sqliteCheckpointer.test.ts (#383): opens a database with the background
// checkpointer on, closes it as a shutdown does, with nothing else keeping the event loop alive,
// and says so only once the close has finished.
import { closeDatabase, openDatabase } from '../../src/db/client';

const dir = process.argv[2]!;
const handle = openDatabase(dir, dir, { backgroundCheckpoint: true });
await closeDatabase(handle);
process.stdout.write(`closed ${handle.sqlite.open ? 'open' : 'shut'}\n`);
