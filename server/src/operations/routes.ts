import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';

// Only these existing read endpoints are reachable. Never accept a target URL,
// forward browser credentials, or expose the capture/action/approval endpoints.
const endpoints: Record<string, Record<string, number>> = {
  snapshot: {}, state: {}, ticker: {}, history: { days: 90 },
  pnl: { days: 90 }, reconcile: {}, alerts: { days: 90 },
  events: { limit: 200 }, recommendations: {}, strategy: {},
  achievements: {}, experience: {}, reflection: {}, live: {},
};

export function registerOperationsRoutes(app: FastifyInstance, config: AppConfig): void {
  let realmCheck: { realm: string; expires: number } | undefined;
  const base = config.OPERATIONS_URL ? `${config.OPERATIONS_URL.replace(/\/+$/, '')}/` : null;

  async function upstreamRealm(): Promise<string> {
    if (realmCheck && realmCheck.expires > Date.now()) return realmCheck.realm;
    const response = await fetch(new URL('api/state', base!), {
      signal: AbortSignal.timeout(config.OPERATIONS_TIMEOUT_MS), redirect: 'error',
    });
    if (!response.ok) throw new Error('Upstream state unavailable');
    const state = await response.json() as { api?: { realm?: number } };
    const realm = state.api?.realm === 0 ? 'magnates' : state.api?.realm === 1 ? 'entrepreneurs' : null;
    if (!realm) throw new Error('Upstream realm unknown');
    realmCheck = { realm, expires: Date.now() + 10_000 };
    return realm;
  }

  app.get('/api/operations/:endpoint', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { endpoint } = request.params as { endpoint: string };
    if (!Object.hasOwn(endpoints, endpoint)) return reply.code(404).send({ error: 'Unknown operations endpoint.' });
    if (!base) return reply.code(503).send({ error: 'The operations connection is not configured.' });
    const query = request.query as Record<string, unknown>;
    const realm = String(query.realm ?? 'magnates');
    if (!['magnates', 'entrepreneurs'].includes(realm)) return reply.code(400).send({ error: 'Invalid realm.' });
    if (realm !== config.OPERATIONS_REALM) {
      return reply.code(409).send({ error: `Live operations are connected to ${config.OPERATIONS_REALM} only. Switch realms to view them.` });
    }
    try {
      if (await upstreamRealm() !== config.OPERATIONS_REALM) {
        return reply.code(409).send({ error: 'The capture service realm has changed. Update the operations connection before viewing its data.' });
      }
      const url = new URL(`api/${endpoint}`, base);
      for (const [key, max] of Object.entries(endpoints[endpoint]!)) {
        const value = query[key];
        if (value !== undefined) {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1 || n > max) return reply.code(400).send({ error: `${key} must be between 1 and ${max}.` });
          url.searchParams.set(key, String(n));
        }
      }
      const response = await fetch(url, {
        signal: AbortSignal.timeout(config.OPERATIONS_TIMEOUT_MS), redirect: 'error',
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        return reply.code(502).send({ error: 'The capture service could not load this view. Please retry.' });
      }
      return reply.send(await response.json());
    } catch {
      return reply.code(503).send({ error: 'The capture service is unavailable or timed out. Your imported ledger is still available.' });
    }
  });
}
