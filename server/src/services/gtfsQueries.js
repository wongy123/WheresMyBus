import { closeDb, openDb, getRoutes, getStops } from 'gtfs';
import { readFile } from 'fs/promises';
import path from 'node:path';

const defaultConfigPath = "../../config.json";

export async function getAllRoutes (configPath = defaultConfigPath) {

    const config = JSON.parse(
        await readFile(path.join(import.meta.dirname, configPath))
    );

    const db = openDb(config);

    const routes = getRoutes(
        {},
        ['route_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color'],
        [['route_short_name', 'ASC']]
    );

    await closeDb(db);

    return routes;
};

export async function getOneRoute(routeId, configPath = defaultConfigPath) {
        const config = JSON.parse(
        await readFile(path.join(import.meta.dirname, configPath))
    );

    const db = openDb(config);

    const route = getRoutes(
        {
            route_id: routeId
        }
    );

    await closeDb(db);

    return route[0];
};

export async function getAllStops(configPath = defaultConfigPath) {
    const config = JSON.parse(
      await readFile(path.join(import.meta.dirname, configPath))
    );
    const db = openDb(config);
    const stops = getStops(
      {},
      ['stop_id', 'stop_name', 'location_type']
    );

    closeDb(db);

    return stops;
};

export async function getOneStop(stopId, configPath = defaultConfigPath) {
  const config = JSON.parse(
      await readFile(path.join(import.meta.dirname, configPath))
    );
    const db = openDb(config);
    const stop = getStops(
      {
        stop_id: stopId
      }
    );

    closeDb(db);

    return stop[0];
};