import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  searchStops,
  getOneStop,
  getStopTimetable,
  upload,
  postStopImage,
  listStopImages,
  deleteStopImageById,
  putMyStopReview,
  getMyReview,
  listReviews,
  deleteMyReview,
  getStopRating,
  presignStopImageUpload,
  finalizeStopImageUpload
} from "../controllers/stops.controller.js";

const router = Router();

router.get("/search", searchStops);
router.get("/:stopId/timetable", getStopTimetable);
router.get("/:stopId", getOneStop);

// images
router.post("/:stopId/images/presign-upload", requireAuth, presignStopImageUpload);
router.post("/:stopId/images/finalize", requireAuth, finalizeStopImageUpload);
router.post(
  "/:stopId/images",
  requireAuth,
  upload.single("file"),
  postStopImage
);
router.get("/:stopId/images", listStopImages);
router.delete("/:stopId/images/:imageId", requireAuth, deleteStopImageById);

// reviews
router.put("/:stopId/review", requireAuth, putMyStopReview);
router.get("/:stopId/review", requireAuth, getMyReview);
router.get("/:stopId/reviews", listReviews);
router.get("/:stopId/rating", getStopRating);
router.delete("/:stopId/review", requireAuth, deleteMyReview);

export default router;
