export function getPublicOrigin(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0];
  const host  = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0];
  return `${proto}://${host}`;
}