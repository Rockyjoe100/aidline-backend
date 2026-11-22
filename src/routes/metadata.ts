import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { notFound, writeRateLimits } from '../lib/http.js';
import { errorResponse } from '../lib/openapi.js';

const body = z.object({
  title: z.string().trim().min(5).max(120),
  summary: z.string().trim().min(10).max(280),
  description: z.string().trim().min(20).max(10_000),
  location: z.string().trim().min(2).max(120),
  organizer: z.string().trim().min(2).max(120).optional(),
  category: z.string().trim().max(60).optional(),
  imageUrl: z.url().optional(),
});

/**
 * Campaign metadata is written here first. The returned URI is then passed
 * to `create_campaign`, which ties the on chain campaign to this record.
 * Records are immutable so the URI on chain always means the same thing.
 */
export async function metadataRoutes(app: FastifyInstance) {
  app.post(
    '/metadata',
    {
      config: { rateLimit: writeRateLimits.metadata },
      schema: {
        tags: ['metadata'],
        summary: 'Store campaign metadata',
        description:
          'Stores an immutable metadata record. Pass the returned `uri` to `create_campaign`. Records are never edited, so the URI on chain always describes the same content.',
        body: {
          type: 'object',
          required: ['title', 'summary', 'description', 'location'],
          properties: {
            title: { type: 'string', minLength: 5, maxLength: 120 },
            summary: { type: 'string', minLength: 10, maxLength: 280 },
            description: { type: 'string', minLength: 20, maxLength: 10000 },
            location: { type: 'string', minLength: 2, maxLength: 120 },
            organizer: { type: 'string', minLength: 2, maxLength: 120 },
            category: { type: 'string', maxLength: 60 },
            imageUrl: { type: 'string', format: 'uri' },
          },
          example: {
            title: 'Clean water after flooding in Les Cayes',
            summary: 'Water storage and purification for families displaced by flooding.',
            description:
              'The September floods displaced thousands of families. This campaign funds water.',
            location: 'Les Cayes, Haiti',
            organizer: 'Haitian community association',
            category: 'water',
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              uri: { type: 'string', format: 'uri' },
            },
          },
          400: errorResponse('The metadata is invalid'),
          429: errorResponse('Too many metadata records from this client'),
        },
      },
    },
    async (req, reply) => {
      const m = body.parse(req.body);
      const id = randomUUID();
      await app.db.query(
        `INSERT INTO campaign_metadata
         (id, title, summary, description, location, organizer, category, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          m.title,
          m.summary,
          m.description,
          m.location,
          m.organizer ?? null,
          m.category ?? null,
          m.imageUrl ?? null,
        ],
      );
      return reply.code(201).send({ id, uri: `${app.config.PUBLIC_BASE_URL}/metadata/${id}` });
    },
  );

  app.get('/metadata/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rows } = await app.db.query(
      `SELECT id, title, summary, description, location, organizer, category,
              image_url AS "imageUrl",
              created_at AS "createdAt"
       FROM campaign_metadata WHERE id = $1`,
      [id],
    );
    return rows[0] ?? notFound(reply, 'metadata');
  });
}
