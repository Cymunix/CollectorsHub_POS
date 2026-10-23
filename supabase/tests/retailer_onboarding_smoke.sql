-- Smoke test for supabase/retailer_onboarding.sql. Paste into the Supabase SQL
-- editor and run. It acts as a real NORDVIK administrator and as a manager of
-- an active TEST store (stores.is_test_store), walks items through every
-- stage via the real functions, checks the permission rules and the stock
-- created, then deliberately raises an error at the end so EVERYTHING it did
-- is rolled back. Nothing is kept: no project, items, stock or history.
--
-- Expected result: an error reading "SMOKE TEST PASSED ... (all changes rolled
-- back)". Any other error is a failure; the NOTICE lines show how far it got.

DO $$
DECLARE
  v_admin uuid; v_store uuid; v_manager uuid; v_manager_employee uuid; v_location uuid;
  v_project uuid; v_batch uuid; v_ids uuid[]; v_result jsonb; v_item public.onboarding_items; v_inventory public.store_inventory;
  v_qty integer; v_events integer; v_failed boolean;
  as_user CONSTANT text := 'request.jwt.claims';
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE subscription_tier::text = 'platform_admin' LIMIT 1;
  SELECT s.id, coalesce(e.auth_user_id, e.employee_user_id), e.id INTO v_store, v_manager, v_manager_employee
    FROM public.stores s JOIN public.store_employees e ON e.store_id = s.id
   WHERE coalesce(s.is_test_store, false) AND public.nordvik_store_is_active(s.id) AND e.status = 'active'
     AND lower(e.role) IN ('owner','manager') AND coalesce(e.auth_user_id, e.employee_user_id) IS NOT NULL
   LIMIT 1;
  SELECT id INTO v_location FROM public.store_locations WHERE store_id = v_store LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SETUP: no platform_admin profile found'; END IF;
  IF v_store IS NULL THEN RAISE EXCEPTION 'SETUP: no active test store with a signed-in manager found'; END IF;
  IF v_location IS NULL THEN RAISE EXCEPTION 'SETUP: the test store has no location'; END IF;
  RAISE NOTICE 'Using test store %, manager employee %, location %', v_store, v_manager_employee, v_location;

  -- 1. NORDVIK administrator: the project and assessment.
  PERFORM set_config(as_user, json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_project := public.onboarding_save_project(NULL, v_store, '{"name":"SMOKE TEST","categories":["Sports Cards","LEGO / Building Blocks"],"approx_quantity":"3","data_sources":["spreadsheet"],"require_price_approval":true,"expected_hours":"2"}');
  RAISE NOTICE '1 ok: project created by the administrator';

  -- 2. Store manager: capture a batch (one item has no price).
  PERFORM set_config(as_user, json_build_object('sub', v_manager, 'role', 'authenticated')::text, true);
  v_batch := public.onboarding_create_batch(v_project, 'spreadsheet', 'Smoke batch', 'smoke.csv',
    '[{"name":"Smoke Card A","category_name":"Sports Cards","condition":"Ungraded","quantity":2,"in_store_price":"12.50","online_price":"14.00","cost":"5"},
      {"name":"Smoke Set B","category_name":"LEGO / Building Blocks","condition":"New","quantity":1,"in_store_price":""}]', true);
  SELECT array_agg(id ORDER BY name) INTO v_ids FROM public.onboarding_items WHERE batch_id = v_batch;
  IF cardinality(v_ids) <> 2 THEN RAISE EXCEPTION 'FAIL 2: expected 2 items, got %', cardinality(v_ids); END IF;
  SELECT * INTO v_item FROM public.onboarding_items WHERE id = v_ids[2];
  IF NOT v_item.price_missing OR v_item.stage <> 'awaiting_verification' THEN RAISE EXCEPTION 'FAIL 2: Smoke Set B should be flagged missing a price and awaiting verification'; END IF;
  RAISE NOTICE '2 ok: batch captured, missing price flagged';

  -- 3. Verify both, then price: the unpriced one must be refused.
  v_result := public.onboarding_advance(v_ids, 'awaiting_pricing');
  IF (v_result->>'moved')::int <> 2 THEN RAISE EXCEPTION 'FAIL 3: verification moved %', v_result; END IF;
  v_result := public.onboarding_advance(v_ids, 'awaiting_approval');
  IF (v_result->>'moved')::int <> 1 OR jsonb_array_length(v_result->'skipped') <> 1 THEN RAISE EXCEPTION 'FAIL 3: pricing should move 1 and refuse the unpriced item: %', v_result; END IF;
  RAISE NOTICE '3 ok: verified; unpriced item refused at pricing (%)', v_result->'skipped'->0->>'reason';

  -- 4. Price the missing one (logged as a price change), then send to approval.
  PERFORM public.onboarding_update_item(v_ids[2], '{"in_store_price":"89.99"}', 'Shelf sticker');
  SELECT count(*) INTO v_events FROM public.onboarding_item_events WHERE item_id = v_ids[2] AND event = 'price_change';
  IF v_events <> 1 THEN RAISE EXCEPTION 'FAIL 4: price change was not logged'; END IF;
  v_result := public.onboarding_advance(ARRAY[v_ids[2]], 'awaiting_approval');
  IF (v_result->>'moved')::int <> 1 THEN RAISE EXCEPTION 'FAIL 4: %', v_result; END IF;
  RAISE NOTICE '4 ok: price entered and audited';

  -- 5. The administrator can oversee but never put stock on sale.
  PERFORM set_config(as_user, json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_result := public.onboarding_advance(v_ids, 'ready_for_sale', NULL, v_location);
  IF (v_result->>'moved')::int <> 0 THEN RAISE EXCEPTION 'FAIL 5: the administrator approved stock: %', v_result; END IF;
  v_failed := false;
  BEGIN PERFORM public.onboarding_update_item(v_ids[1], '{"in_store_price":"1"}'); EXCEPTION WHEN OTHERS THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL 5: the administrator changed a retailer price'; END IF;
  RAISE NOTICE '5 ok: administrator refused approval and pricing';

  -- 6. An exception blocks approval until resolved.
  PERFORM set_config(as_user, json_build_object('sub', v_manager, 'role', 'authenticated')::text, true);
  PERFORM public.onboarding_set_exception(v_ids[2], 'Box is damaged', NULL);
  v_result := public.onboarding_advance(ARRAY[v_ids[2]], 'ready_for_sale', NULL, v_location);
  IF (v_result->>'moved')::int <> 0 THEN RAISE EXCEPTION 'FAIL 6: an item with an exception was approved'; END IF;
  PERFORM public.onboarding_set_exception(v_ids[2], NULL, 'Checked: box is fine');
  RAISE NOTICE '6 ok: exception blocked approval, then resolved';

  -- 7. Store manager approves: stock is created with the retailer's prices.
  v_result := public.onboarding_advance(v_ids, 'ready_for_sale', 'Approved', v_location);
  IF (v_result->>'moved')::int <> 2 THEN RAISE EXCEPTION 'FAIL 7: approval moved %', v_result; END IF;
  SELECT * INTO v_item FROM public.onboarding_items WHERE id = v_ids[1];
  SELECT * INTO v_inventory FROM public.store_inventory WHERE id = v_item.inventory_id;
  SELECT quantity INTO v_qty FROM public.store_inventory_quantities WHERE inventory_id = v_item.inventory_id AND location_id = v_location;
  IF v_inventory.id IS NULL OR v_inventory.in_store_price <> 12.50 OR v_inventory.sell_price <> 14.00 OR v_qty <> 2 THEN
    RAISE EXCEPTION 'FAIL 7: stock wrong: in-store %, online %, quantity %', v_inventory.in_store_price, v_inventory.sell_price, v_qty;
  END IF;
  RAISE NOTICE '7 ok: stock created (in-store 12.50, online 14.00, 2 on hand)';

  -- 8. Ready items can't be edited or moved again; a failed QA check raises an exception.
  v_failed := false;
  BEGIN PERFORM public.onboarding_update_item(v_ids[1], '{"quantity":5}'); EXCEPTION WHEN OTHERS THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'FAIL 8: a ready-for-sale item was edited'; END IF;
  PERFORM public.onboarding_qa_check(v_ids[2], false, '{"identity":true,"quantity":false}', 'Only 0 on the shelf');
  IF (SELECT exception FROM public.onboarding_items WHERE id = v_ids[2]) IS NULL THEN RAISE EXCEPTION 'FAIL 8: failed QA did not raise an exception'; END IF;
  RAISE NOTICE '8 ok: ready items locked; failed QA raised an exception';

  -- 9. Dashboard numbers and history.
  v_result := public.onboarding_project_summary(v_project);
  IF (v_result->'stages'->>'ready_for_sale')::int <> 2 THEN RAISE EXCEPTION 'FAIL 9: summary %', v_result; END IF;
  SELECT count(*) INTO v_events FROM public.onboarding_item_events WHERE project_id = v_project;
  RAISE NOTICE '9 ok: summary %; % history events', v_result->'stages', v_events;

  RAISE EXCEPTION 'SMOKE TEST PASSED: all 9 checks (all changes rolled back)';
END $$;
