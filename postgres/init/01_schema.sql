-- Create and use the GTFS schema
CREATE SCHEMA IF NOT EXISTS gtfs;

SET search_path = gtfs, public;

-- === Reference tables ===

CREATE TABLE IF NOT EXISTS routes (
    route_id TEXT PRIMARY KEY,
    route_short_name TEXT,
    route_long_name TEXT,
    route_desc TEXT,
    route_type INT,
    route_url TEXT,
    route_color TEXT,
    route_text_color TEXT
);

CREATE TABLE IF NOT EXISTS stops (
    stop_id TEXT PRIMARY KEY,
    stop_code TEXT,
    stop_name TEXT,
    stop_desc TEXT,
    stop_lat DOUBLE PRECISION,
    stop_lon DOUBLE PRECISION,
    zone_id TEXT,
    stop_url TEXT,
    location_type INT,
    parent_station TEXT,
    platform_code TEXT
);

CREATE TABLE IF NOT EXISTS calendar (
    service_id TEXT PRIMARY KEY,
    monday INT,
    tuesday INT,
    wednesday INT,
    thursday INT,
    friday INT,
    saturday INT,
    sunday INT,
    start_date TEXT, -- YYYYMMDD
    end_date TEXT
);

CREATE TABLE IF NOT EXISTS calendar_dates (
    service_id TEXT NOT NULL,
    date TEXT NOT NULL, -- YYYYMMDD
    exception_type INT,
    PRIMARY KEY (service_id, date)
);

-- Each row is a point; composite PK enforces point order per shape
CREATE TABLE IF NOT EXISTS shapes (
    shape_id TEXT NOT NULL,
    shape_pt_lat DOUBLE PRECISION NOT NULL,
    shape_pt_lon DOUBLE PRECISION NOT NULL,
    shape_pt_sequence INT NOT NULL,
    PRIMARY KEY (shape_id, shape_pt_sequence)
);

-- === Link tables ===

CREATE TABLE IF NOT EXISTS trips (
    route_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    trip_id TEXT PRIMARY KEY,
    trip_headsign TEXT,
    direction_id INT,
    block_id TEXT,
    shape_id TEXT,
    FOREIGN KEY (route_id) REFERENCES routes (route_id) ON UPDATE CASCADE ON DELETE RESTRICT
    -- NOTE:
    -- 1) We intentionally DO NOT FK service_id here: some feeds define services only in calendar_dates.
    --    If you know your feed always lists services in calendar, you may add:
    --    FOREIGN KEY (service_id) REFERENCES calendar(service_id) ON UPDATE CASCADE ON DELETE RESTRICT
    -- 2) We DO NOT FK shape_id: shapes has many rows per shape_id; no unique target.
);

CREATE TABLE IF NOT EXISTS stop_times (
    trip_id TEXT NOT NULL,
    arrival_time TEXT, -- allow 24+:xx:xx strings
    departure_time TEXT,
    stop_id TEXT NOT NULL,
    stop_sequence INT NOT NULL,
    pickup_type INT,
    drop_off_type INT,
    PRIMARY KEY (trip_id, stop_sequence),
    FOREIGN KEY (trip_id) REFERENCES trips (trip_id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (stop_id) REFERENCES stops (stop_id) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- === Indexes for common queries ===
CREATE INDEX IF NOT EXISTS idx_trips_route ON trips (route_id);

CREATE INDEX IF NOT EXISTS idx_trips_service ON trips (service_id);
-- speed lookups by service_id (no FK)
CREATE INDEX IF NOT EXISTS idx_trips_shape ON trips (shape_id);
-- speed joins to shapes by shape_id
CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times (stop_id);
-- composite PKs already cover (trip_id, stop_sequence) and (shape_id, shape_pt_sequence)
CREATE INDEX IF NOT EXISTS idx_shapes_shape_only ON shapes (shape_id);

CREATE INDEX IF NOT EXISTS idx_cal_dates_date ON calendar_dates (date);