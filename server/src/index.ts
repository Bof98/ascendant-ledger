import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { config } from './config/env.js';
import { openDatabase, checkIntegrity } from './db/connection.js';
import { createQueryBuilder } from './db/kysely.js';
import { migrate, listApplied } from './db/migrate.js';
import { ensureInitialUser, readSession } from './auth.js';
import { registerApiRoutes } from './api/routes.js';
import { registerCsvSync } from './operations/csv-sync.js';
import { registerCaptureSync } from './operations/capture-sync.js';
import { registerOperationsRoutes } from './operations/routes.js';

const APP_VERSION = '1.1.0';
const startedAt = Date.now();

const db = openDatabase({
  path: config.databasePath,
  verbose: !config.isProduction && config.LOG_LEVEL === 'trace',
});

const migrationResult = migrate(db, {
  log: (m) => console.log(`[migrate] ${m}`),
});
if (migrationResult.applied.length > 0) {
  console.log(`[migrate] applied ${migrationResult.applied.length} migration(s)`);
}

ensureInitialUser(db, config);
const qb = createQueryBuilder(db, { debug: config.LOG_LEVEL === 'trace' });

const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  trustProxy: config.TRUST_PROXY,
  // Uploads are transported as JSON text so the browser does not need a
  // multipart dependency. Cap the aggregate request while retaining the
  // per-file guard in the import route.
  bodyLimit: Math.min(config.MAX_UPLOAD_BYTES * 4, 100 * 1024 * 1024),
});


app.addHook('onRequest', async (request, reply) => {
  if (!config.AUTH_ENABLED || !request.url.startsWith('/api/')) return;
  if (request.url.split('?')[0] === '/api/health' || request.url.startsWith('/api/auth/')) return;
  const session = readSession(request, config.SESSION_SECRET!);
  if (!session) return reply.code(401).send({ error: 'Authentication required.' });
});

app.get('/api/health', async (_request, reply) => {
  const integrity = checkIntegrity(db);
  const migrations = listApplied(db);
  const body = {
    status: integrity.ok ? ('ok' as const) : ('degraded' as const),
    version: APP_VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    database: {
      path: config.databasePath,
      integrity: integrity.detail,
      migrationsApplied: migrations.length,
      latestMigration: migrations.at(-1)?.name ?? null,
    },
  };
  return reply.code(integrity.ok ? 200 : 503).send(body);
});

registerApiRoutes({ app, raw: db, qb, config });
registerOperationsRoutes(app, config);
registerCaptureSync(app, db, qb, config);
registerCsvSync(app, db, qb, config);

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../web');
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendStatic(reply: import('fastify').FastifyReply, file: string): unknown {
  const ext = path.extname(file).toLowerCase();
  reply.header('Content-Type', contentTypes[ext] ?? 'application/octet-stream');
  reply.header('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=3600');
  return reply.send(fs.createReadStream(file));
}

app.get('/', async (_request, reply) => sendStatic(reply, path.join(webDir, 'index.html')));
app.get('/assets/*', async (request, reply) => {
  const wildcard = String((request.params as { '*': string })['*'] ?? '');
  const candidate = path.resolve(webDir, 'assets', wildcard);
  const root = path.resolve(webDir, 'assets') + path.sep;
  if (!candidate.startsWith(root) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return reply.code(404).send({ error: 'Not found.' });
  }
  return sendStatic(reply, candidate);
});

// SPA fallback. API 404s are never converted into HTML.
app.get('/*', async (request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found.' });
  return sendStatic(reply, path.join(webDir, 'index.html'));
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await qb.destroy();
  } catch (error) {
    app.log.error({ error }, 'error during shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info({ database: config.databasePath, auth: config.AUTH_ENABLED, webDir }, 'Ascendant Ledger ready');
} catch (error) {
  app.log.error({ error }, 'failed to start');
  process.exit(1);
}
