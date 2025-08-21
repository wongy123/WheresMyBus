import { closeDb, openDb, getRoutes } from 'gtfs';
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
        ['route_id', 'route_short_name', 'route_long_name', 'route_type', 'route_url', 'route_color', 'route_text_color'],
        [['route_short_name', 'ASC']]
    );

    await closeDb(db);

    return routes;
};

export async function getOneRoute(routeShortName, configPath = defaultConfigPath) {
        const config = JSON.parse(
        await readFile(path.join(import.meta.dirname, configPath))
    );

    const db = openDb(config);

    const route = getRoutes(
        {
            route_short_name: routeShortName
        }
    );

    await closeDb(db);

    return route[0];
};