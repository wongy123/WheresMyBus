-- === Core reference tables ===
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

-- GTFS calendar: a service may be defined in calendar, calendar_dates, or both
CREATE TABLE IF NOT EXISTS calendar (
  service_id TEXT PRIMARY KEY,
  monday INT,
  tuesday INT,
  wednesday INT,
  thursday INT,
  friday INT,
  saturday INT,
  sunday INT,
  start_date TEXT,  -- keep as TEXT (YYYYMMDD)
  end_date   TEXT
);

CREATE TABLE IF NOT EXISTS calendar_dates (
  service_id TEXT NOT NULL,
  date TEXT NOT NULL,            -- (YYYYMMDD)
  exception_type INT,
  PRIMARY KEY (service_id, date) -- spec-friendly PK
);

-- Shapes: composite PK enforces unique point ordering within a shape
CREATE TABLE IF NOT EXISTS shapes (
  shape_id TEXT NOT NULL,
  shape_pt_lat DOUBLE PRECISION NOT NULL,
  shape_pt_lon DOUBLE PRECISION NOT NULL,
  shape_pt_sequence INT NOT NULL,
  PRIMARY KEY (shape_id, shape_pt_sequence)
);

-- Helper table to make shape_id referencable by FK (one row per distinct shape_id)
CREATE TABLE IF NOT EXISTS shapes_index (
  shape_id TEXT PRIMARY KEY
);

-- Canonical set of services to support FKs from trips
CREATE TABLE IF NOT EXISTS services (
  service_id TEXT PRIMARY KEY
);

-- Trips reference routes, services, and (optionally) shapes
CREATE TABLE IF NOT EXISTS trips (
  route_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  trip_id TEXT PRIMARY KEY,
  trip_headsign TEXT,
  direction_id INT,
  block_id TEXT,
  shape_id TEXT,
  FOREIGN KEY (route_id)  REFERENCES routes(route_id)   ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (service_id) REFERENCES services(service_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (shape_id)  REFERENCES shapes_index(shape_id) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Stop times reference trips and stops; PK ensures one row per (trip, sequence)
CREATE TABLE IF NOT EXISTS stop_times (
  trip_id TEXT NOT NULL,
  arrival_time TEXT,     -- allow 24+:xx:xx
  departure_time TEXT,
  stop_id TEXT NOT NULL,
  stop_sequence INT NOT NULL,
  pickup_type INT,
  drop_off_type INT,
  PRIMARY KEY (trip_id, stop_sequence),
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (stop_id) REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE RESTRICT
);

-- === Indexes for common lookups/joins ===
CREATE INDEX IF NOT EXISTS idx_trips_route    ON trips(route_id);
CREATE INDEX IF NOT EXISTS idx_trips_service  ON trips(service_id);
CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times(stop_id);
-- composite PK on stop_times already indexes (trip_id, stop_sequence)
-- composite PK on shapes already indexes (shape_id, shape_pt_sequence)
CREATE INDEX IF NOT EXISTS idx_shapes_shape   ON shapes(shape_id);         -- fast fetch by shape_id
CREATE INDEX IF NOT EXISTS idx_cal_dates_date ON calendar_dates(date);     -- date-based queries
-- NOTE: calendar(service_id) already has a PK; a separate index is redundant
