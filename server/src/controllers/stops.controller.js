// src/controllers/stops.controller.js
import {
  getAllStops,
  getOneStop as getOneStopService,
  getUpcomingByStop,
} from "../services/gtfsQueries.service.js";
import {
  paginateResponse,
  buildPaginationAndLinks,
} from "../utils/paginate.js";
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
import { randomUUID } from "node:crypto";
import multer from "multer";

import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, S3_BUCKET } from "../lib/s3Client.js";
import mime from "mime";

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
 */
export async function getOneStop(req, res, next) {
  try {
    const stopId = req.params.stopId ?? req.query.stopId;
    if (!stopId) return res.status(400).json({ error: "stopId is required" });

    const stop = await getOneStopService(stopId);
    if (!stop) return res.status(404).json({ error: "Stop not found" });

    res.json(stop);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stops/:stopId/timetable?startTime=...&duration=...
 */
export async function getStopTimetable(req, res, next) {
  try {
    const stopId = req.params.stopId ?? req.query.stopId;
    if (!stopId) return res.status(400).json({ error: "stopId is required" });

    const startTimeQ = req.query.startTime;
    const durationQ = req.query.duration;

    const startTime = Number.isFinite(parseInt(startTimeQ, 10)) ? parseInt(startTimeQ, 10) : undefined;
    const duration = Number.isFinite(parseInt(durationQ, 10)) ? parseInt(durationQ, 10) : undefined;

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

// ---------- uploads (multer) -> S3 (no local disk) ----------
const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const storage = multer.memoryStorage();
export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(_req, file, cb) {
    if (!MIME_EXT[file.mimetype]) return cb(new Error("unsupported_file_type"));
    cb(null, true);
  },
});

function buildStopImageKey(stopId, mimetype) {
  const ext = MIME_EXT[mimetype] || mime.getExtension(mimetype) || "bin";
  return `stops/${String(stopId)}/${randomUUID()}.${ext}`;
}

// ---------- images ----------
export async function postStopImage(req, res) {
  try {
    if (!S3_BUCKET) return res.status(500).json({ error: "s3_not_configured" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "file_required" });

    const stopId = req.params.stopId;
    const key = buildStopImageKey(stopId, file.mimetype);

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: "public, max-age=31536000, immutable",
      })
    );

    const payload = await insertStopImage({
      stop_id: stopId,
      user_id: req.user.id, // <-- use Cognito sub
      bucket: S3_BUCKET,
      s3_key: key,
      content_type: file.mimetype,
      size_bytes: file.size,
      etag: null,
    });

    return res.status(201).json(payload);
  } catch (e) {
    console.error("postStopImage:", e);
    if (e?.message === "unsupported_file_type") {
      return res.status(400).json({ error: "unsupported_file_type" });
    }
    return res.status(500).json({ error: "server_error" });
  }
}

export async function listStopImages(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));

    const { items, total } = await listStopImagesByStop(req.params.stopId, { page, limit });

    const itemsWithUrl = await Promise.all(
      items.map(async (it) => {
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: it.bucket, Key: it.s3_key }),
          { expiresIn: 600 }
        );
        return { ...it, url };
      })
    );

    const meta = buildPaginationAndLinks(req, { page, limit, total });
    return res.json({ items: itemsWithUrl, ...meta });
  } catch (e) {
    console.error("listStopImages:", e);
    return res.status(500).json({ error: "server_error" });
  }
}

export async function deleteStopImageById(req, res) {
  try {
    const { stopId, imageId } = req.params;

    // fetch S3 metadata + owner check
    const { rows } = await pool.query(
      "SELECT user_id, bucket, s3_key FROM stop_image WHERE stop_id = $1 AND image_id = $2",
      [stopId, imageId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not_found" });
    const isOwner = row.user_id === req.user.id; // <-- use Cognito sub
    const isAdmin = req.user.role === "admin";
    if (!isOwner && !isAdmin) return res.status(403).json({ error: "forbidden" });

    // remove DB row (owner or admin)
    const ok = await deleteStopImage(stopId, imageId, req.user.id, isAdmin); // <-- pass sub
    if (!ok) return res.status(404).json({ error: "not_found" });

    // best-effort: delete the S3 object
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.s3_key }));
    } catch (_) { }

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
      user_id: req.user.id, // <-- use Cognito sub
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
    const review = await getMyStopReview(req.params.stopId, req.user.id); // <-- use sub
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

    const { items, total } = await listStopReviews(req.params.stopId, { page, limit, sort });
    const meta = buildPaginationAndLinks(req, { page, limit, total });

    return res.json({ items, ...meta });
  } catch (e) {
    console.error("listReviews:", e);
    return res.status(500).json({ error: "server_error" });
  }
}

export async function deleteMyReview(req, res) {
  try {
    const ok = await deleteMyStopReview(req.params.stopId, req.user.id); // <-- use sub
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
