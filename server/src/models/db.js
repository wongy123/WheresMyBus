// server/src/models/db.js
import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

// ----- Connection pool -----
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // optional, overrides fields below
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'wheresmybus',
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[pg] unexpected idle client error:', err);
});

// ----- Schema bootstrap (idempotent) -----
export async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`); // for gen_random_uuid()

    // users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        username      TEXT PRIMARY KEY,
        password      TEXT NOT NULL,               -- store HASH here (argon2/bcrypt)
        role          TEXT NOT NULL DEFAULT 'user',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // stop_image
    await client.query(`
      CREATE TABLE IF NOT EXISTS stop_image (
        image_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        stop_id       TEXT NOT NULL,
        user_id       TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
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
        user_id     TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
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

// ----- Users -----
export async function createUser({ username, passwordHash, role = 'user' }) {
  const q = `
    INSERT INTO users (username, password, role)
    VALUES ($1, $2, $3)
    RETURNING username, role, created_at
  `;
  const { rows } = await pool.query(q, [username, passwordHash, role]);
  return rows[0];
}

export async function getUserByUsername(username) {
  const { rows } = await pool.query(
    'SELECT username, password, role, created_at FROM users WHERE username = $1',
    [username]
  );
  return rows[0] || null;
}

export async function updateUserPassword(username, newPasswordHash) {
  const { rows } = await pool.query(
    'UPDATE users SET password = $2 WHERE username = $1 RETURNING username, role, created_at',
    [username, newPasswordHash]
  );
  return rows[0] || null;
}

export async function deleteUser(username) {
  await pool.query('DELETE FROM users WHERE username = $1', [username]);
}

// ----- Stop Images -----
export async function insertStopImage({ stop_id, user_id, bucket, s3_key, content_type, size_bytes = null, etag = null }) {
  const q = `
    INSERT INTO stop_image (stop_id, user_id, bucket, s3_key, content_type, size_bytes, etag)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING image_id, stop_id, user_id, bucket, s3_key, content_type, size_bytes, etag, uploaded_at
  `;
  const { rows } = await pool.query(q, [stop_id, user_id, bucket, s3_key, content_type, size_bytes, etag]);
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

export async function deleteStopImage(stop_id, image_id, username, isAdmin = false) {
  // Only owner or admin can delete
  const cond = isAdmin
    ? `stop_id = $1 AND image_id = $2`
    : `stop_id = $1 AND image_id = $2 AND user_id = $3`;

  const params = isAdmin ? [stop_id, image_id] : [stop_id, image_id, username];

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
  const off = (Math.max(1, page) - 1) * Math.max(1, limit);
  const orderBy =
    sort === 'rating' ? 'rating DESC, created_at DESC' : 'COALESCE(updated_at, created_at) DESC';

  const q = `
    SELECT stop_id, user_id, rating, comment, created_at, updated_at
    FROM stop_review
    WHERE stop_id = $1
    ORDER BY ${orderBy}
    LIMIT $2 OFFSET $3
  `;
  const { rows } = await pool.query(q, [stop_id, limit, off]);
  const { rows: c } = await pool.query('SELECT COUNT(*)::int AS count FROM stop_review WHERE stop_id = $1', [stop_id]);

  return { items: rows, page, limit, total: c[0].count };
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
  // rows[0].avg_rating will be null when count = 0 (which is fine)
  return rows[0];
}