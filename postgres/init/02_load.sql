SET search_path = gtfs, public;

-- Load parents/reference tables first
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

-- Then link tables
COPY trips
FROM '/gtfs/trips.txt'
WITH (FORMAT csv, HEADER true);

COPY stop_times
FROM '/gtfs/stop_times.txt'
WITH (FORMAT csv, HEADER true);

ANALYZE;