-- Load reference data first (parents)
COPY routes        FROM '/gtfs/routes.txt'        WITH (FORMAT csv, HEADER true);
COPY stops         FROM '/gtfs/stops.txt'         WITH (FORMAT csv, HEADER true);
COPY calendar      FROM '/gtfs/calendar.txt'      WITH (FORMAT csv, HEADER true);
COPY calendar_datesFROM '/gtfs/calendar_dates.txt'WITH (FORMAT csv, HEADER true);

-- Shapes before trips; then build shapes_index for FK
COPY shapes        FROM '/gtfs/shapes.txt'        WITH (FORMAT csv, HEADER true);

-- Populate canonical service list (for FK from trips)
TRUNCATE services;
INSERT INTO services(service_id)
SELECT DISTINCT service_id FROM calendar
UNION
SELECT DISTINCT service_id FROM calendar_dates;

-- Populate shape ids (for FK from trips.shape_id)
TRUNCATE shapes_index;
INSERT INTO shapes_index(shape_id)
SELECT DISTINCT shape_id FROM shapes;

-- Now load trips (FKs to routes, services, shapes_index)
COPY trips         FROM '/gtfs/trips.txt'         WITH (FORMAT csv, HEADER true);

-- Finally load stop_times (FKs to trips, stops)
COPY stop_times    FROM '/gtfs/stop_times.txt'    WITH (FORMAT csv, HEADER true);
