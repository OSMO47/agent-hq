import { join, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { seed } from './seed.ts';
import { SessionManager } from './runtime/sessionManager.ts';
import { ClaudeCliAdapter } from './runtime/claudeCliAdapter.ts';
import { createHq } from './app.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = resolve(process.env.HQ_DATA_DIR ?? join(root, 'data'));
const port = Number(process.env.HQ_PORT ?? 4317);
const host = '127.0.0.1'; // never exposed to the network

const db = openDb(join(dataDir, 'hq.db'));
if (seed(db)) console.log('[hq] seeded initial organization');
const sm = new SessionManager(db, new ClaudeCliAdapter());
const staticDir = join(root, 'web', 'dist');
const { server } = createHq(db, sm, { dataDir, port, staticDir: existsSync(staticDir) ? staticDir : undefined });

server.listen(port, host, () => {
  console.log(`[hq] Agent HQ on http://${host}:${port}  (data: ${dataDir})`);
  sm.pump(); // resume any queue left from a previous run
});

const shutdown = () => { console.log('[hq] stopping all sessions'); sm.stopAll('system'); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
