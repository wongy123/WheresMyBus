import bcrypt from 'bcrypt';
import { pool, updateUserPassword, deleteUser } from '../models/db.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');

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
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const updated = await updateUserPassword(req.user.username, hash);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    return res.json(updated);
  } catch (e) {
    console.error('updateMe:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}

export async function deleteMe(req, res) {
  try {
    // best-effort: remove user-owned files from disk before DB cascade
    const { rows } = await pool.query(
      'SELECT filename FROM stop_image WHERE user_id = $1',
      [req.user.username]
    );
    await Promise.all(rows.map(async r => {
      try {
        const abs = path.join(UPLOAD_ROOT, path.normalize(r.filename).replace(/^uploads[\\/]/, ''));
        await fs.unlink(abs);
      } catch (_) { /* ignore missing files */ }
    }));

    await deleteUser(req.user.username);
    return res.status(204).send();
  } catch (e) {
    console.error('deleteMe:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}
