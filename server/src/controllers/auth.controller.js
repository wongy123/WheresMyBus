// src/controllers/auth.controller.js
import { signUp, confirmSignUp, initiateAuth, respondToEmailMfa } from '../lib/cognito.js';
import { CognitoIdentityProviderClient, RespondToAuthChallengeCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CLIENT_ID, secretHash } from '../lib/cognito.js';

// POST /api/auth/register  { username, password, email }
export async function register(req, res) {
  try {
    const { username, password, email } = req.body || {};
    if (!username || !password || !email) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    await signUp({ username, password, email });
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

    let resp = await initiateAuth({ username, password });

    // Some pools return SELECT_CHALLENGE first; choose email OTP.
    if (resp.ChallengeName === 'SELECT_CHALLENGE') {
      const client = new CognitoIdentityProviderClient({});
      const selectCmd = new RespondToAuthChallengeCommand({
        ClientId: CLIENT_ID,
        ChallengeName: 'SELECT_CHALLENGE',
        Session: resp.Session,
        ChallengeResponses: {
          USERNAME: username,
          ANSWER: 'EMAIL_OTP',
          SECRET_HASH: secretHash(username),
        },
      });
      resp = await client.send(selectCmd);
    }

    // Email MFA challenge path
    if (resp.ChallengeName === 'EMAIL_OTP' || resp.ChallengeName === 'EMAIL_MFA') {
      return res.status(200).json({
        challenge: resp.ChallengeName,
        session: resp.Session,
        message: 'mfa_required_email_code_sent',
      });
    }

    // Success path
    const { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType } = resp.AuthenticationResult || {};
    if (!IdToken) return res.status(401).json({ error: 'auth_failed' });

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

// POST /api/auth/login/mfa { username, code, session, challenge }  // 'EMAIL_OTP' or 'EMAIL_MFA'
export async function loginMfa(req, res) {
  try {
    const { username, code, session, challenge } = req.body || {};
    if (!username || !code || !session) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    const mfaResp = await respondToEmailMfa({
      username,
      code,
      session,
      challengeName: challenge || 'EMAIL_OTP',
    });

    const { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType } = mfaResp.AuthenticationResult || {};
    if (!AccessToken) return res.status(401).json({ error: 'mfa_failed' });

    return res.json({
      id_token: IdToken,
      access_token: AccessToken,
      refresh_token: RefreshToken,
      token_type: TokenType,
      expires_in: ExpiresIn,
    });
  } catch (e) {
    console.error('loginMfa:', e);
    return res.status(401).json({ error: 'mfa_failed', detail: String(e.message || e) });
  }
}
