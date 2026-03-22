import { Router } from "express";
import {
  searchStops,
  nearbyStops,
  getOneStop,
  getStopTimetable,
  getStopRoutes,
} from "../controllers/stops.controller.js";

const router = Router();

router.get("/search", searchStops);
router.get("/nearby", nearbyStops);
router.get("/:stopId/routes", getStopRoutes);
router.get("/:stopId/timetable", getStopTimetable);
router.get("/:stopId", getOneStop);

export default router;
