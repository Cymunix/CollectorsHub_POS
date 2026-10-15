-- Read-only check: why the org Overview can show inventory while the org Inventory page is empty.
-- Run in the Supabase SQL editor. Change the organization code on the first line if needed.
-- Nothing is changed by this script.
WITH org AS (SELECT id FROM public.organizations WHERE org_code = 'ORG-0001')
SELECT s.store_name,
       s.store_code,
       count(si.id)                                                              AS inventory_records,
       count(si.id) FILTER (WHERE si.status = 'active')                          AS active_records,
       count(DISTINCT q.inventory_id)                                            AS records_with_stock_rows,
       count(DISTINCT q.inventory_id) FILTER (WHERE q.location_id IS NULL)       AS stock_rows_without_location,
       COALESCE(sum(q.quantity), 0)                                              AS units_on_hand,
       count(si.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.store_inventory_quantities x WHERE x.inventory_id = si.id)) AS records_with_no_quantity_row,
       (SELECT count(*) FROM public.store_locations l WHERE l.store_id = s.id)   AS locations
  FROM public.stores s
  LEFT JOIN public.store_inventory si ON si.store_id = s.id
  LEFT JOIN public.store_inventory_quantities q ON q.inventory_id = si.id
 WHERE s.organization_id = (SELECT id FROM org)
 GROUP BY s.id, s.store_name, s.store_code
 ORDER BY s.store_name;

-- And whether the Inventory page's functions exist in this database:
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('organization_stores', 'org_inventory', 'org_inventory_kpis');
