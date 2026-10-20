-- READ-ONLY preview, part 2: tables that store an item id WITHOUT a foreign key to items
-- (so the first preview couldn't see them; wiping items would leave them pointing at nothing),
-- plus the store transaction tables, plus the catalogue structure under categories. Nothing is changed. Run it and send the result.
WITH linked AS (
  -- Tables already found by part 1 (they have a foreign key to the item tables).
  SELECT DISTINCT con.conrelid AS relid
    FROM pg_constraint con
   WHERE con.contype = 'f'
     AND con.confrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relname IN ('items', 'store_inventory', 'market_sales'))
),
candidates AS (
  SELECT c.oid AS relid, c.relname AS table_name, string_agg(a.attname, ', ' ORDER BY a.attname) AS item_columns
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE a.attnum > 0 AND NOT a.attisdropped
     AND a.attname IN ('item_id', 'catalog_item_id', 'catalogue_item_id', 'catalog_id', 'catalogue_id', 'inventory_id', 'items_id')
     AND c.relname NOT IN ('items', 'store_inventory', 'market_sales')
     AND c.oid NOT IN (SELECT relid FROM linked)
   GROUP BY c.oid, c.relname
)
SELECT 'no foreign key' AS kind, 'public.' || table_name AS table_name, item_columns,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text::bigint AS row_count
  FROM candidates
UNION ALL
SELECT 'store transactions', 'public.' || c.relname, '',
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname IN ('store_transactions', 'store_transaction_payments', 'store_return_records', 'store_refund_requests', 'store_transaction_audit', 'store_checkout_groups')
UNION ALL
-- Catalogue structure: tables the item tables point TO (subcategories, franchises, sets, teams,
-- subjects, brands...). Categories are kept; account/store tables are listed so you can see them.
SELECT 'catalogue structure (points to)', 'public.' || t.relname,
       'referenced by ' || string_agg(DISTINCT s.relname, ', '),
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t.relname), false, true, '')))[1]::text::bigint
  FROM pg_constraint con
  JOIN pg_class s ON s.oid = con.conrelid
  JOIN pg_class t ON t.oid = con.confrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
 WHERE con.contype = 'f'
   AND (s.relname IN ('items', 'subcategories', 'franchises', 'collectible_sets', 'properties', 'subsets')
        OR s.relname LIKE 'item_%' OR s.relname LIKE 'franchise_%' OR s.relname LIKE 'set_%')
   AND t.relname NOT IN ('items', 'store_inventory', 'market_sales')
 GROUP BY t.relname
 ORDER BY 1, 2;
