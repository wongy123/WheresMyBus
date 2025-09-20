import bcrypt from 'bcrypt';
import { pool, updateUserPassword, deleteUser } from '../models/db.js';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../lib/s3Client.js';

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

export async function me(req, res) {
  // req.user is set by requireAuth
  // fetch minimal info from DB to include created_at
  const { rows } = await pool.query(
    'SELECT username, role, created_at FROM users WHERE username = $1',
    [req.user.username]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  return res.json(rows[0]);
}

export async function updateMe(req, res) {
  return res.status(400).json({ error: 'use_cognito_change_password' });
}

export async function deleteMe(req, res) {
  try {
    // best-effort: remove user-owned S3 objects before user deletion
    const { rows } = await pool.query(
      'SELECT bucket, s3_key FROM stop_image WHERE user_id = $1',
      [req.user.username]
    );

    await Promise.all(rows.map(async r => {
      if (!r.bucket || !r.s3_key) return;
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: r.bucket, Key: r.s3_key }));
      } catch (_) {
        // ignore missing/denied; user deletion should proceed
      }
    }));

    await deleteUser(req.user.username);
    return res.status(204).send();
  } catch (e) {
    console.error('deleteMe:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}
