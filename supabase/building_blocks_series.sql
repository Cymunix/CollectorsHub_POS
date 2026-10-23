-- Building Blocks: an optional Series between Subfranchise and Collection
-- (LEGO Agents -> "Agents 1.0" / "Agents 2.0"). Only Building Blocks uses it.
--
-- Not the existing "Series" facet (series table / items.series_id: Ultimate
-- Collector Series, Battle Pack, Topps Chrome…, filtering only), which is
-- unchanged and is shown as "Branded Series" in the apps.
--
-- Completion Explorer: a Building Blocks subfranchise whose items have a
-- Series opens a Series level (completion_series), each listing its items
-- (completion_series_items / completion_series_finishes). Items with no Series
-- in a subfranchise that has some are grouped as "No series"; a subfranchise
-- with no Series at all stays the leaf exactly as before. Counts come from the
-- same items as the subfranchise's own totals, so nothing is counted twice; the
-- precomputed completion_totals / completion_rollups are not changed.
--
-- Additive: no existing rows are modified. Rerunnable.

BEGIN;

ALTER TABLE public.items ADD COLUMN IF NOT EXISTS series text;
COMMENT ON COLUMN public.items.series IS
  'Building Blocks only: optional Series under the Subfranchise (e.g. Agents 1.0). Not the series_id facet (Branded Series).';

CREATE INDEX IF NOT EXISTS items_completion_series_idx
  ON public.items (subset_id, series)
  WHERE completion_eligible = true AND series IS NOT NULL;

-- The Series of a subfranchise, with the user's completion. Empty when none
-- of its items has a Series (the subfranchise is then the leaf).
CREATE OR REPLACE FUNCTION public.completion_series(p_subset_id uuid)
RETURNS TABLE(
  scope_type text, scope_id uuid, name text, series text, subset_id uuid,
  owned_count int, total_count int, completion_percent numeric,
  collected_value numeric, estimated_cost_to_complete numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT i.item_id,
           NULLIF(btrim(i.series), '') AS series,
           COALESCE(i.market_value, 0) AS market_value,
           EXISTS (
             SELECT 1 FROM public.owned_copies oc
             WHERE oc.user_id = auth.uid()
               AND oc.catalog_item_id = i.item_id
               AND COALESCE(oc.sale_status, 'private') <> 'sold'
           ) AS owned
    FROM public.items i
    WHERE i.subset_id = p_subset_id
      AND i.completion_eligible = true
  )
  SELECT 'bb_series'::text,
         md5(p_subset_id::text || ':series:' || COALESCE(lower(series), '~null'))::uuid AS scope_id,
         COALESCE(min(series), 'No series') AS name,
         min(series) AS series,
         p_subset_id AS subset_id,
         count(*) FILTER (WHERE owned)::int AS owned_count,
         count(*)::int AS total_count,
         CASE WHEN count(*) > 0
              THEN round(100.0 * count(*) FILTER (WHERE owned) / count(*), 2)
              ELSE 0 END AS completion_percent,
         COALESCE(sum(market_value) FILTER (WHERE owned), 0) AS collected_value,
         GREATEST(COALESCE(sum(market_value), 0) - COALESCE(sum(market_value) FILTER (WHERE owned), 0), 0)
           AS estimated_cost_to_complete
  FROM scoped
  WHERE EXISTS (SELECT 1 FROM scoped s WHERE s.series IS NOT NULL)
  -- "Agents 1.0" and "agents 1.0" are one Series, never two entries.
  GROUP BY lower(series)
  ORDER BY (lower(series) IS NULL), lower(series);
$$;

-- One Series' items (p_series NULL = the subfranchise's items with no Series),
-- the same columns as completion_set_items.
CREATE OR REPLACE FUNCTION public.completion_series_items(p_subset_id uuid, p_series text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_finish text DEFAULT NULL::text)
RETURNS TABLE(item_id uuid, name text, card_number text, set_code text, finish text, image_path text, owned boolean)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT i.item_id, i.name, i.card_number,
         i.dynamic_fields->>'set_code' AS set_code,
         COALESCE(
           CASE i.external_ids->>'entity_type'
             WHEN 'set' THEN 'Set' WHEN 'minifig' THEN 'Minifig' END,
           i.dynamic_fields->>'finish'
         ) AS finish,
         img.image_path,
         EXISTS (
           SELECT 1 FROM public.owned_copies oc
           WHERE oc.user_id = auth.uid()
             AND oc.catalog_item_id = i.item_id
             AND COALESCE(oc.sale_status, 'private') <> 'sold'
         ) AS owned
  FROM public.items i
  LEFT JOIN LATERAL (
    SELECT image_path FROM public.item_images im WHERE im.item_id = i.item_id ORDER BY position LIMIT 1
  ) img ON true
  WHERE i.subset_id = p_subset_id
    AND i.completion_eligible = true
    AND lower(NULLIF(btrim(i.series), '')) IS NOT DISTINCT FROM lower(NULLIF(btrim(p_series), ''))
    AND (p_finish IS NULL OR COALESCE(
          CASE i.external_ids->>'entity_type'
            WHEN 'set' THEN 'Set' WHEN 'minifig' THEN 'Minifig' END,
          i.dynamic_fields->>'finish'
        ) = p_finish)
  ORDER BY COALESCE(NULLIF(substring(i.card_number from '^[0-9]{1,9}'), '')::int, 2147483647), i.card_number, i.name
  LIMIT GREATEST(1, LEAST(p_limit, 200)) OFFSET GREATEST(0, p_offset);
$$;

CREATE OR REPLACE FUNCTION public.completion_series_finishes(p_subset_id uuid, p_series text)
RETURNS TABLE(finish text, owned_count integer, total_count integer)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT f.finish,
         count(*) FILTER (WHERE f.owned)::int AS owned_count,
         count(*)::int AS total_count
  FROM (
    SELECT COALESCE(
             CASE i.external_ids->>'entity_type'
               WHEN 'set' THEN 'Set' WHEN 'minifig' THEN 'Minifig' END,
             i.dynamic_fields->>'finish'
           ) AS finish,
           EXISTS (
             SELECT 1 FROM public.owned_copies oc
             WHERE oc.user_id = auth.uid()
               AND oc.catalog_item_id = i.item_id
               AND COALESCE(oc.sale_status, 'private') <> 'sold'
           ) AS owned
    FROM public.items i
    WHERE i.subset_id = p_subset_id
      AND i.completion_eligible = true
      AND lower(NULLIF(btrim(i.series), '')) IS NOT DISTINCT FROM lower(NULLIF(btrim(p_series), ''))
  ) f
  WHERE f.finish IS NOT NULL
  GROUP BY f.finish
  ORDER BY CASE f.finish WHEN 'Set' THEN 0 WHEN 'Minifig' THEN 1 ELSE 2 END, f.finish;
$$;

GRANT EXECUTE ON FUNCTION public.completion_series(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.completion_series_items(uuid, text, integer, integer, text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.completion_series_finishes(uuid, text) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
COMMIT;
