-- Collector Listings (2026-10-21): copies collectors have listed for sale on the website
-- (owned_copies.sale_status = 'listed'), for store staff to look through as buying
-- opportunities. Run after wishlist_open_profiles.sql. Safe to run more than once.
--
-- Each listing shows the item, condition / grade, the collector's asking price and photos,
-- and the demand the store can see for that item: how many members want it (members whose
-- wishlist this store can see, never counting the seller) and the average price they'd pay,
-- plus how many the store already has in stock.
-- A seller's username is shown only when their profile is open; otherwise "a member".

CREATE INDEX IF NOT EXISTS owned_copies_listed_idx ON public.owned_copies (catalog_item_id) WHERE sale_status = 'listed';

DROP FUNCTION IF EXISTS public.store_collector_listings(uuid, text, text, integer, integer);
CREATE OR REPLACE FUNCTION public.store_collector_listings(p_store_id uuid, p_filter text DEFAULT 'wanted', p_search text DEFAULT '',
                                                           p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_term text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  RETURN jsonb_build_object(
    'total_listed', (SELECT count(*) FROM public.owned_copies WHERE sale_status = 'listed'),
    'rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.wanted_members DESC, x.listed_at DESC NULLS LAST)
        FROM (
          SELECT oc.id AS copy_id,
                 oc.catalog_item_id,
                 i.name, i.card_number, i.release_year, i.image_path,
                 cat.name AS category,
                 oc.condition, oc.grading_company, oc.grade,
                 oc.sale_price AS asking_price,
                 oc.front_image_url, oc.back_image_url,
                 COALESCE(NULLIF(oc.metadata->>'listed_at', '')::timestamptz, oc.updated_at) AS listed_at,
                 CASE WHEN COALESCE(p.public_profile_enabled, false) THEN p.username END AS seller_username,
                 concat_ws(', ', NULLIF(btrim(p.notification_town), ''), NULLIF(btrim(p.notification_province_state), '')) AS seller_area,
                 COALESCE(d.members, 0) AS wanted_members,
                 COALESCE(d.priced, 0) AS wanted_priced,
                 d.average_price AS wanted_average_price,
                 COALESCE(s.available, 0) AS store_in_stock
            FROM public.owned_copies oc
            JOIN public.items i ON i.item_id = oc.catalog_item_id
            LEFT JOIN public.categories cat ON cat.category_id = i.category_id
            LEFT JOIN public.profiles p ON p.id = oc.user_id
            LEFT JOIN LATERAL (
              SELECT count(DISTINCT w.user_id)::integer AS members,
                     count(w.wanted_price)::integer AS priced,
                     round(avg(w.wanted_price), 2) AS average_price
                FROM public.wishlist_items w
               WHERE w.catalog_item_id = oc.catalog_item_id
                 AND w.user_id <> oc.user_id
                 AND public.customers_wishlist_granted(p_store_id, w.user_id)
            ) d ON true
            LEFT JOIN public.customers_available_stock(p_store_id, NULL) s ON s.catalog_item_id = oc.catalog_item_id
           WHERE oc.sale_status = 'listed'
             AND (p_filter IS DISTINCT FROM 'wanted' OR COALESCE(d.members, 0) > 0)
             AND (v_term IS NULL OR i.name ILIKE '%' || v_term || '%' OR i.card_number ILIKE v_term)
           ORDER BY COALESCE(d.members, 0) DESC, COALESCE(NULLIF(oc.metadata->>'listed_at', '')::timestamptz, oc.updated_at) DESC NULLS LAST
           LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500) OFFSET GREATEST(COALESCE(p_offset, 0), 0)
        ) x), '[]'::jsonb)
  );
END $$;
REVOKE ALL ON FUNCTION public.store_collector_listings(uuid, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_collector_listings(uuid, text, text, integer, integer) TO authenticated;
