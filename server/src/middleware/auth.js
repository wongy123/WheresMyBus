import jwt from 'jsonwebtoken';

const { JWT_SECRET = 'dev-secret', ACCESS_TOKEN_TTL = '60m' } = process.env;

export function signAccessToken({ username, role }) {
  return jwt.sign({ sub: username, role }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const [, token] = h.split(' ');
  if (!token) return res.status(401).json({ error: 'missing_token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { username: payload.sub, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}
