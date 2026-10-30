-- POS inventory snapshot (2026-10-29). Safe to run more than once.
--
-- The desktop sync used to fetch stock quantities, inventory rows, catalogue items, categories
-- and images in batches of 100-1,000 ids, one request after another (about 150 requests for a
-- 5,000-item store). This returns the same data for one store location in a single request.
--
-- SECURITY INVOKER: the caller's row level security still decides which stores they can read.
-- Returns one jsonb array (not a set of rows), so PostgREST's 1,000-row limit doesn't cut it off.
-- Image paths are storage paths (or full URLs); the app turns them into public URLs.

CREATE OR REPLACE FUNCTION public.pos_inventory_snapshot(p_store_id uuid, p_location_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(row_to_json(snap)::jsonb ORDER BY snap.quantity_updated_at DESC NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT
      inv.id,
      inv.store_id,
      inv.catalog_item_id,
      inv.sku,
      inv.barcode,
      inv.condition,
      inv.grade,
      inv.grading_company,
      inv.cert_number,
      inv.buy_price,
      inv.sell_price,
      inv.in_store_price,
      inv.name_snapshot,
      inv.status,
      inv.is_trade_in,
      inv.listed_for_sale,
      q.location_id,
      q.quantity,
      q.quantity_reserved,
      q.updated_at AS quantity_updated_at,
      it.name AS catalog_name,
      coalesce(nullif(it.card_number, ''), nullif(it.lego_set_number, ''), nullif(it.minifig_code, '')) AS catalog_number,
      cat.name AS category_name,
      it.market_price,
      it.retail_price,
      coalesce(nullif(it.dynamic_fields->>'finish', ''), it.dynamic_fields->>'foil') AS finish,
      it.image_path AS catalog_image_path,
      (SELECT sii.storage_path FROM store_inventory_images sii
        WHERE sii.inventory_id = inv.id AND sii.storage_path IS NOT NULL
        ORDER BY sii.position LIMIT 1) AS inventory_image_path,
      (SELECT ii.image_path FROM item_images ii
        WHERE ii.item_id = inv.catalog_item_id AND ii.image_path IS NOT NULL
        ORDER BY ii.position LIMIT 1) AS item_image_path
    FROM store_inventory_quantities q
    JOIN store_inventory inv
      ON inv.id = q.inventory_id AND inv.store_id = p_store_id AND inv.status = 'active'
    LEFT JOIN items it ON it.item_id = inv.catalog_item_id
    LEFT JOIN categories cat ON cat.category_id = it.category_id
    WHERE q.store_id = p_store_id
      AND q.location_id = p_location_id
      AND q.quantity >= 0
  ) snap
$$;

REVOKE ALL ON FUNCTION public.pos_inventory_snapshot(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.pos_inventory_snapshot(uuid, uuid) TO authenticated;
