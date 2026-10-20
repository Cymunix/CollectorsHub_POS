-- Graded slab certs (2026-10-20). Run after the website's retail migrations (store_inventory
-- already has grading_company and cert_number). Safe to run more than once.
--
-- 1. Buys keep the slab's grading company and cert number. complete_store_transaction made
--    the new stock row for a bought item with condition and grade only, so a slab bought at
--    the counter (POS app or website) lost its cert. The live function is patched in place
--    (its two store_inventory insert lists gain grading_company and cert_number) instead of
--    being replaced with a copy, so any later changes to it are kept. If the function no longer
--    looks the way the patch expects, nothing is changed and the script stops with an error.
--
-- 2. pos_cert_matches: where else a cert number already appears - in any store's stock or in
--    a collector's collection - so staff are warned before buying a slab whose cert is already
--    on record (a copied cert label is a common fake). Other stores and collectors are never
--    named: only the card and grade recorded with the cert are shown.

-- ── 1. Save grading company and cert on bought stock ────────────────────────
DO $patch$
DECLARE
  v_fn  regprocedure := 'public.complete_store_transaction(uuid,text,jsonb,jsonb,uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric,jsonb,text,text)'::regprocedure;
  v_def text := pg_get_functiondef(v_fn);
  v_cols_from  text := 'store_id, catalog_item_id, sku, condition, grade,(\s+)cost_basis, buy_price, sell_price, name_snapshot, is_used, is_trade_in\)';
  v_cols_to    text := 'store_id, catalog_item_id, sku, condition, grade, grading_company, cert_number,\1cost_basis, buy_price, sell_price, name_snapshot, is_used, is_trade_in)';
  v_vals_from  text := 'v_line->>''condition'', v_line->>''grade'',(\s+)NULLIF\(v_line->>''unit_price''';
  v_vals_to    text := 'v_line->>''condition'', v_line->>''grade'', NULLIF(btrim(v_line->>''grading_company''), ''''), NULLIF(btrim(v_line->>''cert_number''), ''''),\1NULLIF(v_line->>''unit_price''';
BEGIN
  IF position('cert_number' IN v_def) > 0 THEN
    RAISE NOTICE 'complete_store_transaction already saves cert numbers; left as it is.';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_def, v_cols_from, 'g')) <> 1
     OR (SELECT count(*) FROM regexp_matches(v_def, v_vals_from, 'g')) <> 1 THEN
    RAISE EXCEPTION 'complete_store_transaction has changed since this patch was written; nothing was changed.';
  END IF;
  v_def := regexp_replace(v_def, v_cols_from, v_cols_to);
  v_def := regexp_replace(v_def, v_vals_from, v_vals_to);
  EXECUTE v_def;
END $patch$;

-- ── 2. Where a cert number already appears ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.normalize_cert_number(p_cert text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(regexp_replace(COALESCE(p_cert, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

CREATE INDEX IF NOT EXISTS store_inventory_cert_idx
  ON public.store_inventory (public.normalize_cert_number(cert_number))
  WHERE cert_number IS NOT NULL AND cert_number <> '';
CREATE INDEX IF NOT EXISTS owned_copies_cert_idx
  ON public.owned_copies (cert_number_normalized)
  WHERE cert_number_normalized <> '';

-- Returns { cert, matches: [...] }. Each match:
--   source        'this_store' | 'other_store' | 'collector'
--   name, grading_company, grade   as recorded with that cert
--   sku, on_hand, added_at         this store's own stock only
--   from_store    a collector's copy that came from a store purchase
DROP FUNCTION IF EXISTS public.pos_cert_matches(uuid, text);
CREATE OR REPLACE FUNCTION public.pos_cert_matches(p_store_id uuid, p_cert text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cert text := public.normalize_cert_number(p_cert);
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  IF length(v_cert) < 4 THEN RETURN jsonb_build_object('cert', v_cert, 'matches', '[]'::jsonb); END IF;
  RETURN jsonb_build_object('cert', v_cert, 'matches', COALESCE((
    SELECT jsonb_agg(m) FROM (
      SELECT CASE WHEN si.store_id = p_store_id THEN 'this_store' ELSE 'other_store' END AS source,
             si.name_snapshot AS name, si.grading_company, si.grade,
             CASE WHEN si.store_id = p_store_id THEN si.sku END AS sku,
             CASE WHEN si.store_id = p_store_id THEN (SELECT COALESCE(sum(q.quantity), 0) FROM public.store_inventory_quantities q WHERE q.inventory_id = si.id) END AS on_hand,
             CASE WHEN si.store_id = p_store_id THEN si.created_at END AS added_at,
             false AS from_store
        FROM public.store_inventory si
       WHERE si.cert_number IS NOT NULL AND si.cert_number <> ''
         AND public.normalize_cert_number(si.cert_number) = v_cert
      UNION ALL
      SELECT 'collector', i.name, oc.grading_company, oc.grade, NULL, NULL, NULL,
             oc.source_inventory_item_id IS NOT NULL
        FROM public.owned_copies oc
        LEFT JOIN public.items i ON i.item_id = oc.catalog_item_id
       WHERE oc.cert_number_normalized = v_cert
         AND oc.sale_status <> 'archived'
      LIMIT 20
    ) m), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.pos_cert_matches(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.pos_cert_matches(uuid, text) TO authenticated;
