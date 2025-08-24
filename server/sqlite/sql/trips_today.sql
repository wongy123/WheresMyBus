DROP VIEW trips_today;

CREATE VIEW trips_today AS
SELECT t.*
FROM trips t
WHERE
    t.service_id IN (
        SELECT service_id
        FROM active_services_today
    )