// server/src/models/db.js
import 'dotenv/config';
import { Pool } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ----- DB config from env -----
const DB_CONFIG = {
  host:     process.env.PGHOST     || '127.0.0.1',
  port:     Number(process.env.PGPORT || 5432),
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'wheresmybus',
  max:      Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: 30_000,
};

// ----- Connection pool -----
export const pool = new Pool(DB_CONFIG);

pool.on('error', (err) => {
  console.error('[pg] unexpected idle client error:', err);
});
