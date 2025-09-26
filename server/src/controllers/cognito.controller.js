// src/controllers/cognito.controller.js
import { buildAuthorizeUrl, exchangeAuthCodeForTokens, accessVerifier } from '../lib/cognito.js';
import { createHandoff, consumeHandoff } from '../lib/handoffStore.js';
import { resolvePublicBaseUrl } from '../lib/publicBaseUrl.js';

// GET /api/auth/cognito/login[?provider=Google]
export async function cognitoLogin(req, res) {
  try {
    const base = await resolvePublicBaseUrl();
    const redirectUri = new URL('/api/auth/cognito/callback', base).toString();

    const provider = req.query.provider === 'Google' ? 'Google' : undefined;
    const url = buildAuthorizeUrl({ provider, redirectUri });
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

    const base = await resolvePublicBaseUrl();
    const redirectUri = new URL('/api/auth/cognito/callback', base).toString();

    const tokens = await exchangeAuthCodeForTokens({ code, redirectUri });
    // quick sanity check to fail fast if the token is not valid
    await accessVerifier.verify(tokens.access_token);

    const h = createHandoff(tokens);
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
    return res.json(tokens);
  } catch (e) {
    console.error('cognitoRedeem:', e);
    return res.status(500).json({ error: 'redeem_failed' });
  }
}
