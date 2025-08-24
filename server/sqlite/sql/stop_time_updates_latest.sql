DROP VIEW stop_time_updates_latest;

CREATE VIEW stop_time_updates_latest AS
SELECT u.trip_id, u.stop_id, u.arrival_delay, u.departure_delay
FROM
    stop_time_updates u
    JOIN (
        SELECT trip_id, stop_id, MAX(rowid) AS max_rowid
        FROM stop_time_updates
        GROUP BY
            trip_id,
            stop_id
    ) m ON m.trip_id = u.trip_id
    AND m.stop_id = u.stop_id
    AND m.max_rowid = u.rowid