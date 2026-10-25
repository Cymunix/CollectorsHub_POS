-- Check for supabase/market_intelligence.sql. Paste into the Supabase SQL
-- editor and run. As a manager of an active TEST store it creates a sample
-- LEGO set with minifigures (one appearing twice, one never sold) and sample
-- completed sales, checks the market history, set contents and buying policy,
-- buys the set through the normal checkout and saves its inspection, then
-- raises an error on purpose so EVERYTHING is rolled back.
--
-- Expected: an error reading "MARKET INTELLIGENCE CHECK PASSED ... (all changes rolled back)".

DO $$
DECLARE
  v_store uuid; v_manager uuid; v_location uuid; v_category uuid; v_set uuid; v_fig_a uuid; v_fig_b uuid; v_fig_c uuid;
  v_hist jsonb; v_group jsonb; v_contents jsonb; v_fig jsonb; v_result jsonb; v_txn uuid; v_saved integer; v_insp record; v_inv record;
  v_failed boolean; v_outsider uuid; v_missing_columns text; v_rules public.store_buyback_id_rules;
BEGIN
  SELECT s.id, coalesce(e.auth_user_id, e.employee_user_id) INTO v_store, v_manager
    FROM public.stores s JOIN public.store_employees e ON e.store_id = s.id
   WHERE coalesce(s.is_test_store, false) AND public.nordvik_store_is_active(s.id) AND e.status = 'active'
     AND lower(e.role) IN ('owner','manager') AND coalesce(e.auth_user_id, e.employee_user_id) IS NOT NULL LIMIT 1;
  SELECT id INTO v_location FROM public.store_locations WHERE store_id = v_store LIMIT 1;
  SELECT category_id INTO v_category FROM public.categories WHERE name ~* '(lego|building block)' LIMIT 1;
  IF v_store IS NULL OR v_location IS NULL OR v_category IS NULL THEN RAISE EXCEPTION 'SETUP: need an active test store with a manager, a location and a Building Blocks category'; END IF;

  -- Sample catalogue: a set with three minifigures (B twice, C never sold).
  -- The set number and one minifig code only in card_number, as Building Blocks imports store them.
  INSERT INTO public.items (category_id, name, card_number, piece_count, release_year) VALUES (v_category, 'MI CHECK set', '99901', 512, 2011) RETURNING item_id INTO v_set;
  INSERT INTO public.items (category_id, name, minifig_code) VALUES (v_category, 'MI CHECK fig A', 'mic001') RETURNING item_id INTO v_fig_a;
  INSERT INTO public.items (category_id, name, minifig_code) VALUES (v_category, 'MI CHECK fig B', 'mic002') RETURNING item_id INTO v_fig_b;
  INSERT INTO public.items (category_id, name, card_number) VALUES (v_category, 'MI CHECK fig C', 'mic003') RETURNING item_id INTO v_fig_c;
  INSERT INTO public.catalog_item_relationships (parent_item_id, child_item_id, relationship_type, quantity, source) VALUES
    (v_set, v_fig_a, 'includes', 1, 'check'), (v_set, v_fig_b, 'includes', 2, 'check'), (v_set, v_fig_c, 'includes', 1, 'check');

  -- The live table has older required columns (price, date_of_sale). Stop with
  -- a clear list if any other required column without a default isn't filled below.
  SELECT string_agg(column_name, ', ') INTO v_missing_columns FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'market_sales' AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER'
     AND column_name NOT IN ('item_id','catalogue_item_id','source','source_sale_id','sold_price','price','currency','sold_at','date_of_sale','condition');
  IF v_missing_columns IS NOT NULL THEN RAISE EXCEPTION 'SETUP: market_sales also requires: % (send this to Claude)', v_missing_columns; END IF;

  -- Sample completed sales (CAD): set Used Complete 180/200/220, Used Incomplete 90, Sealed 400; fig A 25, fig B 15/16.
  INSERT INTO public.market_sales (item_id, catalogue_item_id, source, source_sale_id, sold_price, price, currency, sold_at, date_of_sale, condition) VALUES
    (v_set, v_set, 'check', 'mic-s1', 180, 180, 'CAD', now() - interval '10 days', now() - interval '10 days', 'Used - Complete'),
    (v_set, v_set, 'check', 'mic-s2', 200, 200, 'CAD', now() - interval '40 days', now() - interval '40 days', 'Pre-Owned 100%'),
    (v_set, v_set, 'check', 'mic-s3', 220, 220, 'CAD', now() - interval '100 days', now() - interval '100 days', 'Used Complete'),
    (v_set, v_set, 'check', 'mic-s4', 90, 90, 'CAD', now() - interval '20 days', now() - interval '20 days', 'Used - Missing minifigures'),
    (v_set, v_set, 'check', 'mic-s5', 400, 400, 'CAD', now() - interval '5 days', now() - interval '5 days', 'New Sealed'),
    (v_fig_a, v_fig_a, 'check', 'mic-a1', 25, 25, 'CAD', now() - interval '3 days', now() - interval '3 days', 'Used'),
    (v_fig_b, v_fig_b, 'check', 'mic-b1', 15, 15, 'CAD', now() - interval '3 days', now() - interval '3 days', 'Used'),
    (v_fig_b, v_fig_b, 'check', 'mic-b2', 16, 16, 'CAD', now() - interval '30 days', now() - interval '30 days', 'Used');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_manager, 'role', 'authenticated')::text, true);

  -- 1. History: three independent LEGO groups, Used Complete median 200, volumes.
  v_hist := public.market_intelligence(v_set, 'CAD');
  SELECT g INTO v_group FROM jsonb_array_elements(v_hist->'groups') g WHERE g->>'key' = 'used_complete';
  IF (v_group->>'median')::numeric <> 200 OR (v_group->>'units_30')::int <> 1 OR (v_group->>'units_90')::int <> 2 OR (v_group->>'units_365')::int <> 3 THEN RAISE EXCEPTION 'FAIL 1: used_complete group wrong: %', v_group; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_hist->'groups') g WHERE g->>'key' = 'used_incomplete' AND (g->>'median')::numeric = 90) THEN RAISE EXCEPTION 'FAIL 1: used_incomplete not separate'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_hist->'groups') g WHERE g->>'key' = 'sealed') THEN RAISE EXCEPTION 'FAIL 1: sealed group missing'; END IF;
  RAISE NOTICE '1 ok: Sealed / Used Complete (median 200) / Used Incomplete kept apart';

  -- 2. Set contents: one row per minifigure, B required twice, C unpriced.
  v_contents := public.market_set_contents(v_set, 'CAD');
  IF v_contents->'set'->>'set_number' IS DISTINCT FROM '99901' THEN RAISE EXCEPTION 'FAIL 2: the set number in card_number was not read: %', v_contents->'set'; END IF;
  IF jsonb_array_length(v_contents->'minifigs') <> 3 THEN RAISE EXCEPTION 'FAIL 2: expected 3 minifigures, got %', jsonb_array_length(v_contents->'minifigs'); END IF;
  SELECT f INTO v_fig FROM jsonb_array_elements(v_contents->'minifigs') f WHERE f->>'code' = 'mic002';
  IF (v_fig->>'required')::int <> 2 OR (v_fig->>'price')::numeric <> 15.50 THEN RAISE EXCEPTION 'FAIL 2: fig B wrong: %', v_fig; END IF;
  SELECT f INTO v_fig FROM jsonb_array_elements(v_contents->'minifigs') f WHERE f->>'code' = 'mic003';
  IF v_fig->>'price' IS NOT NULL THEN RAISE EXCEPTION 'FAIL 2: fig C should be unpriced: %', v_fig; END IF;
  RAISE NOTICE '2 ok: set number and minifig code read from card_number; own prices; duplicate quantity 2; unsold one unpriced';

  -- 3. Buying policy (manager can save), store activity readable by the store.
  PERFORM public.market_save_purchase_policy(v_store, '{"default_percent": 80, "lego_percents": {"used_incomplete": 60}}');
  IF (SELECT default_percent FROM public.store_purchase_policies WHERE store_id = v_store) <> 80 THEN RAISE EXCEPTION 'FAIL 3: policy not saved'; END IF;
  v_failed := false;
  BEGIN PERFORM public.market_save_purchase_policy(v_store, '{"default_percent": 80, "lego_percents": {"sealed": 500}}'); EXCEPTION WHEN OTHERS THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL 3: a 500%% rule was accepted'; END IF;
  PERFORM public.market_store_activity(v_store, v_set);
  RAISE NOTICE '3 ok: buying policy saved and validated';

  -- 4. Buy the set through the normal checkout (fig A missing), then save the inspection.
  -- Buybacks must identify the seller: record a guest ID check the way the
  -- Register does (this location's rules), with every detail a rule might require.
  v_rules := public.buyback_id_rules_for(v_store, v_location);
  IF NOT v_rules.allow_guest_buyback THEN RAISE EXCEPTION 'SETUP: the test store''s location doesn''t buy from guests; allow guest buybacks for it (ID rules) to run this check'; END IF;
  PERFORM public.buyback_id_record(v_store, v_location, 'guest_manual_id_check', NULL, v_rules.accepted_id_types[1],
    jsonb_build_object('full_name', 'Market Check Guest', 'date_of_birth', '1990-01-15', 'address', '100 Sample Street, Halifax NS', 'contact', '902-555-0100', 'id_number', 'CHECK12345', 'jurisdiction', 'NS'),
    true, 'market-intelligence-check');
  v_result := public.complete_store_checkout(v_location, NULL, jsonb_build_object(
    'purchase_items', '[]'::jsonb,
    'trade_items', jsonb_build_array(jsonb_build_object('catalog_item_id', v_set, 'direction', 'in', 'name_snapshot', 'MI CHECK set', 'sku_snapshot', 'MICHECK-0001',
      'condition', 'Used Incomplete', 'unit_price', 96.40, 'quantity', 1, 'discount_total', 0, 'line_total', 96.40, 'buy_price', 96.40, 'sell_price', 175, 'is_used', true, 'payout', 'cash')),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', -96.40)),
    'totals', jsonb_build_object('subtotal_today', 0, 'discount_today', 0, 'tax_today', 0, 'trade_credit_total', 0, 'store_credit_total', 0, 'total_today', -96.40, 'balance_today', 0)));
  v_txn := (v_result->>'transaction_id')::uuid;
  IF v_txn IS NULL THEN RAISE EXCEPTION 'FAIL 4: checkout returned no transaction: %', v_result; END IF;
  v_saved := public.market_save_inspections(v_txn, jsonb_build_array(jsonb_build_object(
    'sku', 'MICHECK-0001', 'pricing_group', 'used_incomplete', 'minifigs', jsonb_build_array(jsonb_build_object('name', 'MI CHECK fig A', 'required', 1, 'present', 0, 'missing', 1, 'price', 25)),
    'box', 'missing', 'instructions', 'present', 'notes', 'check', 'market_reference', 200, 'deductions', 25, 'deduction_complete', true, 'adjusted_reference', 175,
    'buy_percent', 60, 'baseline', 105, 'market_currency', 'CAD', 'market_sales_count', 3)));
  IF v_saved <> 1 THEN RAISE EXCEPTION 'FAIL 4: % inspections saved', v_saved; END IF;
  SELECT * INTO v_insp FROM public.purchase_inspections WHERE transaction_id = v_txn;
  SELECT * INTO v_inv FROM public.store_inventory WHERE id = v_insp.inventory_id;
  IF v_inv.id IS NULL OR v_inv.condition <> 'Used Incomplete' OR v_insp.final_offer <> 96.40 OR v_insp.baseline <> 105 OR v_insp.catalog_item_id <> v_set THEN
    RAISE EXCEPTION 'FAIL 4: inspection/stock wrong: inventory %, condition %, final %, baseline %', v_inv.id, v_inv.condition, v_insp.final_offer, v_insp.baseline;
  END IF;
  RAISE NOTICE '4 ok: bought through checkout; inspection saved on the new stock (Used Incomplete, offer 96.40 vs baseline 105)';

  -- 5. Another store's people can't read this store's activity or save inspections on its sale.
  SELECT coalesce(e.auth_user_id, e.employee_user_id) INTO v_outsider FROM public.store_employees e
   WHERE e.store_id <> v_store AND e.status = 'active' AND coalesce(e.auth_user_id, e.employee_user_id) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.store_employees x WHERE x.store_id = v_store AND coalesce(x.auth_user_id, x.employee_user_id) = coalesce(e.auth_user_id, e.employee_user_id))
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = coalesce(e.auth_user_id, e.employee_user_id) AND p.subscription_tier::text = 'platform_admin') LIMIT 1;
  IF v_outsider IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
    v_failed := false;
    BEGIN PERFORM public.market_store_activity(v_store, v_set); EXCEPTION WHEN OTHERS THEN v_failed := true; END;
    IF NOT v_failed THEN RAISE EXCEPTION 'FAIL 5: another store read this store''s activity'; END IF;
    v_failed := false;
    BEGIN PERFORM public.market_save_inspections(v_txn, '[]'); EXCEPTION WHEN OTHERS THEN v_failed := true; END;
    IF NOT v_failed THEN RAISE EXCEPTION 'FAIL 5: another store saved inspections on this sale'; END IF;
    RAISE NOTICE '5 ok: other stores are refused';
  ELSE
    RAISE NOTICE '5 skipped: no employee of another store to test with';
  END IF;

  RAISE EXCEPTION 'MARKET INTELLIGENCE CHECK PASSED (all changes rolled back)';
END $$;
