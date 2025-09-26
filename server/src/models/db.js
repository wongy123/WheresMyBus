// server/src/models/db.js
import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSecretJson } from '../lib/secrets.js';

// ---------- Resolve DB config (Secrets Manager first, then env) ----------
const SECRET_ID = process.env.DB_SECRET_ID || 'n11941073/assessment02/db';

// build a config object from secret (if present) with env overrides
async function resolveDbConfig() {
  let fromSecret = {};
  try {
    // If DATABASE_URL is set, pg will use it and ignore the rest; we still return a baseline object.
    if (!process.env.DATABASE_URL) {
      fromSecret = await getSecretJson(SECRET_ID);
      console.log('[db] loaded DB config from Secrets Manager:', SECRET_ID);
    } else {
      console.log('[db] using DATABASE_URL from environment');
    }
  } catch (e) {
    console.warn('[db] could not load secret; falling back to env vars:', e?.message || e);
  }

  // merge: env overrides > secret > sane defaults
  return {
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.PGHOST || fromSecret.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || fromSecret.PGPORT || 5432),
    user: process.env.PGUSER || fromSecret.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || fromSecret.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || fromSecret.PGDATABASE || 'wheresmybus',
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    ssl: parseSslFromEnv(), // optional SSL support for RDS
  };
}

function parseSslFromEnv() {
  const v = (process.env.PGSSL || '').toLowerCase();
  // For RDS, you usually want SSL: PGSSL=true (or leave unset if your RDS forces SSL anyway).
  if (v === 'true' || v === '1' || v === 'require') return { rejectUnauthorized: false };
  return undefined;
}

// ----- Connection pool -----
// ESM supports top-level await in Node >= 18.
const DB_CONFIG = await resolveDbConfig();
export const pool = new Pool(DB_CONFIG);

pool.on('error', (err) => {
  console.error('[pg] unexpected idle client error:', err);
});

// ----- Schema bootstrap (idempotent) -----
// No local users table. user_id columns store Cognito `sub`.
export async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // stop_image
    await client.query(`
      CREATE TABLE IF NOT EXISTS stop_image (
        image_id      UUID PRIMARY KEY,
        stop_id       TEXT NOT NULL,
        user_id       TEXT NOT NULL,     -- Cognito sub
        bucket        TEXT NOT NULL,
        s3_key        TEXT NOT NULL,
        content_type  TEXT,
        size_bytes    BIGINT,
        etag          TEXT,
        uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS stop_image_stop_id_idx ON stop_image(stop_id);
      CREATE INDEX IF NOT EXISTS stop_image_user_id_idx ON stop_image(user_id);
    `);

    // stop_review
    await client.query(`
      CREATE TABLE IF NOT EXISTS stop_review (
        stop_id     TEXT NOT NULL,
        user_id     TEXT NOT NULL,       -- Cognito sub
        rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment     TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ,
        PRIMARY KEY (user_id, stop_id)
      );

      CREATE INDEX IF NOT EXISTS idx_stop_review_stop  ON stop_review (stop_id);
      CREATE INDEX IF NOT EXISTS idx_stop_review_user  ON stop_review (user_id);
    `);

    await client.query('COMMIT');
    console.log('[pg] schema ready');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[pg] initSchema failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One-time migration:
 *  - Drop FKs to users (if they exist)
 *  - Drop users table (if it exists)
 *
 * This will NOT rewrite existing user_id values.
 */
export async function runOneTimeMigration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`ALTER TABLE stop_image  DROP CONSTRAINT IF EXISTS stop_image_user_id_fkey;`);
    await client.query(`ALTER TABLE stop_review DROP CONSTRAINT IF EXISTS stop_review_user_id_fkey;`);
    await client.query(`DROP TABLE IF EXISTS users;`);

    await client.query('COMMIT');
    console.log('[pg] one-time migration complete: removed users table and FKs');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[pg] one-time migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

// ----- Stop Images -----
export async function insertStopImage({
  stop_id,
  user_id,           // Cognito sub
  bucket,
  s3_key,
  content_type,
  size_bytes = null,
  etag = null,
}) {
  const image_id = randomUUID();
  const q = `
    INSERT INTO stop_image (image_id, stop_id, user_id, bucket, s3_key, content_type, size_bytes, etag)
    VALUES ($1,        $2,      $3,     $4,     $5,     $6,           $7,        $8)
    RETURNING image_id, stop_id, user_id, bucket, s3_key, content_type, size_bytes, etag, uploaded_at
  `;
  const { rows } = await pool.query(q, [
    image_id,
    stop_id,
    user_id,
    bucket,
    s3_key,
    content_type,
    size_bytes,
    etag,
  ]);
  return rows[0];
}

export async function listStopImagesByStop(stop_id, { page = 1, limit = 20 } = {}) {
  const p = Math.max(1, Number(page));
  const l = Math.max(1, Math.min(100, Number(limit)));
  const off = (p - 1) * l;

  const dataQ = `
    SELECT image_id, stop_id, user_id, bucket, s3_key, content_type, size_bytes, etag, uploaded_at
    FROM stop_image
    WHERE stop_id = $1
    ORDER BY uploaded_at DESC
    LIMIT $2 OFFSET $3
  `;
  const countQ = `SELECT COUNT(*)::int AS count FROM stop_image WHERE stop_id = $1`;

  const [{ rows: items }, { rows: c }] = await Promise.all([
    pool.query(dataQ, [stop_id, l, off]),
    pool.query(countQ, [stop_id]),
  ]);

  return { items, page: p, limit: l, total: c[0].count };
}

export async function deleteStopImage(stop_id, image_id, user_id, isAdmin = false) {
  const cond = isAdmin
    ? `stop_id = $1 AND image_id = $2`
    : `stop_id = $1 AND image_id = $2 AND user_id = $3`;

  const params = isAdmin ? [stop_id, image_id] : [stop_id, image_id, user_id];

  const { rows } = await pool.query(
    `DELETE FROM stop_image WHERE ${cond} RETURNING image_id`,
    params
  );
  return !!rows[0];
}

// ----- Stop Reviews -----
export async function upsertStopReview({ stop_id, user_id, rating, comment }) {
  const q = `
    INSERT INTO stop_review (stop_id, user_id, rating, comment)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, stop_id)
    DO UPDATE SET
      rating = EXCLUDED.rating,
      comment = EXCLUDED.comment,
      updated_at = now()
    RETURNING stop_id, user_id, rating, comment, created_at, updated_at
  `;
  const { rows } = await pool.query(q, [stop_id, user_id, rating, comment ?? null]);
  return rows[0];
}

export async function getMyStopReview(stop_id, user_id) {
  const { rows } = await pool.query(
    'SELECT stop_id, user_id, rating, comment, created_at, updated_at FROM stop_review WHERE stop_id = $1 AND user_id = $2',
    [stop_id, user_id]
  );
  return rows[0] || null;
}

export async function listStopReviews(stop_id, { limit = 20, page = 1, sort = 'recent' } = {}) {
  const l = Math.max(1, Math.min(100, Number(limit)));
  const p = Math.max(1, Number(page));
  const off = (p - 1) * l;
  const orderBy =
    sort === 'rating' ? 'rating DESC, created_at DESC' : 'COALESCE(updated_at, created_at) DESC';

  const q = `
    SELECT stop_id, user_id, rating, comment, created_at, updated_at
    FROM stop_review
    WHERE stop_id = $1
    ORDER BY ${orderBy}
    LIMIT $2 OFFSET $3
  `;
  const { rows: items } = await pool.query(q, [stop_id, l, off]);
  const { rows: c } = await pool.query('SELECT COUNT(*)::int AS count FROM stop_review WHERE stop_id = $1', [stop_id]);

  return { items, page: p, limit: l, total: c[0].count };
}

export async function deleteMyStopReview(stop_id, user_id) {
  const { rowCount } = await pool.query(
    'DELETE FROM stop_review WHERE stop_id = $1 AND user_id = $2',
    [stop_id, user_id]
  );
  return rowCount > 0;
}

export async function getStopRatingSummary(stop_id) {
  const { rows } = await pool.query(
    `SELECT
       ROUND(AVG(rating)::numeric, 2) AS avg_rating,
       COUNT(*)::int                AS ratings_count
     FROM stop_review
     WHERE stop_id = $1`,
    [stop_id]
  );
  return rows[0];
}

// ----- CLI: run one-time migration + ensure schema -----
export async function main() {
  try {
    await runOneTimeMigration();
    await initSchema();
  } finally {
    await pool.end().catch(() => {});
  }
}

// Execute when run directly: `node server/src/models/db.js`
const isDirectRun = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return thisFile === entry;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main()
    .then(() => {
      console.log('[pg] migration + schema done');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[pg] fatal error:', err);
      process.exit(1);
    });
}
