// src/controllers/auth.controller.js
import { signUp, confirmSignUp, initiateAuth } from '../lib/cognito.js';
import { pool, createUser, getUserByUsername } from '../models/db.js';

// POST /api/auth/register  { username, password, email }
export async function register(req, res) {
  try {
    const { username, password, email } = req.body || {};
    if (!username || !password || !email) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    await signUp({ username, password, email });
    // optional local user row for role tracking if not exists
    const existing = await getUserByUsername(username);
    if (!existing) {
      await createUser({ username, passwordHash: '', role: 'user' }); // password unused with Cognito
    }
    return res.status(200).json({ ok: true, message: 'confirmation_required' });
  } catch (e) {
    console.error('register:', e);
    return res.status(400).json({ error: 'register_failed', detail: String(e.message || e) });
  }
}

// POST /api/auth/confirm  { username, code }
export async function confirm(req, res) {
  try {
    const { username, code } = req.body || {};
    if (!username || !code) return res.status(400).json({ error: 'missing_fields' });
    await confirmSignUp({ username, code });
    return res.json({ ok: true });
  } catch (e) {
    console.error('confirm:', e);
    return res.status(400).json({ error: 'confirm_failed', detail: String(e.message || e) });
  }
}

// POST /api/auth/login  { username, password }
export async function login(req, res) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing_fields' });

    const resp = await initiateAuth({ username, password });
    const { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType } = resp.AuthenticationResult || {};
    if (!IdToken) return res.status(401).json({ error: 'auth_failed' });

    // ensure local role row exists (optional)
    const u = await getUserByUsername(username);
    if (!u) await createUser({ username, passwordHash: '', role: 'user' });

    return res.json({
      id_token: IdToken,
      access_token: AccessToken,
      refresh_token: RefreshToken,
      token_type: TokenType,
      expires_in: ExpiresIn,
    });
  } catch (e) {
    console.error('login:', e);
    return res.status(401).json({ error: 'auth_failed', detail: String(e.message || e) });
  }
}
