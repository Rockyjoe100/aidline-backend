import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { pagination, stellarAddress } from '../lib/http.js';
import { amount, nullableString, paginationQuery } from '../lib/openapi.js';

const donorSchema = {
  type: 'object',
  properties: {
    address: { type: 'string' },
    totalDonated: amount,
    campaignsSupported: { type: 'integer' },
    donations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          campaignId: { type: 'string' },
          amount,
          txHash: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          campaignTitle: nullableString,
          kind: { type: 'string', enum: ['emergency', 'climate'] },
          goal: amount,
          released: amount,
          raised: amount,
        },
      },
    },
    refunds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          campaignId: { type: 'string' },
          amount,
          txHash: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    pledges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pledgeId: { type: 'string' },
          campaignId: { type: 'string' },
          pledgedAmount: amount,
          pulledAmount: amount,
          status: { type: 'string', enum: ['active', 'pulled', 'skipped', 'settled'] },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
} as const;

export async function donorRoutes(app: FastifyInstance) {
  app.get(
    '/donors/:address',
    {
      schema: {
        tags: ['donors'],
        summary: "A donor's totals, donations, refunds and pledges",
        querystring: paginationQuery,
        response: { 200: donorSchema },
      },
    },
    async (req) => {
      const { address } = z.object({ address: stellarAddress }).parse(req.params);
      const q = pagination.parse(req.query);

      const [summary, pledges, donations, refunds] = await Promise.all([
        app.db.query(
          `SELECT COALESCE(sum(amount), 0) AS "totalDonated",
                count(DISTINCT campaign_id)::int AS "campaignsSupported"
         FROM donations WHERE donor = $1`,
          [address],
        ),
        app.db.query(
          `SELECT pledge_id AS "pledgeId", campaign_id AS "campaignId", pledged_amount AS "pledgedAmount", pulled_amount AS "pulledAmount", status, updated_at AS "updatedAt" FROM pledges WHERE donor=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
          [address, q.limit, q.offset],
        ),
        app.db.query(
          `SELECT d.campaign_id AS "campaignId", d.amount, d.tx_hash AS "txHash",
                d.created_at AS "createdAt", m.title AS "campaignTitle", c.kind,
                c.goal, c.released, c.raised
         FROM donations d
         JOIN campaigns c ON c.id = d.campaign_id
         LEFT JOIN campaign_metadata m ON m.id = c.metadata_id
         WHERE d.donor = $1
         ORDER BY d.created_at DESC LIMIT $2 OFFSET $3`,
          [address, q.limit, q.offset],
        ),
        app.db.query(
          `SELECT campaign_id AS "campaignId", amount, tx_hash AS "txHash", created_at AS "createdAt"
         FROM refunds WHERE donor = $1 ORDER BY created_at DESC`,
          [address],
        ),
      ]);

      return {
        address,
        ...summary.rows[0],
        donations: donations.rows,
        refunds: refunds.rows,
        pledges: pledges.rows,
      };
    },
  );
}
