// src/lib/cognito.js
import { CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand, InitiateAuthCommand, AuthFlowType } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import crypto from 'node:crypto';

export const REGION = process.env.AWS_REGION || 'ap-southeast-2';
export const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
export const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
export const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET;

export const COGNITO_DOMAIN = (process.env.COGNITO_DOMAIN || '').replace(/\/$/, ''); // no trailing slash
export const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI; // e.g. https://n11941073.wheresmybus.cab432.com/api/auth/cognito/callback

export const cognito = new CognitoIdentityProviderClient({ region: REGION });

export function secretHash(username) {
  if (!CLIENT_SECRET) return undefined; // only needed if app client has a secret
  const h = crypto.createHmac('sha256', CLIENT_SECRET);
  h.update(`${username}${CLIENT_ID}`);
  return h.digest('base64');
}

export const idVerifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'id',
  clientId: CLIENT_ID,
});

export const accessVerifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'access',
  clientId: CLIENT_ID,
});

// wrappers
export async function signUp({ username, password, email }) {
  const cmd = new SignUpCommand({
    ClientId: CLIENT_ID,
    SecretHash: secretHash(username),
    Username: username,
    Password: password,
    UserAttributes: [{ Name: 'email', Value: email }],
  });
  return cognito.send(cmd);
}

export async function confirmSignUp({ username, code }) {
  const cmd = new ConfirmSignUpCommand({
    ClientId: CLIENT_ID,
    SecretHash: secretHash(username),
    Username: username,
    ConfirmationCode: code,
  });
  return cognito.send(cmd);
}

export async function initiateAuth({ username, password }) {
  const cmd = new InitiateAuthCommand({
    AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: username,
      PASSWORD: password,
      SECRET_HASH: secretHash(username),
    },
  });
  return cognito.send(cmd);
}

// ==== Hosted UI helpers ====

// Build Hosted UI authorize URL
export function buildAuthorizeUrl({ state, provider } = {}) {
  if (!COGNITO_DOMAIN || !CLIENT_ID || !OAUTH_REDIRECT_URI) {
    throw new Error('cognito_hosted_ui_not_configured');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: 'openid email profile',
    state: state || crypto.randomBytes(16).toString('hex'),
  });
  if (provider) params.append('identity_provider', provider); // e.g. 'Google'
  return `${COGNITO_DOMAIN}/oauth2/authorize?${params.toString()}`;
}

// Exchange auth code for tokens at Cognito /oauth2/token
export async function exchangeAuthCodeForTokens({ code, redirectUri = OAUTH_REDIRECT_URI }) {
  if (!COGNITO_DOMAIN || !CLIENT_ID || !redirectUri) {
    throw new Error('cognito_hosted_ui_not_configured');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code,
  });
  if (CLIENT_SECRET) body.append('client_secret', CLIENT_SECRET);

  const resp = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`token_exchange_failed: ${resp.status} ${txt}`);
  }
  return resp.json(); // { access_token, id_token, refresh_token, expires_in, token_type }
}