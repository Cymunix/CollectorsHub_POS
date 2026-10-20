-- Resets every CollectorsHub user's XP and level (approved 2026-10-20, as part of the fresh start).
--   * XP: every XP event is removed (a user's XP is the total of their xp_events).
--   * Level: profiles.collector_level goes back to the column's starting (default) value, or 1
--     when the column has no default.
-- Accounts, usernames and everything else on the profile are untouched.
-- The result shows the numbers before and after, plus any other XP / level columns in the
-- database that still hold values (they would need resetting too).
BEGIN;

CREATE TEMP TABLE xp_reset_report (step text, what text, value text) ON COMMIT DROP;

INSERT INTO xp_reset_report
SELECT 'before', 'XP events', count(*)::text FROM public.xp_events
UNION ALL SELECT 'before', 'total XP', COALESCE(sum(xp), 0)::text FROM public.xp_events
UNION ALL SELECT 'before', 'users with XP', count(DISTINCT user_id)::text FROM public.xp_events
UNION ALL SELECT 'before', 'profiles by level', COALESCE(string_agg(level || ': ' || n, ', ' ORDER BY level), 'none')
  FROM (SELECT COALESCE(collector_level::text, 'null') AS level, count(*) AS n FROM public.profiles GROUP BY 1) l;

DELETE FROM public.xp_events;

DO $$
DECLARE
  starting text;
BEGIN
  SELECT column_default INTO starting
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'collector_level';
  IF starting IS NOT NULL THEN
    UPDATE public.profiles SET collector_level = DEFAULT;
  ELSE
    UPDATE public.profiles SET collector_level = 1;
  END IF;
  INSERT INTO xp_reset_report VALUES ('info', 'starting level used', COALESCE(starting, '1 (no default on the column)'));
END
$$;

INSERT INTO xp_reset_report
SELECT 'after', 'XP events', count(*)::text FROM public.xp_events
UNION ALL SELECT 'after', 'profiles by level', COALESCE(string_agg(level || ': ' || n, ', ' ORDER BY level), 'none')
  FROM (SELECT COALESCE(collector_level::text, 'null') AS level, count(*) AS n FROM public.profiles GROUP BY 1) l;

-- Any other column that looks like XP or level and still holds a value.
INSERT INTO xp_reset_report
SELECT 'check', c.table_name || '.' || c.column_name,
       (xpath('/row/c/text()', query_to_xml(format(
          'SELECT count(*) AS c FROM public.%I WHERE %I IS NOT NULL AND %I::text NOT IN (''0'', '''')',
          c.table_name, c.column_name, c.column_name), false, true, '')))[1]::text || ' rows with a value'
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
 WHERE c.table_schema = 'public'
   AND NOT (c.table_name = 'profiles' AND c.column_name = 'collector_level')
   AND (c.column_name ~* '(^|_)xp($|_)' OR c.column_name ~* 'experience' OR c.column_name ~* '(^|_)level($|_)');

SELECT step, what, value FROM xp_reset_report
 ORDER BY CASE step WHEN 'before' THEN 1 WHEN 'info' THEN 2 WHEN 'after' THEN 3 ELSE 4 END, what;

COMMIT;
