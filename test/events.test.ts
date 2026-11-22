import { xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { decodeEvent } from '../src/stellar/events.js';
import { account, events } from './helpers.js';

describe('decodeEvent', () => {
  it('decodes a donation', () => {
    const donor = account();
    const ev = decodeEvent(events.donated(7n, donor, 2500n));
    expect(ev).toMatchObject({ type: 'donated', campaignId: 7n, donor, amount: 2500n });
  });

  it('decodes a milestone release with its proof', () => {
    const ev = decodeEvent(events.released(1n, 2, 400n, 'http://api.test/proofs/x'));
    expect(ev).toMatchObject({
      type: 'milestone_released',
      campaignId: 1n,
      index: 2,
      amount: 400n,
      proofUri: 'http://api.test/proofs/x',
    });
  });

  it('decodes verifier updates', () => {
    const v = account();
    expect(decodeEvent(events.verifier(v, false))).toMatchObject({
      type: 'verifier_updated',
      verifier: v,
      active: false,
    });
  });

  it('ignores unknown events', () => {
    const raw = events.donated(1n, account(), 1n);
    raw.topic[0] = xdr.ScVal.scvSymbol('something_new');
    expect(decodeEvent(raw)).toBeNull();
  });

  it('returns null for an unknown topic whatever its data holds', () => {
    const raw = {
      ...events.refunded(1n, account(), 5n),
      topic: [xdr.ScVal.scvSymbol('something_new')],
    };
    expect(decodeEvent(raw)).toBeNull();
  });

  it('throws rather than inventing an amount when a refund has no amount', () => {
    const raw = { ...events.refunded(1n, account(), 5n), value: xdr.ScVal.scvMap([]) };
    expect(() => decodeEvent(raw)).toThrow(TypeError);
  });

  it('throws when a donation amount is text instead of an integer', () => {
    const raw = { ...events.donated(1n, account(), 1n), value: xdr.ScVal.scvString('lots') };
    expect(() => decodeEvent(raw)).toThrow(SyntaxError);
  });

  it('throws when a campaign id topic is not an integer', () => {
    const raw = {
      ...events.donated(1n, account(), 1n),
      topic: [xdr.ScVal.scvSymbol('donated'), xdr.ScVal.scvSymbol('abc')],
    };
    expect(() => decodeEvent(raw)).toThrow(SyntaxError);
  });
});
