import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildConfig } from '../config/env.js';
import { registerOperationsRoutes } from './routes.js';

let app: FastifyInstance;
afterEach(async () => { await app?.close(); vi.unstubAllGlobals(); });

function setup(options: Record<string, string> = {}, upstreamRealm = 0) {
  app = Fastify();
  const fetcher = vi.fn(async (url: URL) => new Response(JSON.stringify(
    url.pathname.endsWith('/state') ? { api: { realm: upstreamRealm } } : { captured_at: '2026-01-01T00:00:00Z', cash: 123 },
  ), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  registerOperationsRoutes(app, buildConfig({ OPERATIONS_URL: 'http://capture.internal/', ...options }));
  return fetcher;
}

describe('operations bridge', () => {
  it('reads the fixed upstream endpoint without passing cookies or arbitrary queries', async () => {
    const fetcher = setup();
    const response = await app.inject({ url: '/api/operations/events?realm=magnates&limit=10&url=https://example.com', headers: { cookie: 'ledger_session=private', authorization: 'private' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['http://capture.internal/api/state', 'http://capture.internal/api/events?limit=10']);
    expect(fetcher.mock.calls.every(call => !JSON.stringify(call).includes('private'))).toBe(true);
  });

  it('refuses the other realm before reading company data', async () => {
    const fetcher = setup();
    expect((await app.inject('/api/operations/snapshot?realm=entrepreneurs')).statusCode).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses data when the running capture service has switched realms', async () => {
    const fetcher = setup({}, 1);
    expect((await app.inject('/api/operations/snapshot')).statusCode).toBe(409);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('supports an explicitly configured Entrepreneurs connection', async () => {
    setup({ OPERATIONS_REALM: 'entrepreneurs' }, 1);
    expect((await app.inject('/api/operations/snapshot?realm=entrepreneurs')).statusCode).toBe(200);
  });

  it('does not expose action endpoints or accept mutations', async () => {
    const fetcher = setup();
    for (const url of ['/api/operations/capture', '/api/operations/approval', '/api/operations/action/collect', '/api/operations/constructor']) {
      expect((await app.inject(url)).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: '/api/operations/strategy', payload: {} })).statusCode).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unbounded queries and invalid realm values', async () => {
    setup();
    for (const query of ['limit=999999', 'limit=0', 'limit=NaN', 'limit=1.5', 'realm=unknown']) {
      expect((await app.inject(`/api/operations/events?${query}`)).statusCode).toBe(400);
    }
  });

  it('returns a recoverable, sanitized error if upstream is offline', async () => {
    const fetcher = setup();
    fetcher.mockRejectedValue(new Error('Sensitive internal address'));
    const response = await app.inject('/api/operations/snapshot');
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('Sensitive');
  });

  it('preserves configured upstream path prefixes', async () => {
    const fetcher = setup({ OPERATIONS_URL: 'http://capture.internal/existing/' });
    expect((await app.inject('/api/operations/snapshot')).statusCode).toBe(200);
    expect(String(fetcher.mock.calls[1]![0])).toBe('http://capture.internal/existing/api/snapshot');
  });

  it('keeps imports usable when no operations connection is configured', async () => {
    app = Fastify();
    registerOperationsRoutes(app, buildConfig({}));
    expect((await app.inject('/api/operations/snapshot')).statusCode).toBe(503);
  });
});
