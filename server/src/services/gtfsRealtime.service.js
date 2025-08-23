import { updateGtfsRealtime } from 'gtfs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function fetchGtfsRealtime() {
  const configPath = path.join(__dirname, '../../config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await updateGtfsRealtime(config);
}

function main() {
  fetchGtfsRealtime()
    .then(() => {
      console.log('GTFS Realtime data updated successfully.');
    })
    .catch(err => {
      console.error('Error updating GTFS Realtime data:', err);
    });
}

main();