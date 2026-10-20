-- READ-ONLY preview: everything that "wipe all item data" would empty, with row counts.
-- Nothing is changed by this script. Run it in the Supabase SQL editor and send the result.
--
-- Starts from the item tables (catalogue items, store stock, sold prices) and follows every
-- foreign key that points at them, so the list includes tables created outside this repo
-- (e.g. collector collections and wishlists on the website).
WITH RECURSIVE roots(relid) AS (
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('items', 'store_inventory', 'market_sales')
),
-- via = the table it points at (an oid, turned into a name at the end).
dependents(relid, via, depth) AS (
  SELECT relid, NULL::oid, 0 FROM roots
  UNION
  SELECT con.conrelid, d.relid, d.depth + 1
    FROM pg_constraint con JOIN dependents d ON con.confrelid = d.relid
   WHERE con.contype = 'f' AND con.conrelid <> d.relid AND d.depth < 6
),
tables AS (
  SELECT DISTINCT ON (d.relid) d.relid, n.nspname AS schema_name, c.relname AS table_name, d.via, d.depth
    FROM dependents d JOIN pg_class c ON c.oid = d.relid JOIN pg_namespace n ON n.oid = c.relnamespace
   ORDER BY d.relid, d.depth
)
SELECT t.depth,
       t.schema_name || '.' || t.table_name AS table_name,
       COALESCE(t.via::regclass::text, '(starting table)') AS references,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', t.schema_name, t.table_name), false, true, '')))[1]::text::bigint AS row_count
  FROM tables t
 ORDER BY t.depth, t.table_name;
