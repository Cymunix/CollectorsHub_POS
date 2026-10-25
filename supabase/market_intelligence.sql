-- Market Intelligence & LEGO inspection.
--
-- Market data stays in the one central market_sales table (completed sales
-- only, de-duplicated by source + sale id / fingerprint), shared by the
-- website and the POS. This migration adds:
--   * market_sales.pricing_group / normalized_price / normalized_currency
--     (optional; set by importers, never invented),
--   * catalog_item_relationships.source / source_ref / verified,
--   * store_purchase_policies  - each store's buying percentages,
--   * purchase_inspections     - what was inspected and offered for a bought
--     item, saved against its new stock record and transaction,
--   * read functions: market_intelligence (history for one item, by pricing
--     group), market_set_contents (a LEGO set's minifigures with their own
--     prices), market_store_activity (the store's own stock and sales).
--
-- Pricing groups: cards "ungraded" or "graded:<COMPANY>:<grade>" (certified
-- grades never mixed); Building Blocks sealed / used_complete /
-- used_incomplete; anything else its condition, or "all".
--
-- Store-private data (inspections, purchase prices, policies, store sales) is
-- readable only by that store's members and NORDVIK administrators.
-- Additive: no existing rows or functions are changed. Rerunnable.

BEGIN;

ALTER TABLE public.market_sales
  ADD COLUMN IF NOT EXISTS pricing_group text,
  ADD COLUMN IF NOT EXISTS normalized_price numeric(12,2),
  ADD COLUMN IF NOT EXISTS normalized_currency text;
COMMENT ON COLUMN public.market_sales.pricing_group IS 'Optional explicit pricing group (ungraded, graded:PSA:10, sealed, used_complete, used_incomplete…). When NULL it is derived from the sale''s grading/condition.';
COMMENT ON COLUMN public.market_sales.normalized_price IS 'sold_price converted to normalized_currency by the importer at a recorded rate. Never estimated.';

-- What customers see about a stock item's condition and contents (written
-- from the purchase inspection, editable by staff). Never purchase details.
ALTER TABLE public.store_inventory ADD COLUMN IF NOT EXISTS listing_notes text;
COMMENT ON COLUMN public.store_inventory.listing_notes IS 'Public description of the item''s condition and contents (e.g. missing minifigures), shown on the website and used for online listings. Purchase prices and buying details never go here.';

ALTER TABLE public.catalog_item_relationships
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS source_ref text,
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT true;

-- The pricing group of a sale (see the header).
CREATE OR REPLACE FUNCTION public.market_pricing_group(p_explicit text, p_is_graded boolean, p_company text, p_grade numeric, p_condition text, p_category text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN nullif(trim(coalesce(p_explicit, '')), '') IS NOT NULL THEN lower(trim(p_explicit))
    WHEN coalesce(p_is_graded, false) THEN
      CASE WHEN nullif(trim(coalesce(p_company, '')), '') IS NULL OR p_grade IS NULL THEN 'graded:unknown'
           ELSE 'graded:' || upper(trim(p_company)) || ':' || trim_scale(p_grade)::text END
    WHEN coalesce(p_category, '') ~* '(lego|building block)' THEN
      CASE WHEN coalesce(p_condition, '') ~* '(incomplete|missing|damaged)' THEN 'used_incomplete'
           WHEN coalesce(p_condition, '') ~* '(seal|^new|new/|brand new)' THEN 'sealed'
           WHEN coalesce(p_condition, '') ~* '(complete|100%|pre-owned|used)' THEN 'used_complete'
           ELSE 'unknown' END
    WHEN coalesce(p_category, '') ~* 'card' THEN 'ungraded'
    WHEN nullif(trim(coalesce(p_condition, '')), '') IS NOT NULL THEN 'condition:' || lower(trim(p_condition))
    ELSE 'all'
  END
$$;

-- ── Store buying policies ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_purchase_policies (
  store_id                         uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  default_percent                  numeric(5,2) NOT NULL DEFAULT 75 CHECK (default_percent >= 0 AND default_percent <= 200),
  category_percents                jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "Sports Cards": 70 }
  lego_percents                    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "sealed": 85, "used_complete": 80, "used_incomplete": 60 }
  box_required_for_complete        boolean NOT NULL DEFAULT false,
  instructions_required_for_complete boolean NOT NULL DEFAULT false,
  updated_by                       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at                       timestamptz NOT NULL DEFAULT now()
);

-- ── Purchase inspections ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchase_inspections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id               uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  transaction_id         uuid REFERENCES public.store_transactions(id) ON DELETE SET NULL,
  transaction_item_id    uuid REFERENCES public.store_transaction_items(id) ON DELETE SET NULL,
  inventory_id           uuid REFERENCES public.store_inventory(id) ON DELETE SET NULL,
  catalog_item_id        uuid REFERENCES public.items(item_id) ON DELETE SET NULL,
  quantity               integer NOT NULL DEFAULT 1,
  condition              text,
  pricing_group          text,
  minifigs               jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ item_id, name, code, required, present, missing, price, price_source }]
  missing_pieces         text,
  missing_accessories    text,
  instructions           text CHECK (instructions IN ('present','missing','unknown')),
  box                    text CHECK (box IN ('present','missing','unknown')),
  damage                 text,
  notes                  text,
  market_reference       numeric(12,2),     -- the median used (e.g. Used Complete)
  market_reference_label text,
  market_currency        text,
  market_sales_count     integer,
  market_data_at         timestamptz,       -- the newest sale behind the reference
  deductions             numeric(12,2),
  deduction_complete     boolean,
  adjusted_reference     numeric(12,2),
  buy_percent            numeric(5,2),
  buy_rule               text,
  baseline               numeric(12,2),
  final_offer            numeric(12,2),
  inspected_by_employee  uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  inspected_by_user      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_inspections_inventory_idx ON public.purchase_inspections(inventory_id);
CREATE INDEX IF NOT EXISTS purchase_inspections_store_idx ON public.purchase_inspections(store_id, created_at);

ALTER TABLE public.store_purchase_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_inspections ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['store_purchase_policies','purchase_inspections'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_read') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.nordvik_is_admin() OR store_id IN (SELECT public.user_store_ids()))', t || '_read', t);
    END IF;
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- Saves a store's buying policy (store managers with settings access).
CREATE OR REPLACE FUNCTION public.market_save_purchase_policy(p_store_id uuid, p_policy jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; v jsonb;
BEGIN
  IF NOT (public.nordvik_is_admin() OR public.nordvik_can_manage_store(p_store_id, 'settings_management')) THEN
    RAISE EXCEPTION 'Changing purchase pricing needs store settings access';
  END IF;
  FOREACH k IN ARRAY ARRAY['category_percents','lego_percents'] LOOP
    IF jsonb_typeof(coalesce(p_policy->k, '{}'::jsonb)) <> 'object' THEN RAISE EXCEPTION '% must be an object', k; END IF;
    FOR v IN SELECT value FROM jsonb_each(coalesce(p_policy->k, '{}'::jsonb)) LOOP
      IF jsonb_typeof(v) <> 'number' OR (v::text)::numeric < 0 OR (v::text)::numeric > 200 THEN RAISE EXCEPTION 'Percentages must be numbers from 0 to 200'; END IF;
    END LOOP;
  END LOOP;
  INSERT INTO public.store_purchase_policies AS x (store_id, default_percent, category_percents, lego_percents, box_required_for_complete, instructions_required_for_complete, updated_by, updated_at)
  VALUES (p_store_id, coalesce((p_policy->>'default_percent')::numeric, 75), coalesce(p_policy->'category_percents', '{}'::jsonb), coalesce(p_policy->'lego_percents', '{}'::jsonb),
    coalesce((p_policy->>'box_required_for_complete')::boolean, false), coalesce((p_policy->>'instructions_required_for_complete')::boolean, false), auth.uid(), now())
  ON CONFLICT (store_id) DO UPDATE SET default_percent = EXCLUDED.default_percent, category_percents = EXCLUDED.category_percents,
    lego_percents = EXCLUDED.lego_percents, box_required_for_complete = EXCLUDED.box_required_for_complete,
    instructions_required_for_complete = EXCLUDED.instructions_required_for_complete, updated_by = auth.uid(), updated_at = now();
END $$;

-- Saves the inspections for a completed buy. Each inspection names the
-- trade line's unique SKU; the new stock record is found through the
-- transaction's own items, so nothing can be attached to another store's stock.
CREATE OR REPLACE FUNCTION public.market_save_inspections(p_transaction_id uuid, p_inspections jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_store uuid; v jsonb; v_item record; v_count integer := 0; v_employee uuid;
  num CONSTANT text := '^-?[0-9]+(\.[0-9]+)?$';
BEGIN
  SELECT store_id INTO v_store FROM public.store_transactions WHERE id = p_transaction_id;
  IF v_store IS NULL THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF NOT (v_store IN (SELECT public.user_store_ids())) THEN RAISE EXCEPTION 'Not authorised for this store'; END IF;
  IF jsonb_typeof(p_inspections) <> 'array' THEN RAISE EXCEPTION 'Inspections must be a list'; END IF;
  SELECT e.id INTO v_employee FROM public.store_employees e
   WHERE e.store_id = v_store AND e.status = 'active' AND (e.auth_user_id = auth.uid() OR e.employee_user_id = auth.uid()) LIMIT 1;
  FOR v IN SELECT * FROM jsonb_array_elements(p_inspections) LOOP
    SELECT ti.id, ti.inventory_id, ti.catalog_item_id, ti.quantity, ti.condition, ti.unit_price INTO v_item
      FROM public.store_transaction_items ti
     WHERE ti.transaction_id = p_transaction_id AND ti.direction = 'in' AND ti.sku_snapshot = v->>'sku'
     LIMIT 1;
    CONTINUE WHEN v_item.id IS NULL;
    INSERT INTO public.purchase_inspections (store_id, transaction_id, transaction_item_id, inventory_id, catalog_item_id, quantity, condition, pricing_group,
      minifigs, missing_pieces, missing_accessories, instructions, box, damage, notes,
      market_reference, market_reference_label, market_currency, market_sales_count, market_data_at,
      deductions, deduction_complete, adjusted_reference, buy_percent, buy_rule, baseline, final_offer,
      inspected_by_employee, inspected_by_user)
    VALUES (v_store, p_transaction_id, v_item.id, v_item.inventory_id, v_item.catalog_item_id, v_item.quantity, v_item.condition, nullif(v->>'pricing_group', ''),
      CASE WHEN jsonb_typeof(v->'minifigs') = 'array' THEN v->'minifigs' ELSE '[]'::jsonb END,
      nullif(trim(coalesce(v->>'missing_pieces', '')), ''), nullif(trim(coalesce(v->>'missing_accessories', '')), ''),
      CASE WHEN v->>'instructions' IN ('present','missing','unknown') THEN v->>'instructions' END,
      CASE WHEN v->>'box' IN ('present','missing','unknown') THEN v->>'box' END,
      nullif(trim(coalesce(v->>'damage', '')), ''), nullif(trim(coalesce(v->>'notes', '')), ''),
      CASE WHEN v->>'market_reference' ~ num THEN (v->>'market_reference')::numeric END, nullif(v->>'market_reference_label', ''), nullif(v->>'market_currency', ''),
      CASE WHEN v->>'market_sales_count' ~ '^[0-9]+$' THEN (v->>'market_sales_count')::integer END, nullif(v->>'market_data_at', '')::timestamptz,
      CASE WHEN v->>'deductions' ~ num THEN (v->>'deductions')::numeric END, (v->>'deduction_complete')::boolean,
      CASE WHEN v->>'adjusted_reference' ~ num THEN (v->>'adjusted_reference')::numeric END,
      CASE WHEN v->>'buy_percent' ~ num THEN (v->>'buy_percent')::numeric END, nullif(v->>'buy_rule', ''),
      CASE WHEN v->>'baseline' ~ num THEN (v->>'baseline')::numeric END,
      -- The agreed price is the price actually recorded on the transaction.
      v_item.unit_price,
      v_employee, auth.uid());
    -- The customer-facing description written from the inspection goes on
    -- the new stock record (only this store's, found through its own sale).
    IF nullif(trim(coalesce(v->>'listing_description', '')), '') IS NOT NULL AND v_item.inventory_id IS NOT NULL THEN
      UPDATE public.store_inventory SET listing_notes = left(trim(v->>'listing_description'), 2000), updated_at = now()
       WHERE id = v_item.inventory_id AND store_id = v_store;
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- ── Market history for one catalogue item ───────────────────────────────────
-- Completed sales only, in p_currency (a sale counts when its own currency or
-- its normalized currency matches). Medians and averages are per unit.
-- Sales rates use the observation period: the last 365 days, or less when the
-- item's first recorded sale is newer (then marked as a short period).
-- Two sources of completed sales: market_sales (imports such as eBay; older
-- rows may only have the legacy price / date_of_sale columns, read the way
-- the Register reads them) and item_market_sales (CollectorsHub stores' own
-- in-store sales; test and reversed sales excluded, no store details shown).
-- Runs with elevated rights to read the in-store sales, so it requires a
-- signed-in user.
CREATE OR REPLACE FUNCTION public.market_intelligence(p_item_id uuid, p_currency text DEFAULT 'CAD')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_category text; v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to see market data'; END IF;
  SELECT c.name INTO v_category FROM public.items i LEFT JOIN public.categories c ON c.category_id = i.category_id WHERE i.item_id = p_item_id;
  WITH s AS (
    SELECT ms.sale_id::text AS sale_id, ms.source, ms.source_url, ms.title,
      coalesce(ms.sold_at, ms.date_of_sale::timestamptz, ms.created_at) AS sold_at,
      ms.condition, ms.grade_display, ms.grading_company, ms.updated_at, ms.created_at,
      greatest(coalesce(ms.quantity, 1), 1) AS qty,
      public.market_pricing_group(ms.pricing_group, ms.is_graded, ms.grading_company, coalesce(ms.grade_numeric, ms.grade), coalesce(nullif(ms.condition, ''), ms.condition_code), v_category) AS grp,
      CASE WHEN upper(ms.currency) = upper(p_currency) THEN coalesce(ms.per_unit_sold_price, round(ms.price::numeric / greatest(coalesce(ms.quantity, 1), 1), 2))
           WHEN upper(coalesce(ms.normalized_currency, '')) = upper(p_currency) AND ms.normalized_price IS NOT NULL THEN round(ms.normalized_price / greatest(coalesce(ms.quantity, 1), 1), 2) END AS unit_price,
      CASE WHEN upper(ms.currency) = upper(p_currency) THEN ms.shipping_price END AS shipping,
      ms.currency AS original_currency, coalesce(ms.sold_price, ms.price::numeric) AS original_price
    FROM public.market_sales ms
    WHERE coalesce(ms.catalogue_item_id, ms.item_id) = p_item_id
      AND NOT coalesce(ms.is_excluded, false)
      AND lower(coalesce(ms.match_status, 'confirmed')) <> 'excluded'
      AND coalesce(ms.sold_at, ms.date_of_sale::timestamptz, ms.created_at) <= now()
    UNION ALL
    SELECT ims.id::text, 'CollectorsHub stores', NULL, NULL, ims.sale_timestamp,
      coalesce(nullif(ims.condition, ''), ims.condition_code),
      CASE WHEN ims.is_graded THEN trim(concat_ws(' ', ims.grading_company, ims.grade)) END, ims.grading_company, ims.updated_at, ims.created_at,
      ims.eligible_quantity,
      public.market_pricing_group(NULL, ims.is_graded, ims.grading_company, CASE WHEN ims.grade ~ '^[0-9]+(\.[0-9]+)?$' THEN ims.grade::numeric END, coalesce(nullif(ims.condition, ''), ims.condition_code), v_category),
      CASE WHEN upper(ims.currency) = upper(p_currency) THEN ims.unit_sale_price END,
      NULL, ims.currency, ims.unit_sale_price
    FROM public.item_market_sales ims
    WHERE ims.catalog_item_id = p_item_id AND NOT ims.is_test_data AND NOT ims.is_reversed AND ims.eligible_quantity > 0 AND ims.sale_timestamp <= now()
  ),
  priced AS (SELECT * FROM s WHERE unit_price IS NOT NULL),
  span AS (SELECT least(365, greatest(1, ceil(extract(epoch FROM now() - min(sold_at)) / 86400)))::integer AS days FROM priced),
  groups AS (
    SELECT grp,
      count(*)::integer AS records,
      sum(qty)::integer AS units,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price)::numeric(12,2) AS median,
      avg(unit_price)::numeric(12,2) AS average,
      min(unit_price) AS low, max(unit_price) AS high,
      coalesce(sum(qty) FILTER (WHERE sold_at >= now() - interval '30 days'), 0)::integer AS units_30,
      coalesce(sum(qty) FILTER (WHERE sold_at >= now() - interval '90 days'), 0)::integer AS units_90,
      coalesce(sum(qty) FILTER (WHERE sold_at >= now() - interval '365 days'), 0)::integer AS units_365,
      min(sold_at) AS first_sale, max(sold_at) AS last_sale
    FROM priced GROUP BY grp
  ),
  months AS (
    SELECT grp, date_trunc('month', sold_at) AS month, sum(qty)::integer AS units,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price)::numeric(12,2) AS median
    FROM priced WHERE sold_at >= date_trunc('month', now()) - interval '23 months'
    GROUP BY grp, date_trunc('month', sold_at)
  )
  SELECT jsonb_build_object(
    'item_id', p_item_id, 'category', v_category, 'currency', upper(p_currency),
    'observation_days', (SELECT days FROM span),
    'groups', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'key', g.grp, 'records', g.records, 'units', g.units, 'median', g.median, 'average', g.average, 'low', g.low, 'high', g.high,
        'units_30', g.units_30, 'units_90', g.units_90, 'units_365', g.units_365,
        -- Units a month over the observation period (only when it is at least 30 days).
        'per_month', CASE WHEN (SELECT days FROM span) >= 30 THEN round(g.units_365::numeric / ((SELECT days FROM span) / 30.4375), 1) END,
        'first_sale', g.first_sale, 'last_sale', g.last_sale,
        'months', coalesce((SELECT jsonb_agg(jsonb_build_object('month', m.month, 'units', m.units, 'median', m.median) ORDER BY m.month) FROM months m WHERE m.grp = g.grp), '[]'::jsonb)
      ) ORDER BY g.units DESC) FROM groups g), '[]'::jsonb),
    'recent', coalesce((SELECT jsonb_agg(row_to_json(r)::jsonb ORDER BY r.sold_at DESC) FROM (
        SELECT sold_at, source, source_url, title, grp AS group_key, unit_price AS price, shipping, qty AS quantity, condition, grade_display, original_currency, original_price
        FROM priced ORDER BY sold_at DESC LIMIT 40) r), '[]'::jsonb),
    'other_currency_sales', (SELECT count(*) FROM s WHERE unit_price IS NULL),
    'sources', coalesce((SELECT jsonb_agg(jsonb_build_object('source', x.source, 'records', x.n)) FROM (SELECT source, count(*) AS n FROM priced GROUP BY source ORDER BY count(*) DESC) x), '[]'::jsonb),
    'last_updated', (SELECT max(greatest(updated_at, created_at)) FROM s)
  ) INTO v_result;
  RETURN v_result;
END $$;

-- ── A LEGO set's minifigures ────────────────────────────────────────────────
-- From catalog_item_relationships ("includes") and the legacy set_minifigs,
-- one row per minifigure (the larger quantity when both list it), each with
-- its own completed-sale median: the last 365 days, or all time when there
-- are none in that window; NULL (unpriced) when it has no sales at all.
-- Set and minifigure numbers may be in their own columns (lego_set_number,
-- minifig_code) or in card_number, where Building Blocks imports put them.
-- Elevated rights to read the in-store sales, so it requires a signed-in user.
CREATE OR REPLACE FUNCTION public.market_set_contents(p_set_item_id uuid, p_currency text DEFAULT 'CAD')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to see market data'; END IF;
  WITH links AS (
    SELECT r.child_item_id AS item_id, greatest(coalesce(r.quantity, 1), 1) AS qty, coalesce(r.source, 'catalogue') AS source, r.source_ref, r.verified
      FROM public.catalog_item_relationships r WHERE r.parent_item_id = p_set_item_id AND r.relationship_type = 'includes'
    UNION ALL
    SELECT sm.minifig_item_id, greatest(coalesce(sm.quantity, 1), 1), 'set_minifigs', NULL, true
      FROM public.set_minifigs sm WHERE sm.set_item_id = p_set_item_id
  ),
  figs AS (
    SELECT l.item_id, max(l.qty) AS qty, string_agg(DISTINCT l.source, ', ') AS source, max(l.source_ref) AS source_ref, bool_and(l.verified) AS verified
      FROM links l GROUP BY l.item_id
  ),
  info AS (
    SELECT f.*, i.name, i.minifig_code, i.rebrickable_fig_id, i.bricklink_id, i.card_number,
      coalesce((SELECT im.image_path FROM public.item_images im WHERE im.item_id = i.item_id ORDER BY im.position LIMIT 1), i.image_path) AS image_path,
      -- A minifig code in card_number is letters then digits (pha001, sw0001a); set numbers are digits only.
      (i.minifig_code IS NOT NULL OR i.rebrickable_fig_id IS NOT NULL OR coalesce(i.card_number, '') ~* '^[a-z]{2,5}[0-9]{2,5}[a-z]?$' OR EXISTS (SELECT 1 FROM public.item_types t WHERE t.item_type_id = i.item_type_id AND t.name ~* 'minifig')) AS is_minifig
    FROM figs f JOIN public.items i ON i.item_id = f.item_id
  ),
  -- Both completed-sale sources, as in market_intelligence.
  sales AS (
    SELECT coalesce(ms.catalogue_item_id, ms.item_id) AS item_id,
      coalesce(ms.per_unit_sold_price, round(ms.price::numeric / greatest(coalesce(ms.quantity, 1), 1), 2)) AS price,
      coalesce(ms.sold_at, ms.date_of_sale::timestamptz, ms.created_at) AS sold_at
      FROM public.market_sales ms
     WHERE coalesce(ms.catalogue_item_id, ms.item_id) IN (SELECT item_id FROM info)
       AND NOT coalesce(ms.is_excluded, false) AND lower(coalesce(ms.match_status, 'confirmed')) <> 'excluded'
       AND upper(ms.currency) = upper(p_currency) AND coalesce(ms.sold_at, ms.date_of_sale::timestamptz, ms.created_at) <= now()
    UNION ALL
    SELECT ims.catalog_item_id, ims.unit_sale_price, ims.sale_timestamp
      FROM public.item_market_sales ims
     WHERE ims.catalog_item_id IN (SELECT item_id FROM info) AND NOT ims.is_test_data AND NOT ims.is_reversed
       AND ims.eligible_quantity > 0 AND upper(ims.currency) = upper(p_currency) AND ims.sale_timestamp <= now()
  ),
  priced AS (
    SELECT i.item_id,
      coalesce(
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price) FROM sales s WHERE s.item_id = i.item_id AND s.sold_at >= now() - interval '365 days'),
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price) FROM sales s WHERE s.item_id = i.item_id))::numeric(12,2) AS price,
      (SELECT count(*) FROM sales s WHERE s.item_id = i.item_id AND s.sold_at >= now() - interval '365 days') AS sales_365,
      (SELECT count(*) FROM sales s WHERE s.item_id = i.item_id) AS sales_all,
      (SELECT max(s.sold_at) FROM sales s WHERE s.item_id = i.item_id) AS last_sale
    FROM info i
  )
  SELECT jsonb_build_object(
    'set', (SELECT jsonb_build_object('item_id', i.item_id, 'name', i.name, 'set_number', coalesce(nullif(i.lego_set_number, ''), nullif(i.card_number, '')), 'piece_count', i.piece_count, 'release_year', i.release_year,
        'image_path', coalesce((SELECT im.image_path FROM public.item_images im WHERE im.item_id = i.item_id ORDER BY im.position LIMIT 1), i.image_path))
      FROM public.items i WHERE i.item_id = p_set_item_id),
    'minifigs', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'item_id', i.item_id, 'name', i.name, 'code', coalesce(nullif(i.minifig_code, ''), nullif(i.card_number, ''), i.bricklink_id, i.rebrickable_fig_id), 'image_path', i.image_path,
        'required', i.qty, 'source', i.source, 'source_ref', i.source_ref, 'verified', i.verified,
        'price', p.price, 'price_window', CASE WHEN p.sales_365 > 0 THEN '365 days' WHEN p.sales_all > 0 THEN 'all time' END,
        'price_sales', CASE WHEN p.sales_365 > 0 THEN p.sales_365 ELSE p.sales_all END, 'last_sale', p.last_sale
      ) ORDER BY i.name) FROM info i JOIN priced p ON p.item_id = i.item_id WHERE i.is_minifig), '[]'::jsonb)
  ) INTO v;
  RETURN v;
END $$;

-- ── The store's own activity for an item (store members only) ───────────────
CREATE OR REPLACE FUNCTION public.market_store_activity(p_store_id uuid, p_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  IF NOT (public.nordvik_is_admin() OR p_store_id IN (SELECT public.user_store_ids())) THEN RAISE EXCEPTION 'Not authorised for this store'; END IF;
  WITH stock AS (
    SELECT si.id, si.created_at, si.condition, si.sell_price, si.in_store_price,
      coalesce((SELECT sum(q.quantity) FROM public.store_inventory_quantities q WHERE q.inventory_id = si.id), 0) AS on_hand
    FROM public.store_inventory si
    WHERE si.store_id = p_store_id AND si.catalog_item_id = p_item_id AND coalesce(si.status, 'active') <> 'archived'
  ),
  sold AS (
    SELECT ti.quantity, ti.unit_price, coalesce(t.completed_at, t.created_at) AS sold_at
    FROM public.store_transaction_items ti JOIN public.store_transactions t ON t.id = ti.transaction_id
    WHERE t.store_id = p_store_id AND ti.catalog_item_id = p_item_id AND ti.direction = 'out'
      AND t.status = 'completed' AND t.transaction_type IN ('sale', 'exchange')
  ),
  bought AS (
    SELECT ti.quantity, ti.unit_price, coalesce(t.completed_at, t.created_at) AS at
    FROM public.store_transaction_items ti JOIN public.store_transactions t ON t.id = ti.transaction_id
    WHERE t.store_id = p_store_id AND ti.catalog_item_id = p_item_id AND ti.direction = 'in' AND t.status = 'completed'
  )
  SELECT jsonb_build_object(
    'on_hand', (SELECT coalesce(sum(on_hand), 0) FROM stock),
    'stock_records', (SELECT count(*) FROM stock WHERE on_hand > 0),
    'oldest_unsold_days', (SELECT floor(extract(epoch FROM now() - min(created_at)) / 86400)::integer FROM stock WHERE on_hand > 0),
    'stock', coalesce((SELECT jsonb_agg(jsonb_build_object('condition', condition, 'on_hand', on_hand, 'price', coalesce(in_store_price, sell_price), 'age_days', floor(extract(epoch FROM now() - created_at) / 86400)::integer) ORDER BY created_at)
      FROM stock WHERE on_hand > 0), '[]'::jsonb),
    'units_sold', (SELECT coalesce(sum(quantity), 0) FROM sold),
    'sales', (SELECT count(*) FROM sold),
    'last_sold', (SELECT max(sold_at) FROM sold),
    'median_sold_price', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price)::numeric(12,2) FROM sold),
    'units_bought', (SELECT coalesce(sum(quantity), 0) FROM bought),
    'last_bought', (SELECT max(at) FROM bought)
  ) INTO v;
  RETURN v;
END $$;

-- ── Public store inventory: add listing_notes ───────────────────────────────
-- Same function as 20260971_public_store_inventory_perf_lateral.sql with one
-- more output column, listing_notes (what customers should know about the
-- item's condition and contents). A new output column needs drop + create.
DROP FUNCTION IF EXISTS public.public_store_inventory(uuid, text, text, integer, integer);
CREATE OR REPLACE FUNCTION public.public_store_inventory(
  p_location_id uuid,
  p_mode        text DEFAULT 'all',
  p_search      text DEFAULT NULL,
  p_limit       integer DEFAULT 40,
  p_offset      integer DEFAULT 0
) RETURNS TABLE (
  inventory_id     uuid,
  catalog_item_id  uuid,
  name             text,
  collectible_set  text,
  card_number      text,
  image_path       text,
  store_image_path text,
  condition        text,
  grade            text,
  grading_company  text,
  cert_number      text,
  is_graded        boolean,
  sell_price       numeric,
  available        integer,
  is_wishlist      boolean,
  is_completion    boolean,
  listed_for_sale  boolean,
  listing_notes    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT auth.uid() AS uid),
  selected_store AS (
    SELECT l.store_id
    FROM public.store_locations l
    WHERE l.id = p_location_id
  ),
  qty AS (
    SELECT q.inventory_id,
           sum(COALESCE(q.quantity, 0))::integer AS quantity,
           sum(COALESCE(q.quantity_reserved, 0))::integer AS quantity_reserved
    FROM public.store_inventory_quantities q
    JOIN selected_store ss ON ss.store_id = q.store_id
    GROUP BY q.inventory_id
  ),
  owned AS (
    SELECT DISTINCT catalog_item_id
    FROM public.user_collection_items, me
    WHERE user_id = me.uid AND catalog_item_id IS NOT NULL
  ),
  my_sets AS (
    SELECT DISTINCT i2.collectible_set_id
    FROM owned o
    JOIN public.items i2 ON i2.item_id = o.catalog_item_id
    WHERE i2.collectible_set_id IS NOT NULL
  )
  SELECT
    si.id,
    si.catalog_item_id,
    COALESCE(NULLIF(btrim(si.name_snapshot), ''), i.name, 'Inventory Item') AS name,
    NULLIF(d.collectible_set, 'N/A') AS collectible_set,
    NULLIF(COALESCE(d.card_number, i.card_number), 'N/A') AS card_number,
    COALESCE(d.front_image_path, i.image_path) AS image_path,
    img.storage_path AS store_image_path,
    si.condition,
    si.grade,
    si.grading_company,
    si.cert_number,
    (si.grade IS NOT NULL AND si.grade <> '') AS is_graded,
    COALESCE(si.sell_price, si.in_store_price) AS sell_price,
    GREATEST(0, COALESCE(qty.quantity, 0) - COALESCE(qty.quantity_reserved, 0))::integer AS available,
    (w.catalog_item_id IS NOT NULL) AS is_wishlist,
    (
      si.catalog_item_id IS NOT NULL
      AND i.collectible_set_id IN (SELECT collectible_set_id FROM my_sets)
      AND si.catalog_item_id NOT IN (SELECT catalog_item_id FROM owned)
    ) AS is_completion,
    COALESCE(si.listed_for_sale, false) AS listed_for_sale,
    NULLIF(btrim(si.listing_notes), '') AS listing_notes
  FROM qty
  JOIN public.store_inventory si
    ON si.id = qty.inventory_id
   AND si.status = 'active'
  JOIN public.stores s ON s.id = si.store_id
  LEFT JOIN public.store_settings st ON st.store_id = s.id
  LEFT JOIN public.items i ON i.item_id = si.catalog_item_id
  LEFT JOIN LATERAL (
    SELECT d0.collectible_set, d0.card_number, d0.front_image_path
    FROM public.item_details d0
    WHERE d0.item_id = si.catalog_item_id
    LIMIT 1
  ) d ON true
  LEFT JOIN public.wishlist_items w
    ON w.catalog_item_id = si.catalog_item_id
   AND w.user_id = (SELECT uid FROM me)
  LEFT JOIN LATERAL (
    SELECT storage_path
    FROM public.store_inventory_images im
    WHERE im.inventory_id = si.id
    ORDER BY position, created_at
    LIMIT 1
  ) img ON true
  WHERE GREATEST(0, COALESCE(qty.quantity, 0) - COALESCE(qty.quantity_reserved, 0)) > 0
    AND COALESCE(st.inventory_publicly_visible, true)
    AND COALESCE(st.store_public_profile_enabled, true)
    AND (
      si.catalog_item_id IS NULL
      OR i.category_id IS NULL
      OR public.org_allows_category(s.organization_id, i.category_id)
    )
    AND (
      p_search IS NULL
      OR btrim(p_search) = ''
      OR COALESCE(NULLIF(btrim(si.name_snapshot), ''), i.name, '') ILIKE '%' || p_search || '%'
      OR COALESCE(si.sku, '') ILIKE '%' || p_search || '%'
      OR COALESCE(si.barcode, '') = btrim(p_search)
    )
    AND (
      p_mode = 'all'
      OR (
        p_mode = 'wishlist'
        AND COALESCE(si.listed_for_sale, false)
        AND si.catalog_item_id IS NOT NULL
        AND w.catalog_item_id IS NOT NULL
      )
      OR (
        p_mode = 'completion'
        AND COALESCE(si.listed_for_sale, false)
        AND si.catalog_item_id IS NOT NULL
        AND i.collectible_set_id IN (SELECT collectible_set_id FROM my_sets)
        AND si.catalog_item_id NOT IN (SELECT catalog_item_id FROM owned)
      )
    )
  ORDER BY
    COALESCE(si.listed_for_sale, false) DESC,
    (w.catalog_item_id IS NOT NULL) DESC,
    COALESCE(NULLIF(btrim(si.name_snapshot), ''), i.name, 'Inventory Item')
  LIMIT GREATEST(1, LEAST(p_limit, 100))
  OFFSET GREATEST(0, p_offset)
$$;
GRANT EXECUTE ON FUNCTION public.public_store_inventory(uuid, text, text, integer, integer) TO authenticated, anon;

REVOKE ALL ON FUNCTION public.market_save_purchase_policy(uuid, jsonb), public.market_save_inspections(uuid, jsonb),
  public.market_intelligence(uuid, text), public.market_set_contents(uuid, text), public.market_store_activity(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.market_pricing_group(text, boolean, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.market_save_purchase_policy(uuid, jsonb), public.market_save_inspections(uuid, jsonb),
  public.market_intelligence(uuid, text), public.market_set_contents(uuid, text), public.market_store_activity(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
