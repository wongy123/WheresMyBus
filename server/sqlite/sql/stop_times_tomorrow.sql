DROP VIEW IF EXISTS stop_times_tomorrow;
CREATE VIEW stop_times_tomorrow AS
SELECT
    st.*,
    t.service_id,
    t.route_id,
    t.trip_headsign,
    t.direction_id,
    ( CAST(substr(st.arrival_time, 1, instr(st.arrival_time, ':') - 1) AS INTEGER) * 3600
    + CAST(substr(st.arrival_time, instr(st.arrival_time, ':') + 1, 2) AS INTEGER) * 60
    + CAST(substr(st.arrival_time, length(st.arrival_time) - 1, 2) AS INTEGER) ) AS arr_sec_base,
    ( CAST(substr(st.departure_time, 1, instr(st.departure_time, ':') - 1) AS INTEGER) * 3600
    + CAST(substr(st.departure_time, instr(st.departure_time, ':') + 1, 2) AS INTEGER) * 60
    + CAST(substr(st.departure_time, length(st.departure_time) - 1, 2) AS INTEGER) ) AS dep_sec_base
FROM stop_times st
JOIN trips_tomorrow t ON t.trip_id = st.trip_id;