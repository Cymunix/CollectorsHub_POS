-- READ-ONLY: where XP and levels are stored. Nothing is changed. Run it and send the result.
-- Lists (1) every column whose name mentions xp / level / experience, with how many rows hold a
-- non-zero value, and (2) every table whose name mentions xp / experience / level / achievement.
SELECT 'column' AS kind,
       c.table_name || '.' || c.column_name AS name,
       c.data_type,
       (xpath('/row/c/text()', query_to_xml(format(
          'SELECT count(*) AS c FROM public.%I WHERE %I IS NOT NULL AND %I::text NOT IN (''0'', ''1'', '''')',
          c.table_name, c.column_name, c.column_name), false, true, '')))[1]::text::bigint AS rows_with_value
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
 WHERE c.table_schema = 'public'
   AND (c.column_name ~* '(^|_)xp($|_)' OR c.column_name ~* 'experience' OR c.column_name ~* '(^|_)level($|_)')
UNION ALL
SELECT 'table',
       t.table_name,
       '',
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t.table_name), false, true, '')))[1]::text::bigint
  FROM information_schema.tables t
 WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
   AND (t.table_name ~* '(^|_)xp($|_)' OR t.table_name ~* 'experience' OR t.table_name ~* 'level' OR t.table_name ~* 'achievement|badge|reward')
 ORDER BY 1, 2;
