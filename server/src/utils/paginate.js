// Simple array pagination for Express JSON APIs (ESM)

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

/**
 * Build path-only links that preserve existing query params.
 * Uses req.baseUrl + req.path as the base (works inside routers).
 */
function buildLinks({ req, path, meta }) {
  const basePath = path ?? (req?.baseUrl || '') + (req?.path || '');
  const qs = new URLSearchParams(req?.query || {});
  const set = (p) => {
    if (!p) return null;
    qs.set('page', String(p));
    qs.set('limit', String(meta.limit));
    return `${basePath}?${qs.toString()}`;
  };

  const self  = set(meta.page);
  const next  = meta.page < meta.pageCount ? set(meta.page + 1) : null;
  const prev  = meta.page > 1 && meta.pageCount > 0 ? set(meta.page - 1) : null;
  const first = meta.pageCount > 0 ? set(1) : null;
  const last  = meta.pageCount > 0 ? set(meta.pageCount) : null;

  return { self, next, prev, first, last };
}

/**
 * Paginate an in-memory array and (optionally) set pagination headers.
 * - data: full array you've already fetched from DB
 * - req/res: Express objects (req to read page/limit + build links; res to set headers)
 * - path: override the path used in links (defaults to req.baseUrl + req.path)
 * - defaultLimit/maxLimit: sane defaults & clamp
 *
 * Returns { data, pagination, links }
 */
export function paginateResponse({
  data,
  req,
  res,
  path,
  defaultLimit = 20,
  maxLimit = 100
}) {
  const totalRaw = Array.isArray(data) ? data.length : 0;

  const pageQ  = Number.parseInt(req?.query?.page, 10);
  const limitQ = Number.parseInt(req?.query?.limit, 10);

  const limit = Number.isFinite(limitQ) && limitQ > 0
    ? clamp(limitQ, 1, maxLimit)
    : defaultLimit;

  const page = Number.isFinite(pageQ) && pageQ > 0 ? pageQ : 1;

  const pageCount = totalRaw === 0 ? 0 : Math.ceil(totalRaw / limit);
  const offset = (page - 1) * limit;

  const slice = offset >= totalRaw ? [] : data.slice(offset, offset + limit);

  const meta = {
    page,
    limit,
    total: totalRaw,
    pageCount,
    hasPrev: page > 1 && pageCount > 0,
    hasNext: page < pageCount
  };

  const links = buildLinks({ req, path, meta });

  // Optional but nice: standard pagination headers
  if (res) {
    res.set('X-Total-Count', String(meta.total));
    const linkParts = [];
    if (links.next)  linkParts.push(`<${links.next}>; rel="next"`);
    if (links.prev)  linkParts.push(`<${links.prev}>; rel="prev"`);
    if (links.first) linkParts.push(`<${links.first}>; rel="first"`);
    if (links.last)  linkParts.push(`<${links.last}>; rel="last"`);
    if (linkParts.length) res.set('Link', linkParts.join(', '));
  }

  return {
    data: slice,
    pagination: {
      page: meta.page,
      limit: meta.limit,
      total: meta.total,
      pageCount: meta.pageCount,
      hasNext: meta.hasNext,
      hasPrev: meta.hasPrev
    },
    links
  };
}


// Below are for use with PostgreSQL
export function buildPaginationAndLinks(req, { page, limit, total }) {
  const pageNum  = Math.max(1, Number(page || 1));
  const limitNum = Math.max(1, Number(limit || 20));
  const pageCount = Math.max(1, Math.ceil(total / limitNum));
  const hasNext = pageNum < pageCount;
  const hasPrev = pageNum > 1;

  const origin = `${req.protocol}://${req.get('host')}`;
  const baseUrl = new URL(req.originalUrl, origin);

  const make = (n) => {
    const u = new URL(baseUrl);
    u.searchParams.set('page', String(n));
    u.searchParams.set('limit', String(limitNum));
    // Return path + query (your other endpoints do this)
    return u.pathname + u.search;
  };

  return {
    pagination: { page: pageNum, limit: limitNum, total, pageCount, hasNext, hasPrev },
    links: {
      self:  make(pageNum),
      next:  hasNext ? make(pageNum + 1) : null,
      prev:  hasPrev ? make(pageNum - 1) : null,
      first: make(1),
      last:  make(pageCount),
    }
  };
}
