DROP VIEW IF EXISTS stop_events_yesterday;
CREATE VIEW stop_events_yesterday AS
SELECT
  st.route_id,
  r.route_short_name,
  r.route_color,
  r.route_text_color,
  r.route_type,
  st.service_id,
  st.trip_id,
  st.trip_headsign,
  st.direction_id,
  st.stop_id,
  s.stop_code,
  s.stop_name,
  st.arrival_time,
  st.departure_time,
  st.stop_sequence,
  u.arrival_delay,
  u.departure_delay,
  CASE WHEN u.trip_id IS NOT NULL THEN 1 ELSE 0 END AS real_time_data,
  (st.arr_sec_base + COALESCE(u.arrival_delay,0))   AS estimated_arrival_sec,
  (st.dep_sec_base + COALESCE(u.departure_delay,0)) AS estimated_departure_sec,
  printf('%02d:%02d:%02d',
    ((st.arr_sec_base + COALESCE(u.arrival_delay,0)) / 3600),
    ((st.arr_sec_base + COALESCE(u.arrival_delay,0)) / 60) % 60,
    ((st.arr_sec_base + COALESCE(u.arrival_delay,0)) % 60)
  ) AS estimated_arrival_time,
  printf('%02d:%02d:%02d',
    ((st.dep_sec_base + COALESCE(u.departure_delay,0)) / 3600),
    ((st.dep_sec_base + COALESCE(u.departure_delay,0)) / 60) % 60,
    ((st.dep_sec_base + COALESCE(u.departure_delay,0)) % 60)
  ) AS estimated_departure_time,
  COALESCE(
    (st.arr_sec_base + COALESCE(u.arrival_delay,0)),
    (st.dep_sec_base + COALESCE(u.departure_delay,0))
  ) AS event_sec
FROM stop_times_yesterday st
JOIN routes r ON r.route_id = st.route_id
JOIN stops  s ON s.stop_id  = st.stop_id
LEFT JOIN stop_time_updates_latest u
  ON u.trip_id = st.trip_id AND u.stop_id = st.stop_id;
