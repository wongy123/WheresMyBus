import { closeDb, openDb, getStops, getStopTimeUpdates } from 'gtfs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultConfigPath = '../../config.json';

async function loadConfig(configPath = defaultConfigPath) {
  const full = path.join(__dirname, configPath);
  return JSON.parse(await readFile(full, 'utf8'));
}

export async function getAllRoutes(searchTerm = '', configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  let sql = `
    SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color
    FROM routes
  `;

  let params = {};
  if (searchTerm) {
    sql += `
      WHERE route_short_name LIKE $term OR route_long_name LIKE $term
    `;
    params.term = `%${searchTerm}%`;
  }

  sql += `
    ORDER BY route_short_name ASC
  `;

  const routes = db.prepare(sql).all(params);

  await closeDb(db);
  return routes;
}

export async function getOneRoute(identifier, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const sql = `
    SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color
    FROM routes
    WHERE route_id = $id OR route_short_name = $id
    LIMIT 1
  `;

  const route = db.prepare(sql).get({ id: identifier });

  await closeDb(db);
  return route || null;
}

export async function getAllStops(searchTerm = '', configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  let sql = `
    SELECT stop_id, stop_name, location_type
    FROM stops
  `;

  let params = {};
  if (searchTerm) {
    sql += ` WHERE stop_name LIKE $term `;
    params.term = `%${searchTerm}%`;
  }

  sql += ` ORDER BY stop_name ASC `;

  const stops = db.prepare(sql).all(params);

  await closeDb(db);
  return stops;
}

export async function getOneStop(stopId, configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const stop = getStops({ stop_id: stopId });

  await closeDb(db);
  return stop[0];
}

export async function getAllStopTimeUpdates(configPath = defaultConfigPath) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  const stopTimeUpdates = getStopTimeUpdates();

  await closeDb(db);
  return stopTimeUpdates;
}

export async function getUpcomingByRoute(
  routeId,
  direction = 0,
  startTime = Math.floor(Date.now() / 1000), // epoch seconds
  duration = 7200,                           // 2 hours in seconds
  configPath = defaultConfigPath
) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  // Convert startTime (epoch seconds) to seconds since local midnight
  const date = new Date(startTime * 1000);
  const midnight = new Date(date);
  midnight.setHours(0, 0, 0, 0);
  const secNow = Math.floor((date - midnight) / 1000);
  const secEnd = secNow + duration;

  const sql = `
SELECT
    se.route_id,
    se.route_short_name,
    se.route_color,
    se.route_text_color,
    se.service_id,
    se.trip_id,
    se.trip_headsign,
    se.direction_id,
    se.stop_id,
    se.stop_code,
    se.stop_name,
    se.stop_sequence,
    se.arrival_time   AS scheduled_arrival_time,
    se.departure_time AS scheduled_departure_time,
    se.estimated_arrival_time,
    se.estimated_departure_time,
    se.arrival_delay,
    se.departure_delay,
    se.real_time_data,
    se.event_sec,      -- keep for response continuity
    se.win_sec         -- new: used for filtering/ordering across midnight
FROM stop_events_3day se
JOIN (
    SELECT trip_id, MIN(win_sec) AS next_win_sec
    FROM stop_events_3day
    WHERE route_id = $routeId
      AND direction_id = $direction
      AND win_sec BETWEEN $startSec AND $endSec
    GROUP BY trip_id
) nxt
  ON se.trip_id = nxt.trip_id
 AND se.win_sec = nxt.next_win_sec
JOIN (
    SELECT trip_id, win_sec, MIN(stop_sequence) AS min_seq
    FROM stop_events_3day
    WHERE route_id = $routeId
      AND direction_id = $direction
      AND win_sec BETWEEN $startSec AND $endSec
    GROUP BY trip_id, win_sec
) tb
  ON se.trip_id = tb.trip_id
 AND se.win_sec = tb.win_sec
 AND se.stop_sequence = tb.min_seq
ORDER BY se.win_sec ASC;
  `;

  const params = {
    routeId,
    direction,
    startSec: secNow,
    endSec: secEnd,
  };

  const rows = db.prepare(sql).all(params);

  await closeDb(db);
  return rows;
}

export async function getUpcomingByStop(
  stopId,
  startTime = Math.floor(Date.now() / 1000), // epoch seconds (defaults to now)
  duration = 7200,                           // 2 hours in seconds
  configPath = defaultConfigPath
) {
  const config = await loadConfig(configPath);
  const db = openDb(config);

  // Convert startTime (epoch seconds) -> seconds since local midnight
  const date = new Date(startTime * 1000);
  const midnight = new Date(date);
  midnight.setHours(0, 0, 0, 0);
  const startSec = Math.floor((date - midnight) / 1000);
  const endSec = startSec + duration;

  const sql = `
    SELECT
      se.route_id,
      se.route_short_name,
      se.route_color,
      se.route_text_color,
      se.service_id,
      se.trip_id,
      se.trip_headsign,
      se.direction_id,
      se.stop_id,
      se.stop_code,
      se.stop_name,
      se.stop_sequence,
      se.arrival_time   AS scheduled_arrival_time,
      se.departure_time AS scheduled_departure_time,
      se.estimated_arrival_time,
      se.estimated_departure_time,
      se.arrival_delay,
      se.departure_delay,
      se.real_time_data
    FROM stop_events_3day se
    WHERE se.stop_id = $stopId
      AND se.win_sec BETWEEN $startSec AND $endSec
    ORDER BY se.win_sec, se.route_short_name, se.trip_id, se.stop_sequence
  `;

  const params = {
    stopId: String(stopId),
    startSec,
    endSec
  };

  const rows = db.prepare(sql).all(params);

  await closeDb(db);
  return rows;
}
