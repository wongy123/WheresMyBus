// src/middleware/auth.js
import { idVerifier, accessVerifier } from '../lib/cognito.js';

// You named your groups "Admins" and "Users".
// Allow an env override in case you ever rename them.
const ADMIN_GROUPS = (process.env.COGNITO_ADMIN_GROUPS || 'Admins')
  .split(',')
  .map(s => s.trim().toLowerCase());

export async function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const [, token] = hdr.split(' ');
    if (!token) return res.status(401).json({ error: 'unauthorized' });

    // Prefer ACCESS tokens; fall back to ID tokens (useful for your debug endpoints).
    let payload;
    try {
      payload = await accessVerifier.verify(token);
    } catch {
      try {
        payload = await idVerifier.verify(token);
      } catch {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    // Identity fields
    const username =
      payload['cognito:username'] ||
      payload['username'] ||
      payload['email'] ||
      payload['sub'];

    if (!username) return res.status(401).json({ error: 'unauthorized' });

    // Map Cognito groups -> role
    const groups = Array.isArray(payload['cognito:groups'])
      ? payload['cognito:groups']
      : (Array.isArray(payload['groups']) ? payload['groups'] : []);

    const isAdmin = groups.some(g => ADMIN_GROUPS.includes(String(g).toLowerCase()));
    const role = isAdmin ? 'admin' : 'user';

    // Attach useful identity info (keep "username" for your existing controllers)
    req.user = {
      id: payload.sub,           // canonical stable ID
      username,                  // what your DB rows currently use for ownership
      email: payload.email ?? null,
      groups,
      role,
      jwt: payload,              // claims, if you need more later
    };

    next();
  } catch (e) {
    console.error('requireAuth:', e);
    return res.status(401).json({ error: 'unauthorized' });
  }
}
