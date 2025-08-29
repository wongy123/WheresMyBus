DROP VIEW IF EXISTS trips_tomorrow;
CREATE VIEW trips_tomorrow AS
SELECT t.*
FROM trips t
WHERE t.service_id IN (SELECT service_id FROM active_services_tomorrow);