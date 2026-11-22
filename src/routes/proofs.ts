import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createThumbnail } from '../lib/images.js';
import { notFound, writeRateLimits } from '../lib/http.js';
import { detectMimeType, HEADER_BYTES } from '../lib/magic.js';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};
const MAX_FILES = 5;

const fieldsSchema = z.object({
  campaignId: z.coerce.bigint().nonnegative(),
  milestoneIndex: z.coerce.number().int().min(0),
  note: z.string().trim().min(10).max(2000),
});

async function readHeader(stream: Readable, size: number) {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buf);
    bytesRead += buf.length;
    if (bytesRead >= size) break;
  }
  const collected = Buffer.concat(chunks);
  return { header: collected.subarray(0, size), collected };
}

async function* withPrefix(prefix: Buffer, stream: Readable): AsyncIterable<Buffer> {
  if (prefix.length) yield prefix;
  for await (const chunk of stream) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

type ProofFile = { name: string; url: string; size: number; type: string; thumbnailUrl?: string };

function uploadsKey(id: string, name: string): string {
  return `proofs/${id}/${name}`;
}

function fileUrl(base: string, key: string): string {
  return `${base}/uploads/${key}`;
}

function toRelativePath(value: string): string | null {
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return value.replace(/^\/+/, '');
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/uploads\/(.+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeFile(file: Record<string, unknown>, base: string): ProofFile {
  const name = String(file.name ?? '');
  const type = String(file.type ?? '');
  const size = Number(file.size ?? 0);
  const urlValue = typeof file.url === 'string' ? file.url : '';
  const thumbValue = typeof file.thumbnailUrl === 'string' ? file.thumbnailUrl : '';
  const key = toRelativePath(urlValue);
  const thumbKey = toRelativePath(thumbValue);
  return {
    name,
    type,
    size,
    url: key ? fileUrl(base, key) : urlValue,
    ...(thumbKey ? { thumbnailUrl: fileUrl(base, thumbKey) } : {}),
  };
}

export async function proofRoutes(app: FastifyInstance) {
  app.post('/proofs', { config: { rateLimit: writeRateLimits.proofs } }, async (req, reply) => {
    const id = randomUUID();
    const raw: Record<string, string> = {};
    const files: ProofFile[] = [];
    const written: string[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          raw[part.fieldname] = String(part.value);
          continue;
        }
        const extension = EXTENSIONS[part.mimetype];
        if (!extension || files.length >= MAX_FILES) {
          part.file.resume();
          return reply.code(400).send({
            error: 'invalid_file',
            message: `Up to ${MAX_FILES} JPEG, PNG, WebP or PDF files are allowed`,
          });
        }

        const { header, collected } = await readHeader(part.file, HEADER_BYTES);
        if (detectMimeType(header) !== part.mimetype) {
          part.file.resume();
          return reply.code(400).send({
            error: 'invalid_file',
            message: 'File contents do not match the declared type',
          });
        }

        const body = await readAll(Readable.from(withPrefix(collected, part.file)));
        const name = `${files.length}${extension}`;
        const key = uploadsKey(id, name);
        await app.storage.put(key, body, part.mimetype);
        written.push(key);

        const file: ProofFile = {
          name: part.filename,
          type: part.mimetype,
          size: body.length,
          url: key,
        };

        if (part.mimetype.startsWith('image/')) {
          try {
            const thumb = await createThumbnail(body);
            if (thumb) {
              const thumbName = `${files.length}.thumb.png`;
              const thumbKey = uploadsKey(id, thumbName);
              await app.storage.put(thumbKey, thumb, 'image/png');
              written.push(thumbKey);
              file.thumbnailUrl = thumbKey;
            }
          } catch {
            // best effort
          }
        }

        files.push(file);
      }

      const f = fieldsSchema.parse(raw);
      if (files.length === 0) {
        return reply.code(400).send({ error: 'invalid_file', message: 'At least one file is required' });
      }

      await app.db.query(
        `INSERT INTO proofs (id, campaign_id, milestone_index, note, files) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [id, f.campaignId.toString(), f.milestoneIndex, f.note, JSON.stringify(files)],
      );

      const base = app.config.PUBLIC_BASE_URL;
      return reply.code(201).send({
        id,
        uri: `${base}/proofs/${id}`,
        files: files.map((file) => ({
          ...file,
          url: fileUrl(base, file.url),
          ...(file.thumbnailUrl ? { thumbnailUrl: fileUrl(base, file.thumbnailUrl) } : {}),
        })),
      });
    } catch (err) {
      await Promise.all(written.map((key) => app.storage.delete(key).catch(() => {})));
      throw err;
    }
  });

  app.get('/proofs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rows } = await app.db.query<{
      id: string;
      campaignId: string;
      milestoneIndex: number;
      note: string;
      files: Record<string, unknown>[] | string;
      createdAt: Date;
    }>(
      `SELECT id, campaign_id AS "campaignId", milestone_index AS "milestoneIndex", note, files,
              created_at AS "createdAt"
       FROM proofs WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return notFound(reply, 'proof');
    const rawFiles = typeof row.files === 'string' ? JSON.parse(row.files) : row.files;
    const base = app.config.PUBLIC_BASE_URL;
    return {
      ...row,
      files: (Array.isArray(rawFiles) ? rawFiles : []).map((file) =>
        normalizeFile(file as Record<string, unknown>, base),
      ),
    };
  });
}
