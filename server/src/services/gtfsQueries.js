import { closeDb, openDb, getRoutes, getStops, getStopTimeUpdates } from 'gtfs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchGtfsRealtime } from './gtfsRealtime.js';

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
  await fetchGtfsRealtime(); // Ensure real-time data is updated

  const config = await loadConfig(configPath);
  const db = openDb(config);

  const stopTimeUpdates = getStopTimeUpdates();

  await closeDb(db);
  return stopTimeUpdates;
}
