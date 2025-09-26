// src/controllers/account.controller.js
import { pool } from '../models/db.js';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../lib/s3Client.js';

// GET /api/me
export async function me(req, res) {
  // req.user is set by requireAuth
  const out = {
    id: req.user.id,
    username: req.user.username ?? null,
    email: req.user.email ?? null,
    role: req.user.role,
    groups: req.user.groups ?? [],
    issued_at: req.user.jwt?.iat ? new Date(req.user.jwt.iat * 1000).toISOString() : null,
  };
  return res.json(out);
}

// POST /api/me (not supported here)
export async function updateMe(_req, res) {
  return res.status(400).json({ error: 'use_cognito_change_password' });
}

// DELETE /api/me  -> purge user-generated content (not Cognito account)
export async function deleteMe(req, res) {
  try {
    // best-effort: remove user-owned S3 objects before DB deletion
    const { rows } = await pool.query(
      'SELECT bucket, s3_key FROM stop_image WHERE user_id = $1',
      [req.user.id] // <-- use sub
    );

    await Promise.all(rows.map(async r => {
      if (!r.bucket || !r.s3_key) return;
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: r.bucket, Key: r.s3_key }));
      } catch (_) {}
    }));

    // Remove DB rows for this user
    await pool.query('DELETE FROM stop_image WHERE user_id = $1', [req.user.id]);
    await pool.query('DELETE FROM stop_review WHERE user_id = $1', [req.user.id]);

    return res.status(204).send();
  } catch (e) {
    console.error('deleteMe:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}
