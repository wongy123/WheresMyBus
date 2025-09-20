// src/lib/cognito.js
import { CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand, InitiateAuthCommand, AuthFlowType } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import crypto from 'node:crypto';

export const REGION = process.env.AWS_REGION || 'ap-southeast-2';
export const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
export const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
export const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET;

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
