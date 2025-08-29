DROP VIEW IF EXISTS stop_events_3day;
CREATE VIEW stop_events_3day AS
SELECT se.*, (se.event_sec - 86400) AS win_sec, 'yesterday' AS day_bucket
FROM stop_events_yesterday se
UNION ALL
SELECT se.*, (se.event_sec)         AS win_sec, 'today'     AS day_bucket
FROM stop_events_today     se
UNION ALL
SELECT se.*, (se.event_sec + 86400) AS win_sec, 'tomorrow'  AS day_bucket
FROM stop_events_tomorrow se;