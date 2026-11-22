import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { csvDocument, csvRow } from '../lib/csv.js';
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
  });

  /**
   * GET /donors/:address/export.csv
   *
   * Donations and refunds for one donor, oldest first. Uses the same CSV helpers
   * as the campaign export, so titles containing commas or quotes stay intact.
   */
  app.get('/donors/:address/export.csv', async (req, reply) => {
    const { address } = z.object({ address: stellarAddress }).parse(req.params);
    const { rows } = await app.db.query<{
      type: string;
      createdAt: Date;
      campaignId: string;
      campaignTitle: string | null;
      amount: string;
      txHash: string;
      eventId: string;
    }>(
      `SELECT type, "createdAt", "campaignId", "campaignTitle", amount, "txHash", "eventId" FROM (
         SELECT 'donation' AS type, d.created_at AS "createdAt", d.campaign_id::text AS "campaignId",
                m.title AS "campaignTitle", d.amount::text AS amount, d.tx_hash AS "txHash", d.event_id AS "eventId"
         FROM donations d
         JOIN campaigns c ON c.id = d.campaign_id
         LEFT JOIN campaign_metadata m ON m.id = c.metadata_id
         WHERE d.donor = $1
         UNION ALL
         SELECT 'refund', r.created_at, r.campaign_id::text, m.title, r.amount::text, r.tx_hash, r.event_id
         FROM refunds r
         JOIN campaigns c ON c.id = r.campaign_id
         LEFT JOIN campaign_metadata m ON m.id = c.metadata_id
         WHERE r.donor = $1
       ) h ORDER BY "createdAt" ASC, "eventId" ASC`,
      [address],
    );

    const lines = rows.map((row) =>
      csvRow([
        row.type,
        row.createdAt.toISOString(),
        row.campaignId,
        row.campaignTitle,
        row.amount,
        row.txHash,
      ]),
    );
    const csv = csvDocument('type,createdAt,campaignId,campaignTitle,amount,txHash', lines);

    return reply
      .code(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="donor-${address}.csv"`)
      .send(csv);
  });
}
