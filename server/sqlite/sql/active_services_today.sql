DROP VIEW active_services_today;
CREATE VIEW active_services_today AS
SELECT service_id
FROM (
  -- base calendar, correct weekday, within date range
  SELECT c.service_id
  FROM calendar c
  WHERE CAST(c.start_date AS INTEGER) <= CAST(strftime('%Y%m%d','now','localtime') AS INTEGER)
    AND CAST(c.end_date   AS INTEGER) >= CAST(strftime('%Y%m%d','now','localtime') AS INTEGER)
    AND (
      (strftime('%w','now','localtime') = '0' AND c.sunday    = 1) OR
      (strftime('%w','now','localtime') = '1' AND c.monday    = 1) OR
      (strftime('%w','now','localtime') = '2' AND c.tuesday   = 1) OR
      (strftime('%w','now','localtime') = '3' AND c.wednesday = 1) OR
      (strftime('%w','now','localtime') = '4' AND c.thursday  = 1) OR
      (strftime('%w','now','localtime') = '5' AND c.friday    = 1) OR
      (strftime('%w','now','localtime') = '6' AND c.saturday  = 1)
    )
  UNION
  -- added by exception today
  SELECT cd.service_id
  FROM calendar_dates cd
  WHERE CAST(cd.date AS INTEGER) = CAST(strftime('%Y%m%d','now','localtime') AS INTEGER)
    AND cd.exception_type = 1
)
EXCEPT
-- removed by exception today
SELECT cd.service_id
FROM calendar_dates cd
WHERE CAST(cd.date AS INTEGER) = CAST(strftime('%Y%m%d','now','localtime') AS INTEGER)
  AND cd.exception_type = 2