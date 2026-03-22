#!/usr/bin/env bash
set -euo pipefail

# Run from the project root:
#   bash scripts/refresh-gtfs.sh

GTFS_URL="https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"
GTFS_ZIP="/tmp/SEQ_GTFS.zip"
GTFS_DIR="./postgres/gtfs"
DB_CONTAINER="wheresmybus-db"
PSQL="docker exec ${DB_CONTAINER} psql -U postgres -d wheresmybus"

echo "==> Downloading latest GTFS zip"
curl -fL "${GTFS_URL}" -o "${GTFS_ZIP}"

echo "==> Extracting into ${GTFS_DIR}"
mkdir -p "${GTFS_DIR}"
unzip -o "${GTFS_ZIP}" -d "${GTFS_DIR}" >/dev/null

echo "==> Cleaning up temp zip"
rm -f "${GTFS_ZIP}"

echo "==> Truncating GTFS tables"
${PSQL} -c "
SET search_path = gtfs, public;
TRUNCATE stop_times CASCADE;
TRUNCATE trips CASCADE;
TRUNCATE shapes CASCADE;
TRUNCATE calendar_dates CASCADE;
TRUNCATE calendar CASCADE;
TRUNCATE stops CASCADE;
TRUNCATE routes CASCADE;
"

echo "==> Reloading GTFS data"
${PSQL} -c "
SET search_path = gtfs, public;

COPY routes
FROM '/gtfs/routes.txt'
WITH (FORMAT csv, HEADER true);

COPY stops
FROM '/gtfs/stops.txt'
WITH (FORMAT csv, HEADER true);

COPY calendar
FROM '/gtfs/calendar.txt'
WITH (FORMAT csv, HEADER true);

COPY calendar_dates
FROM '/gtfs/calendar_dates.txt'
WITH (FORMAT csv, HEADER true);

COPY shapes
FROM '/gtfs/shapes.txt'
WITH (FORMAT csv, HEADER true);

COPY trips
FROM '/gtfs/trips.txt'
WITH (FORMAT csv, HEADER true);

COPY stop_times
FROM '/gtfs/stop_times.txt'
WITH (FORMAT csv, HEADER true);

ANALYZE;
"

echo "==> GTFS refresh complete."
