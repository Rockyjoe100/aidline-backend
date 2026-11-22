import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { Indexer } from '../src/indexer/indexer.js';
import type { ChainCampaign } from '../src/stellar/contract.js';
import { account, chainCampaign, CONTRACT_ID, events, resetDb, setupApp } from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };

async function index(campaign: ChainCampaign, raw: ReturnType<typeof events.donated>[]) {
  const pages = [raw];
  const indexer = new Indexer({
    db,
    contractId: CONTRACT_ID,
    pollMs: 1000,
    log: app.log,
    source: {
      getEvents: async () =>
        ({ events: pages.shift() ?? [], cursor: 'c', latestLedger: 1 }) as never,
      getHealth: async () => ({ oldestLedger: 1, latestLedger: 1 }),
    },
    contract: { getCampaign: async () => campaign },
  });
  await indexer.syncOnce();
}

describe('GET /donors/:address/export.csv', () => {
  beforeEach(() => resetDb(db));
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('returns donations and refunds with campaign context as CSV', async () => {
    const donor = account();
    const campaign = chainCampaign({ raised: 500n });
    await index(campaign, [
      events.created(0n, campaign.creator),
      events.donated(0n, donor, 500n),
      events.refunded(0n, donor, 50n),
    ]);

    const res = await app.inject({ url: `/donors/${donor}/export.csv` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(new RegExp(`donor-${donor}\\.csv`));

    const lines = res.body.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('type,createdAt,campaignId,campaignTitle,amount,txHash');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^donation,\S+,0,,500,tx\d+/);
    expect(lines[2]).toMatch(/^refund,\S+,0,,50,tx\d+/);
  });

  it('quotes campaign titles that contain commas and quotes', async () => {
    const donor = account();
    const campaign = chainCampaign({ raised: 500n });
    await index(campaign, [events.created(0n, campaign.creator), events.donated(0n, donor, 500n)]);
    const metadataId = randomUUID();
    await db.query(
      `INSERT INTO campaign_metadata (id, title, summary, description, location)
       VALUES ($1, $2, 'A short summary', 'A description long enough to pass checks', 'Lagos')`,
      [metadataId, 'Flood, "relief" fund'],
    );
    await db.query('UPDATE campaigns SET metadata_id = $1 WHERE id = 0', [metadataId]);

    const res = await app.inject({ url: `/donors/${donor}/export.csv` });
    const lines = res.body.split('\r\n').filter((l) => l.length > 0);
    expect(lines[1]).toContain(',0,"Flood, ""relief"" fund",500,');
  });

  it('returns only the header for a donor with no history', async () => {
    const res = await app.inject({ url: `/donors/${account()}/export.csv` });
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\r\n').filter((l) => l.length > 0)).toEqual([
      'type,createdAt,campaignId,campaignTitle,amount,txHash',
    ]);
  });

  it('rejects an invalid address', async () => {
    const res = await app.inject({ url: '/donors/not-an-address/export.csv' });
    expect(res.statusCode).toBe(400);
  });
});
