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

-- Any other column in the app's own tables that looks like XP or level and still holds a value.
-- Only ordinary tables in the public schema are looked at; a column that can't be counted is
-- listed as such rather than stopping the reset.
DO $$
DECLARE
  col record;
  n bigint;
BEGIN
  FOR col IN
    SELECT cl.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE ns.nspname = 'public'
       AND cl.relkind IN ('r', 'p')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND NOT (cl.relname = 'profiles' AND a.attname = 'collector_level')
       AND (a.attname ~* '(^|_)xp($|_)' OR a.attname ~* 'experience' OR a.attname ~* '(^|_)level($|_)')
  LOOP
    BEGIN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NOT NULL AND %I::text NOT IN (''0'', '''')',
                     col.table_name, col.column_name, col.column_name) INTO n;
      INSERT INTO xp_reset_report VALUES ('check', col.table_name || '.' || col.column_name, n || ' rows with a value');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO xp_reset_report VALUES ('check', col.table_name || '.' || col.column_name, 'could not count: ' || SQLERRM);
    END;
  END LOOP;
END
$$;

SELECT step, what, value FROM xp_reset_report
 ORDER BY CASE step WHEN 'before' THEN 1 WHEN 'info' THEN 2 WHEN 'after' THEN 3 ELSE 4 END, what;

COMMIT;
