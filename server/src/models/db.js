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
        image_id      UUID PRIMARY KEY,
        stop_id       TEXT NOT NULL,
        user_id       TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        filename      TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_stop_image_stop   ON stop_image (stop_id);
      CREATE INDEX IF NOT EXISTS idx_stop_image_user   ON stop_image (user_id, stop_id);
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
export async function insertStopImage({ stop_id, user_id, filename, mime_type }) {
  const image_id = randomUUID();
  const q = `
    INSERT INTO stop_image (image_id, stop_id, user_id, filename, mime_type)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING image_id, stop_id, user_id, filename, mime_type, uploaded_at
  `;
  const { rows } = await pool.query(q, [image_id, stop_id, user_id, filename, mime_type]);
  return rows[0];
}

export async function listStopImagesByStop(stop_id, { limit = 20, page = 1 } = {}) {
  const off = (Math.max(1, page) - 1) * Math.max(1, limit);
  const q = `
    SELECT image_id, stop_id, user_id, filename, mime_type, uploaded_at
    FROM stop_image
    WHERE stop_id = $1
    ORDER BY uploaded_at DESC
    LIMIT $2 OFFSET $3
  `;
  const { rows } = await pool.query(q, [stop_id, limit, off]);

  const { rows: c } = await pool.query('SELECT COUNT(*)::int AS count FROM stop_image WHERE stop_id = $1', [stop_id]);
  return { items: rows, page, limit, total: c[0].count };
}

export async function deleteStopImage(stop_id, image_id, requestingUser, isAdmin = false) {
  // Only owner or admin can delete
  const { rows } = await pool.query(
    'SELECT user_id FROM stop_image WHERE stop_id = $1 AND image_id = $2',
    [stop_id, image_id]
  );
  const row = rows[0];
  if (!row) return false;
  if (!isAdmin && row.user_id !== requestingUser) return false;

  await pool.query('DELETE FROM stop_image WHERE image_id = $1', [image_id]);
  return true;
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
