// src/middleware/auth.js
import { idVerifier, accessVerifier } from '../lib/cognito.js';
import { pool } from '../models/db.js';

export async function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const [, token] = hdr.split(' ');
    if (!token) return res.status(401).json({ error: 'unauthorized' });

    let payload;
    try {
      payload = await accessVerifier.verify(token);
    } catch (e1) {
      // Fallback: allow ID tokens (useful for debugging tools)
      try {
        payload = await idVerifier.verify(token);
      } catch (e2) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const username =
      payload['cognito:username'] ||
      payload['username'] ||
      payload['email'] ||
      payload['sub'];

    if (!username) return res.status(401).json({ error: 'unauthorized' });

    // fetch role from local DB (default 'user')
    const { rows } = await pool.query('SELECT role FROM users WHERE username = $1', [username]);
    const role = rows[0]?.role || 'user';

    req.user = { username, role, jwt: payload };
    next();
  } catch (e) {
    console.error('requireAuth:', e);
    return res.status(401).json({ error: 'unauthorized' });
  }
}