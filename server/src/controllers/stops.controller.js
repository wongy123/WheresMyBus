import {
  getAllStops,
  getOneStop as getOneStopService,
  getUpcomingByStop,
} from "../services/gtfsQueries.service.js";
import {
  paginateResponse,
  buildPaginationAndLinks,
} from "../utils/paginate.js";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import multer from "multer";
import {
  insertStopImage,
  listStopImagesByStop,
  deleteStopImage,
  upsertStopReview,
  getMyStopReview,
  listStopReviews,
  deleteMyStopReview,
  getStopRatingSummary,
  pool,
} from "../models/db.js";
import { getPublicOrigin } from '../utils/public-origin.js';

/**
 * GET /api/stops/search?searchTerm=...&page=1&limit=20
 */
export async function searchStops(req, res, next) {
  try {
    const searchTerm = (req.query.q ?? "").trim();
    const rows = await getAllStops(searchTerm);

    const body = paginateResponse({
      data: rows,
      req,
      res,
      defaultLimit: 25,
      maxLimit: 100,
    });

    res.json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/:stopId
 * (also accepts ?stopId=... as a fallback)
 */
export async function getOneStop(req, res, next) {
  try {
    const stopId = req.params.stopId ?? req.query.stopId;
    if (!stopId) {
      return res.status(400).json({ error: "stopId is required" });
    }

    const stop = await getOneStopService(stopId);
    if (!stop) {
      return res.status(404).json({ error: "Stop not found" });
    }

    res.json(stop);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/:stopId/timetable?startTime=...&duration=...&page=1&limit=20
 * startTime/duration are optional (epoch seconds). Falls back to service defaults.
 */
export async function getStopTimetable(req, res, next) {
  try {
    const stopId = req.params.stopId ?? req.query.stopId;
    if (!stopId) {
      return res.status(400).json({ error: "stopId is required" });
    }

    const startTimeQ = req.query.startTime;
    const durationQ = req.query.duration;

    const startTime = Number.isFinite(parseInt(startTimeQ, 10))
      ? parseInt(startTimeQ, 10)
      : undefined;

    const duration = Number.isFinite(parseInt(durationQ, 10))
      ? parseInt(durationQ, 10)
      : undefined;

    const rows = await getUpcomingByStop(stopId, startTime, duration);

    const body = paginateResponse({
      data: rows,
      req,
      res,
      defaultLimit: 20,
      maxLimit: 100,
    });

    res.json(body);
  } catch (err) {
    next(err);
  }
}

// ---------- uploads (multer) ----------
const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads"); // serve later via app.use('/static', express.static('uploads'))

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function ensureDir(p) {
  return fs.mkdir(p, { recursive: true });
}

const storage = multer.diskStorage({
  async destination(req, _file, cb) {
    const stopId = req.params.stopId;
    const dest = path.join(UPLOAD_ROOT, "stops", String(stopId));
    try {
      await ensureDir(dest);
    } catch {}
    cb(null, dest);
  },
  filename(req, file, cb) {
    const ext = MIME_EXT[file.mimetype] || "dat";
    const name = `${randomUUID()}.${ext}`;
    cb(null, name);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!MIME_EXT[file.mimetype]) return cb(new Error("unsupported_file_type"));
    cb(null, true);
  },
});

// ---------- images ----------
export async function postStopImage(req, res) {
  try {
    // multer put file at: uploads/stops/<stopId>/<uuid>.<ext>
    const file = req.file;
    if (!file) return res.status(400).json({ error: "file_required" });

    const rel = path.relative(UPLOAD_ROOT, file.path).replaceAll("\\", "/");
    const payload = await insertStopImage({
      stop_id: req.params.stopId,
      user_id: req.user.username,
      filename: `uploads/${rel}`,
      mime_type: file.mimetype,
    });

    return res.status(201).json(payload);
  } catch (e) {
    console.error("postStopImage:", e);
    if (e.message === "unsupported_file_type")
      return res.status(400).json({ error: "unsupported_file_type" });
    return res.status(500).json({ error: "server_error" });
  }
}

export async function listStopImages(req, res) {
  try {
    const page  = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));

    const origin = getPublicOrigin(req);
    const toUrl = (fn) => `${origin}/static/${fn.replace(/^uploads\//, '')}`;

    const { items, total } = await listStopImagesByStop(req.params.stopId, { page, limit });
    const itemsWithUrl = items.map(it => ({ ...it, url: toUrl(it.filename) }));

    const meta = buildPaginationAndLinks(req, { page, limit, total });
    return res.json({ items: itemsWithUrl, ...meta });
  } catch (e) {
    console.error('listStopImages:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}

export async function deleteStopImageById(req, res) {
  try {
    const { stopId, imageId } = req.params;

    // fetch filename for disk cleanup + owner check
    const { rows } = await pool.query(
      "SELECT filename, user_id FROM stop_image WHERE stop_id = $1 AND image_id = $2",
      [stopId, imageId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not_found" });
    if (row.user_id !== req.user.username && req.user.role !== "admin") {
      return res.status(403).json({ error: "forbidden" });
    }

    // remove DB row
    const ok = await deleteStopImage(
      stopId,
      imageId,
      req.user.username,
      req.user.role === "admin"
    );
    if (!ok) return res.status(404).json({ error: "not_found" });

    // best-effort remove file
    try {
      const abs = path.resolve(process.cwd(), row.filename);
      await fs.unlink(abs);
    } catch (_) {}

    return res.status(204).send();
  } catch (e) {
    console.error("deleteStopImageById:", e);
    return res.status(500).json({ error: "server_error" });
  }
}

// ---------- reviews ----------
export async function putMyStopReview(req, res) {
  try {
    const { rating, comment } = req.body || {};
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      return res.status(400).json({ error: "rating_must_be_1_to_5" });
    }
    const review = await upsertStopReview({
      stop_id: req.params.stopId,
      user_id: req.user.username,
      rating: r,
      comment: comment ?? null,
    });
    return res.json(review);
  } catch (e) {
    console.error("putMyStopReview:", e);
    return res.status(500).json({ error: "server_error" });
  }
}

export async function getMyReview(req, res) {
  try {
    const review = await getMyStopReview(req.params.stopId, req.user.username);
    if (!review) return res.status(404).json({ error: "not_found" });
    return res.json(review);
  } catch (e) {
    console.error("getMyReview:", e);
    return res.status(500).json({ error: "server_error" });
  }
}

export async function listReviews(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const sort = req.query.sort === "rating" ? "rating" : "recent";

    const { items, total } = await listStopReviews(req.params.stopId, {
      page,
      limit,
      sort,
    });
    const meta = buildPaginationAndLinks(req, { page, limit, total });

    return res.json({ items, ...meta });
  } catch (e) {
    console.error("listReviews:", e);
    return res.status(500).json({ error: "server_error" });
  }
}

export async function deleteMyReview(req, res) {
  try {
    const ok = await deleteMyStopReview(req.params.stopId, req.user.username);
    if (!ok) return res.status(404).json({ error: "not_found" });
    return res.status(204).send();
  } catch (e) {
    console.error("deleteMyReview:", e);
    return res.status(500).json({ error: "server_error" });
  }
}

export async function getStopRating(req, res) {
  try {
    const data = await getStopRatingSummary(req.params.stopId);
    return res.json({ stop_id: req.params.stopId, ...data });
  } catch (e) {
    console.error("getStopRating:", e);
    return res.status(500).json({ error: "server_error" });
  }
}
