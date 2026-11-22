import { gunzipSync } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';

describe('response compression', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused@localhost/unused',
      PUBLIC_BASE_URL: 'http://api.test',
    });
    app = await buildApp(config, {} as Db, { logger: false });
  });
  afterAll(() => app.close());

  it('gzips a large JSON response when the client accepts gzip', async () => {
    const plain = await app.inject({ url: '/openapi.json' });
    const res = await app.inject({ url: '/openapi.json', headers: { 'accept-encoding': 'gzip' } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers.vary).toMatch(/Accept-Encoding/i);
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
    expect(res.rawPayload.length).toBeLessThan(plain.rawPayload.length);
    expect(JSON.parse(gunzipSync(res.rawPayload).toString())).toEqual(plain.json());
  });

  it('sends the body uncompressed when the client does not accept gzip', async () => {
    const res = await app.inject({ url: '/openapi.json' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json().openapi).toMatch(/^3\./);
  });

  it('leaves small responses alone', async () => {
    const res = await app.inject({ url: '/live', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json()).toEqual({ ok: true });
  });
});
