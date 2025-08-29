DROP VIEW IF EXISTS trips_yesterday;
CREATE VIEW trips_yesterday AS
SELECT t.*
FROM trips t
WHERE t.service_id IN (SELECT service_id FROM active_services_yesterday);