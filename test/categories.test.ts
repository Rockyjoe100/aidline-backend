import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { CATEGORIES } from '../src/lib/categories.js';
import type { Db } from '../src/db/pool.js';
import { resetDb, setupApp } from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };

const validBody = {
  title: 'Flood relief in Lagos',
  summary: 'Emergency shelter and clean water',
  description: 'Funds for shelter, clean water and food for families affected by the flood.',
  location: 'Lagos',
};

describe('campaign categories', () => {
  beforeEach(() => resetDb(db));
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('GET /categories returns the fixed list', async () => {
    const res = await app.inject({ url: '/categories' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [...CATEGORIES] });
    expect(res.json().items).toContain('flood');
  });

  it('POST /metadata accepts a category from the list', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/metadata',
      payload: { ...validBody, category: 'flood' },
    });
    expect(res.statusCode).toBe(201);
    const meta = await app.inject({ url: `/metadata/${res.json().id}` });
    expect(meta.json().category).toBe('flood');
  });

  it('POST /metadata rejects a category outside the list', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/metadata',
      payload: { ...validBody, category: 'Floods!!' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('GET /metadata/:id still returns free text stored before the list existed', async () => {
    const id = '3f1c8c2e-6b1a-4e0b-9d5a-2f0c1b7a9e11';
    await db.query(
      `INSERT INTO campaign_metadata (id, title, summary, description, location, category)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        validBody.title,
        validBody.summary,
        validBody.description,
        validBody.location,
        'My own words',
      ],
    );
    const res = await app.inject({ url: `/metadata/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().category).toBe('My own words');
  });
});
