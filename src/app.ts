import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';

import { ResponseCache } from './lib/cache.js';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { notFound } from './lib/http.js';
import { registerMetrics } from './metrics.js';
import { alertRoutes } from './routes/alerts.js';
import { campaignRoutes } from './routes/campaigns.js';
import { donorRoutes } from './routes/donors.js';
import { metaRoutes } from './routes/meta.js';
import { metadataRoutes } from './routes/metadata.js';
import { proofRoutes } from './routes/proofs.js';
import { releaseRoutes } from './routes/releases.js';
import { verifierRoutes } from './routes/verifiers.js';
import { webhookRoutes } from './routes/webhooks.js';
import { createStorage, type StorageDriver } from './storage/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    cache: ResponseCache;
  }
}

/** Same file for `src/app.ts` and `dist/app.js`, so one level up is the package root. */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export async function buildApp(
  config: Config,
  db: Db,
  opts: FastifyServerOptions = { logger: true },
) {
  const app = Fastify(opts);
  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('cache', new ResponseCache());
  // Routes validate input with zod. The JSON schemas on routes exist for the OpenAPI document
  // and response serialization, so Fastify must not validate with them as well.
  app.setValidatorCompiler(() => () => true);

  // Hardening headers (nosniff, frame-ancestors via X-Frame-Options, referrer policy, HSTS).
  // The CSP is off because this is a JSON API plus the Swagger UI, which needs inline scripts.
  // Cross-origin resource policy must allow other origins, or the frontend could not show proof
  // images served from /uploads.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(cors, { origin: config.corsOrigins });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 5 } });

  // OpenAPI spec, register before routes so all of them are picked up.
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Aidline API',
        description:
          'API and Soroban event indexer for Aidline, transparent funding for disaster relief and climate action.',
        version: pkg.version,
      },
      servers: [{ url: config.PUBLIC_BASE_URL }],
      tags: [
        { name: 'platform', description: 'Health, config and aggregate statistics' },
        { name: 'campaigns', description: 'Campaign listings and per-campaign data' },
        { name: 'metadata', description: 'Off-chain campaign metadata' },
        { name: 'releases', description: 'Milestone payout history' },
        { name: 'proofs', description: 'Verifier evidence uploads' },
        { name: 'verifiers', description: 'Verifier profiles and applications' },
        { name: 'donors', description: 'Donor profiles and donation history' },
        { name: 'alerts', description: 'Recent GDACS disaster alerts' },
        { name: 'webhooks', description: 'Milestone release webhook subscriptions' },
      ],
    },
  });

  // Raw spec at a stable, conventional path for tools and integrators.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // Interactive reference UI served at /docs
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: false },
  });

  // One stable URL shape for both storage drivers: proof URIs already written
  // on chain do not change when an operator moves files to S3 compatible storage.
  app.get('/uploads/*', { schema: { hide: true } }, async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    const object = await app.storage.get(key);
    if (!object) return notFound(reply, 'file');
    return reply.header('content-type', object.contentType).send(object.body);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'Request is invalid',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    // @fastify/rate-limit throws a 429 from its onRequest hook. Give it the same
    // error envelope as every other client error, with a code clients can match on.
    if (status === 429) {
      return reply.code(429).send({
        error: 'rate_limited',
        message: (err as Error).message || 'Too many requests',
      });
    }
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'request_error',
      message: status >= 500 ? 'Something went wrong' : (err as Error).message,
    });
  });

  // #10: consistent JSON 404 for unknown routes
  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).send({ error: 'not_found', message: 'Route not found' });
  });

  // #11: attach a unique X-Request-Id header to every response
  app.addHook('onSend', (_req, reply, _payload, done) => {
    if (!reply.hasHeader('x-request-id')) {
      reply.header('x-request-id', randomUUID());
    }
    done();
  });

  if (config.METRICS_ENABLED) registerMetrics(app);

  await app.register(metaRoutes);
  await app.register(campaignRoutes);
  await app.register(metadataRoutes);
  await app.register(proofRoutes);
  await app.register(releaseRoutes);
  await app.register(verifierRoutes);
  await app.register(donorRoutes);
  await app.register(alertRoutes);
  await app.register(webhookRoutes);

  return app;
}
