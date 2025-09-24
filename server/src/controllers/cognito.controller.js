// src/controllers/cognito.controller.js
import { buildAuthorizeUrl, exchangeAuthCodeForTokens, accessVerifier } from '../lib/cognito.js';
import { createHandoff, consumeHandoff } from '../lib/handoffStore.js';
import { createUser, getUserByUsername } from '../models/db.js';

// GET /api/auth/cognito/login[?provider=Google]
export async function cognitoLogin(req, res) {
  try {
    const provider = req.query.provider === 'Google' ? 'Google' : undefined;
    // Optional: generate and remember a state per session; for simplicity we let Cognito generate one in buildAuthorizeUrl
    const url = buildAuthorizeUrl({ provider });
    return res.redirect(url);
  } catch (e) {
    console.error('cognitoLogin:', e);
    return res.status(500).json({ error: 'cognito_login_build_failed' });
  }
}

// GET /api/auth/cognito/callback?code=...&state=...
export async function cognitoCallback(req, res) {
  try {
    const { code } = req.query || {};
    if (!code) return res.status(400).send('Missing code');

    const tokens = await exchangeAuthCodeForTokens({ code });

    // Verify access token (preferred for API auth)
    const payload = await accessVerifier.verify(tokens.access_token);

    // Upsert local user row (optional, for roles & analytics)
    const username = payload['cognito:username'] || payload['username'] || payload['email'] || payload['sub'];
    if (username) {
      const existing = await getUserByUsername(username);
      if (!existing) {
        // We don't store passwords when using Cognito/Google
        await createUser({ username, passwordHash: '', role: 'user' });
      }
    }

    // Create one-time handoff code so SPA can fetch tokens via XHR (no tokens in URL or cookies)
    const h = createHandoff(tokens);

    // Redirect the browser to your frontend route with the opaque code
    const base = process.env.PUBLIC_BASE_URL || 'http://localhost:5173';
    const target = new URL('/auth/callback', base);
    target.searchParams.set('h', h);
    return res.redirect(target.toString());
  } catch (e) {
    console.error('cognitoCallback:', e);
    return res.status(400).send('Sign-in failed');
  }
}

// POST /api/auth/cognito/redeem { h: "handoff_code" }
export async function cognitoRedeem(req, res) {
  try {
    const { h } = req.body || {};
    if (!h) return res.status(400).json({ error: 'missing_handoff_code' });
    const tokens = consumeHandoff(h);
    if (!tokens) return res.status(400).json({ error: 'invalid_or_expired_handoff' });
    // Return tokens so SPA can store & use Authorization: Bearer
    return res.json(tokens);
  } catch (e) {
    console.error('cognitoRedeem:', e);
    return res.status(500).json({ error: 'redeem_failed' });
  }
}
