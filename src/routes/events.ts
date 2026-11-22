import { PassThrough } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { formatSse, type StreamEvent, type Subscriber } from '../lib/stream.js';

/** Rows fetched per replay query. Replay pages through the backlog, so there is no gap. */
const REPLAY_BATCH = 500;

// Event ids are zero padded "ledger-index" strings, so text order is commit order.
// `$1` is the resume point (exclusive), `$2` the optional campaign filter, `$3` the batch size.
const REPLAY_SQL = `
SELECT id, event, "campaignId", actor, amount, "milestoneIndex", "txHash", "createdAt" FROM (
  SELECT event_id AS id, 'donation' AS event, campaign_id::text AS "campaignId", donor AS actor,
         amount::text AS amount, NULL::integer AS "milestoneIndex", tx_hash AS "txHash", created_at AS "createdAt"
  FROM donations WHERE event_id > $1 AND ($2::bigint IS NULL OR campaign_id = $2)
  UNION ALL
  SELECT event_id, 'refund', campaign_id::text, donor, amount::text, NULL::integer, tx_hash, created_at
  FROM refunds WHERE event_id > $1 AND ($2::bigint IS NULL OR campaign_id = $2)
  UNION ALL
  SELECT event_id, 'release', campaign_id::text, NULL, amount::text, index, tx_hash, created_at
  FROM milestone_releases WHERE event_id > $1 AND ($2::bigint IS NULL OR campaign_id = $2)
  UNION ALL
  SELECT created_event_id, 'campaign_created', id::text, NULL, NULL, NULL, NULL, created_at
  FROM campaigns WHERE created_event_id > $1 AND ($2::bigint IS NULL OR id = $2)
) e
ORDER BY id ASC
LIMIT $3`;

const query = z.object({
  campaignId: z.coerce.bigint().optional(),
});

export async function eventRoutes(app: FastifyInstance) {
  /**
   * GET /events
   *
   * Server-Sent Events stream of donations, releases, refunds and campaign
   * creations, sent as the indexer commits them. Optional `campaignId` filter.
   * Each message's `id` is the chain event id. A client that reconnects with
   * `Last-Event-ID` first receives the events it missed, then live ones.
   */
  app.get('/events', async (req, reply) => {
    const q = query.parse(req.query);
    const hub = app.streams;

    if (hub.isFull()) {
      return reply
        .code(503)
        .header('retry-after', '5')
        .send({ error: 'too_many_streams', message: 'Too many open event streams' });
    }

    const campaignId = q.campaignId?.toString() ?? null;
    const lastEventId =
      typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : '';
    const out = new PassThrough();

    let closed = false;
    const send = (ev: StreamEvent) => {
      if (!closed) out.write(formatSse(ev));
    };

    // While replaying, live events are held back. Afterwards, any held event at
    // or below `replayedUpTo` was already sent by the replay, so it is skipped.
    let replaying = true;
    let replayedUpTo = lastEventId;
    const waiting: StreamEvent[] = [];

    const sub: Subscriber = {
      campaignId,
      deliver: (ev) => (replaying ? waiting.push(ev) : send(ev)),
      close: () => close(),
    };
    const heartbeat = setInterval(
      () => out.write(': heartbeat\n\n'),
      app.config.STREAM_HEARTBEAT_MS,
    );
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      hub.remove(sub);
      out.end();
    }

    // Subscribe before replaying. An event committed during the replay is then
    // either found by the replay query or delivered live, and never missed.
    hub.add(sub);
    reply.raw.on('close', close);

    reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-accel-buffering', 'no');
    out.write('retry: 5000\n\n');
    reply.send(out);

    try {
      let cursor = lastEventId;
      while (lastEventId && !closed) {
        const { rows } = await app.db.query<{
          id: string;
          event: StreamEvent['event'];
          campaignId: string;
          actor: string | null;
          amount: string | null;
          milestoneIndex: number | null;
          txHash: string | null;
          createdAt: Date;
        }>(REPLAY_SQL, [cursor, campaignId, REPLAY_BATCH]);
        for (const row of rows) {
          send({ ...row, createdAt: row.createdAt.toISOString() });
          replayedUpTo = row.id;
        }
        if (rows.length < REPLAY_BATCH) break;
        cursor = rows[rows.length - 1]!.id;
      }
    } catch (err) {
      req.log.error({ err }, 'event stream replay failed');
      close();
      return reply;
    }

    replaying = false;
    for (const ev of waiting.splice(0)) {
      if (ev.id > replayedUpTo) send(ev);
    }
    return reply;
  });

  // Ends open streams before the server stops accepting connections, so shutdown does not hang on them.
  app.addHook('preClose', async () => app.streams.closeAll());
}
