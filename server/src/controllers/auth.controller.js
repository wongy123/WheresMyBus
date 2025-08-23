import bcrypt from 'bcrypt';
import { createUser, getUserByUsername } from '../models/db.js';
import { signAccessToken } from '../middleware/auth.js';

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

export async function register(req, res) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username_and_password_required' });
    if (String(username).length < 3) return res.status(400).json({ error: 'username_too_short' });
    if (String(password).length < 8) return res.status(400).json({ error: 'password_too_short' });

    const existing = await getUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'username_taken' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await createUser({ username, passwordHash, role: 'user' });
    const accessToken = signAccessToken({ username: user.username, role: user.role });

    return res.status(201).json({ user, accessToken });
  } catch (e) {
    console.error('register:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}

export async function login(req, res) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username_and_password_required' });

    const row = await getUserByUsername(username);
    if (!row) return res.status(401).json({ error: 'invalid_credentials' });

    const ok = await bcrypt.compare(password, row.password);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const accessToken = signAccessToken({ username: row.username, role: row.role });
    return res.json({
      user: { username: row.username, role: row.role, created_at: row.created_at },
      accessToken
    });
  } catch (e) {
    console.error('login:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}

export async function logout(_req, res) {
  // stateless JWT: nothing to do server-side
  return res.status(204).send();
}
