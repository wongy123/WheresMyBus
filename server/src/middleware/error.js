export function notFound(_req, res, _next) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
}

export function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  res.status(status).json({
    error: { code: status === 500 ? 'INTERNAL' : 'ERROR', message }
  });
}
