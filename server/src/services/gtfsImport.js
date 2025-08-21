import { importGtfs } from 'gtfs';
import { readFile } from 'fs/promises';
import path from 'node:path';

const config = JSON.parse(
  await readFile(path.join(import.meta.dirname, '../../config.json'), 'utf8')
);

await importGtfs(config);