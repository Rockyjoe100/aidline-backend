import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { notFound } from '../lib/http.js';
import { dateTime, errorResponse } from '../lib/openapi.js';

/** Rejects URLs that would let a subscriber point a webhook at internal services. */
function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))
    return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

const campaignParam = z.object({ campaignId: z.coerce.bigint().nonnegative() });

/** Campaign-scoped webhook subscriptions for milestone release notifications. */
export async function webhookRoutes(app: FastifyInstance) {
  const webhookUrl = z.url().refine((value) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (url.username || url.password) return false;
    return app.config.WEBHOOK_ALLOW_PRIVATE_URLS || !isPrivateHost(url.hostname);
  }, 'must be an http(s) URL without embedded credentials or a private host');

  app.post(
    '/campaigns/:campaignId/webhooks',
    {
      schema: {
        tags: ['webhooks'],
        summary: "Subscribe a URL to a campaign's milestone releases",
        description:
          'The URL receives a POST for each milestone released on this campaign. Each address may subscribe once per campaign.',
        body: {
          type: 'object',
          required: ['url'],
          properties: {
            url: {
              type: 'string',
              format: 'uri',
              description: 'http(s) URL without credentials or a private host',
            },
          },
          example: { url: 'https://hooks.example.org/aidline/milestones' },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              campaignId: { type: 'string' },
              url: { type: 'string' },
              createdAt: dateTime,
            },
          },
          400: errorResponse('The URL is missing, malformed or not allowed'),
          404: errorResponse('The campaign does not exist'),
          409: errorResponse('This campaign already has a subscription for that URL'),
        },
      },
    },
    async (req, reply) => {
      const { campaignId } = campaignParam.parse(req.params);
      const { url } = z.object({ url: webhookUrl }).parse(req.body);
      const id = campaignId.toString();
      const exists = await app.db.query('SELECT 1 FROM campaigns WHERE id = $1', [id]);
      if (!exists.rowCount) return notFound(reply, 'campaign');

      const { rows } = await app.db.query(
        `INSERT INTO webhook_subscriptions (id, campaign_id, url)
         VALUES (gen_random_uuid(), $1, $2)
         ON CONFLICT (campaign_id, url) DO NOTHING
         RETURNING id, campaign_id AS "campaignId", url, created_at AS "createdAt"`,
        [id, url],
      );
      if (!rows[0]) {
        return reply.code(409).send({
          error: 'already_subscribed',
          message: 'This campaign already has a subscription for that URL',
        });
      }
      return reply.code(201).send(rows[0]);
    },
  );

  app.get('/campaigns/:campaignId/webhooks', { schema: { tags: ['webhooks'] } }, async (req) => {
    const { campaignId } = campaignParam.parse(req.params);
    const { rows } = await app.db.query(
      `SELECT id, campaign_id AS "campaignId", url, created_at AS "createdAt"
         FROM webhook_subscriptions WHERE campaign_id = $1 ORDER BY created_at, id`,
      [campaignId.toString()],
    );
    return { items: rows };
  });

  app.delete(
    '/webhooks/:id',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Delete a webhook subscription',
        response: {
          204: { type: 'null', description: 'The subscription was deleted' },
          400: errorResponse('The id is not a UUID'),
          404: errorResponse('The subscription does not exist'),
        },
      },
    },
    async (req, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { rowCount } = await app.db.query('DELETE FROM webhook_subscriptions WHERE id = $1', [
        id,
      ]);
      if (!rowCount) return notFound(reply, 'webhook subscription');
      return reply.code(204).send();
    },
  );

  app.get('/webhooks/:id/deliveries', { schema: { tags: ['webhooks'] } }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rows } = await app.db.query(
      `SELECT id, status, attempts, payload, last_error AS "lastError",
              next_attempt_at AS "nextAttemptAt", created_at AS "createdAt"
       FROM webhook_deliveries
       WHERE subscription_id = $1
       ORDER BY created_at DESC`,
      [id],
    );
    return { items: rows };
  });
}
