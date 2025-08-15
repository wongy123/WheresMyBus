import pg from 'pg';

const {
  PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT
} = process.env;

export const pool = new pg.Pool({
  host: PGHOST || 'localhost',
  user: PGUSER || 'postgres',
  password: PGPASSWORD || '',
  database: PGDATABASE || 'postgres',
  port: Number(PGPORT || 5432),
  max: 10,
  idleTimeoutMillis: 10_000,
});
