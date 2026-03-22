import { Router } from "express";
import {
  searchStops,
  nearbyStops,
  getOneStop,
  getStopTimetable,
  getStopRoutes,
  getStopPlatforms,
} from "../controllers/stops.controller.js";

const router = Router();

router.get("/search", searchStops);
router.get("/nearby", nearbyStops);
router.get("/:stopId/platforms", getStopPlatforms);
router.get("/:stopId/routes", getStopRoutes);
router.get("/:stopId/timetable", getStopTimetable);
router.get("/:stopId", getOneStop);

export default router;
