DROP VIEW IF EXISTS active_services_tomorrow;
CREATE VIEW active_services_tomorrow AS
SELECT service_id
FROM (
  SELECT c.service_id
  FROM calendar c
  WHERE CAST(c.start_date AS INTEGER) <= CAST(strftime('%Y%m%d','now','localtime','+1 day') AS INTEGER)
    AND CAST(c.end_date   AS INTEGER) >= CAST(strftime('%Y%m%d','now','localtime','+1 day') AS INTEGER)
    AND (
      (strftime('%w','now','localtime','+1 day') = '0' AND c.sunday    = 1) OR
      (strftime('%w','now','localtime','+1 day') = '1' AND c.monday    = 1) OR
      (strftime('%w','now','localtime','+1 day') = '2' AND c.tuesday   = 1) OR
      (strftime('%w','now','localtime','+1 day') = '3' AND c.wednesday = 1) OR
      (strftime('%w','now','localtime','+1 day') = '4' AND c.thursday  = 1) OR
      (strftime('%w','now','localtime','+1 day') = '5' AND c.friday    = 1) OR
      (strftime('%w','now','localtime','+1 day') = '6' AND c.saturday  = 1)
    )
  UNION
  SELECT cd.service_id
  FROM calendar_dates cd
  WHERE CAST(cd.date AS INTEGER) = CAST(strftime('%Y%m%d','now','localtime','+1 day') AS INTEGER)
    AND cd.exception_type = 1
)
EXCEPT
SELECT cd.service_id
FROM calendar_dates cd
WHERE CAST(cd.date AS INTEGER) = CAST(strftime('%Y%m%d','now','localtime','+1 day') AS INTEGER)
  AND cd.exception_type = 2;