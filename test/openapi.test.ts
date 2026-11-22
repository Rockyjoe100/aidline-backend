import { readFileSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Served, but left out of the spec on purpose (`hide: true`). Documented in API.md anyway.
const HIDDEN = new Set(['GET /openapi.json', 'GET /docs', 'GET /metrics']);

/** `:id`, `{id}` and `<proof id>` all name a path parameter, so compare them as one shape. */
const normalise = (method: string, path: string) =>
  `${method.toUpperCase()} ${path.replace(/:\w+|\{[^}]+\}|<[^>]+>/g, '{}')}`;

describe('OpenAPI document', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused@localhost/unused',
      PUBLIC_BASE_URL: 'http://api.test',
    });
    app = await buildApp(config, {} as Db, { logger: false });
  });
  afterAll(() => app.close());

  it('describes path and query parameters of the campaign routes', async () => {
    const spec = (await app.inject({ url: '/openapi.json' })).json();

    const byId = spec.paths['/campaigns/{id}'].get;
    expect(byId.tags).toEqual(['campaigns']);
    expect(byId.parameters).toEqual([
      expect.objectContaining({
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^\\d+$' },
      }),
    ]);

    const list = spec.paths['/campaigns'].get.parameters as { name: string; in: string }[];
    const query = list.filter((p) => p.in === 'query').map((p) => p.name);
    expect(query).toEqual(
      expect.arrayContaining(['kind', 'status', 'q', 'sort', 'limit', 'offset']),
    );

    const donations = spec.paths['/campaigns/{id}/donations'].get.parameters as { name: string }[];
    expect(donations.map((p) => p.name)).toEqual(expect.arrayContaining(['id', 'limit', 'offset']));
  });

  it('still rejects bad campaign ids and query values with zod validation errors', async () => {
    const badId = await app.inject({ url: '/campaigns/abc' });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error).toBe('validation_error');

    const badLimit = await app.inject({ url: '/campaigns?limit=500' });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json().error).toBe('validation_error');
  });

  it('lists every route in docs/API.md, and no documented route that does not exist', async () => {
    const spec = (await app.inject({ url: '/openapi.json' })).json();
    const routes = new Set<string>();
    for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
      for (const method of METHODS) {
        if (item[method]) routes.add(normalise(method, path));
      }
    }

    const docs = readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8');
    const documented = new Set(
      [...docs.matchAll(/\b(GET|POST|PUT|PATCH|DELETE) `?(\/[^\s`]*)/g)].map((m) =>
        normalise(m[1] ?? '', m[2] ?? ''),
      ),
    );

    const missingFromDocs = [...routes].filter((r) => !documented.has(r));
    const removedFromApi = [...documented].filter(
      (r) => !routes.has(r) && !HIDDEN.has(r) && !r.startsWith('GET /uploads/'),
    );

    expect(missingFromDocs).toEqual([]);
    expect(removedFromApi).toEqual([]);
  });
});
