import type { AidlineEvent } from '../stellar/events.js';

/**
 * One item on GET /events. `id` is the on chain event id, so it sorts in commit
 * order and a client can resume with Last-Event-ID.
 */
export interface StreamEvent {
  id: string;
  event: 'donation' | 'refund' | 'release' | 'campaign_created';
  campaignId: string;
  actor: string | null;
  amount: string | null;
  milestoneIndex: number | null;
  txHash: string | null;
  createdAt: string;
}

/** Maps an indexed event to a stream item. Other event types are not streamed. */
export function toStreamEvent(ev: AidlineEvent): StreamEvent | null {
  const campaignId = 'campaignId' in ev ? ev.campaignId.toString() : '';
  const base = { id: ev.eventId, campaignId, createdAt: ev.closedAt.toISOString() };
  switch (ev.type) {
    case 'donated':
      return {
        ...base,
        event: 'donation',
        actor: ev.donor,
        amount: ev.amount.toString(),
        milestoneIndex: null,
        txHash: ev.txHash,
      };
    case 'refunded':
      return {
        ...base,
        event: 'refund',
        actor: ev.donor,
        amount: ev.amount.toString(),
        milestoneIndex: null,
        txHash: ev.txHash,
      };
    case 'milestone_released':
      return {
        ...base,
        event: 'release',
        actor: null,
        amount: ev.amount.toString(),
        milestoneIndex: ev.index,
        txHash: ev.txHash,
      };
    case 'campaign_created':
      // Matches the replay query, which has no transaction hash for campaigns.
      return {
        ...base,
        event: 'campaign_created',
        actor: null,
        amount: null,
        milestoneIndex: null,
        txHash: null,
      };
    default:
      return null;
  }
}

/** Serialises one item as a Server-Sent Events message. */
export function formatSse(ev: StreamEvent): string {
  const { id, event, ...data } = ev;
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A connected client. `deliver` receives only items that match its campaign filter. */
export interface Subscriber {
  campaignId: string | null;
  deliver(ev: StreamEvent): void;
  close(): void;
}

/**
 * Fans committed events out to open streams, in this process only. The
 * indexer runs in the same process as the API, so no broker is needed.
 */
export class EventStreamHub {
  private readonly subscribers = new Set<Subscriber>();

  constructor(private readonly maxStreams: number) {}

  get size(): number {
    return this.subscribers.size;
  }

  isFull(): boolean {
    return this.subscribers.size >= this.maxStreams;
  }

  add(sub: Subscriber): void {
    this.subscribers.add(sub);
  }

  remove(sub: Subscriber): void {
    this.subscribers.delete(sub);
  }

  /** Called after the indexer commits events. Other event types are skipped. */
  publish(events: AidlineEvent[]): void {
    for (const ev of events) {
      const item = toStreamEvent(ev);
      if (!item) continue;
      for (const sub of this.subscribers) {
        if (sub.campaignId !== null && sub.campaignId !== item.campaignId) continue;
        sub.deliver(item);
      }
    }
  }

  /** Ends every open stream. Called on shutdown so the server can close. */
  closeAll(): void {
    for (const sub of [...this.subscribers]) sub.close();
    this.subscribers.clear();
  }
}
