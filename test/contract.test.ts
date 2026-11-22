import { Account, contract } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { parseCampaign } from '../src/stellar/contract.js';

describe('AidlineContract', () => {
  it('uses a valid placeholder account for simulations', () => {
    expect(() => new Account(contract.NULL_ACCOUNT, '0')).not.toThrow();
  });

  it('parses a campaign as returned by scValToNative', () => {
    const c = parseCampaign({
      id: 3n,
      creator: 'GC',
      beneficiary: 'GB',
      verifier: 'GV',
      kind: ['Climate'],
      metadata_uri: 'ipfs://x',
      goal: 500n,
      deadline: 1700000000n,
      milestones: [200n, 300n],
      milestones_released: 1,
      raised: 500n,
      released: 200n,
      status: ['Active'],
    });
    expect(c).toMatchObject({
      id: 3n,
      kind: 'climate',
      status: 'active',
      milestones: [200n, 300n],
    });
  });
});

describe('parseCampaign', () => {
  const raw = {
    id: 3n,
    creator: 'GC',
    beneficiary: 'GB',
    verifier: 'GV',
    kind: ['Emergency'],
    metadata_uri: 'ipfs://x',
    goal: 500n,
    deadline: 1700000000n,
    milestones: [200n, 300n],
    milestones_released: 0,
    raised: 500n,
    released: 0n,
    status: ['Active'],
  };

  it.each([
    ['Emergency', 'emergency'],
    ['Climate', 'climate'],
  ])('reads the unit variant %s as the kind %s when it is an array', (name, expected) => {
    expect(parseCampaign({ ...raw, kind: [name] }).kind).toBe(expected);
  });

  it.each([
    ['Active', 'active'],
    ['Completed', 'completed'],
    ['Cancelled', 'cancelled'],
  ])('reads the status %s as %s when it is an array', (name, expected) => {
    expect(parseCampaign({ ...raw, status: [name] }).status).toBe(expected);
  });

  it.each([
    ['Emergency', 'emergency'],
    ['Climate', 'climate'],
  ])('reads the kind %s as %s when it is a plain string', (name, expected) => {
    expect(parseCampaign({ ...raw, kind: name }).kind).toBe(expected);
  });

  it.each([
    ['Active', 'active'],
    ['Completed', 'completed'],
    ['Cancelled', 'cancelled'],
  ])('reads the status %s as %s when it is a plain string', (name, expected) => {
    expect(parseCampaign({ ...raw, status: name }).status).toBe(expected);
  });

  it('keeps bigint amounts above Number.MAX_SAFE_INTEGER exact', () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 12345n;
    const c = parseCampaign({
      ...raw,
      goal: big * 1000n,
      deadline: big,
      milestones: [big, 1n],
      raised: big + 1n,
      released: big - 1n,
    });
    expect(c.goal).toBe(big * 1000n);
    expect(c.deadline).toBe(big);
    expect(c.milestones).toEqual([big, 1n]);
    expect(c.raised).toBe(big + 1n);
    expect(c.released).toBe(big - 1n);
  });
});
