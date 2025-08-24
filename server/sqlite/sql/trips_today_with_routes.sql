DROP VIEW trips_today_with_routes;

CREATE VIEW trips_today_with_routes AS
SELECT t.*, r.route_short_name, r.route_color, r.route_text_color
FROM trips_today t
    JOIN routes r ON r.route_id = t.route_id