-- Check for supabase/building_blocks_series.sql. Paste into the Supabase SQL
-- editor and run. It takes a real Building Blocks subfranchise, temporarily
-- gives its items two Series (and leaves some with none), checks the Series
-- level, counts and items, checks a subfranchise with no Series and the
-- existing totals, then raises an error on purpose so EVERYTHING is rolled
-- back (the items keep their real values).
--
-- Expected: an error reading "SERIES CHECK PASSED ... (all changes rolled back)".

DO $$
DECLARE
  v_subset uuid; v_other uuid; v_user uuid; v_total int; v_rows int; v_sum int; v_a int; v_items int; v_names text;
  v_totals_before jsonb; v_totals_after jsonb;
BEGIN
  -- A Building Blocks subfranchise with at least 3 eligible items and no Series yet.
  SELECT i.subset_id INTO v_subset
    FROM public.items i JOIN public.categories c ON c.category_id = i.category_id
   WHERE c.name = 'Building Blocks' AND i.completion_eligible AND i.subset_id IS NOT NULL
   GROUP BY i.subset_id HAVING count(*) >= 3 AND count(i.series) = 0
   ORDER BY count(*) LIMIT 1;
  SELECT i.subset_id INTO v_other
    FROM public.items i JOIN public.categories c ON c.category_id = i.category_id
   WHERE c.name = 'Building Blocks' AND i.completion_eligible AND i.subset_id IS NOT NULL AND i.subset_id <> v_subset
   GROUP BY i.subset_id HAVING count(i.series) = 0 LIMIT 1;
  SELECT user_id INTO v_user FROM public.owned_copies LIMIT 1;
  IF v_subset IS NULL THEN RAISE EXCEPTION 'SETUP: no Building Blocks subfranchise with 3+ items found'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', coalesce(v_user, gen_random_uuid()), 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_total FROM public.items WHERE subset_id = v_subset AND completion_eligible;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY scope_type, scope_id) INTO v_totals_before FROM public.completion_totals t WHERE scope_id = v_subset;

  -- 1/5. Before any Series: no Series level (the subfranchise stays the leaf).
  SELECT count(*) INTO v_rows FROM public.completion_series(v_subset);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'FAIL 1: a subfranchise with no Series returned % Series rows', v_rows; END IF;
  RAISE NOTICE '1 ok: no Series -> no Series level';

  -- Two Series (one written in a different case) and some items with none.
  UPDATE public.items SET series = CASE WHEN rn % 3 = 0 THEN 'Smoke 1.0' WHEN rn % 3 = 1 THEN 'smoke 1.0 ' ELSE NULL END
    FROM (SELECT item_id, row_number() OVER (ORDER BY item_id) AS rn FROM public.items WHERE subset_id = v_subset AND completion_eligible) x
   WHERE items.item_id = x.item_id AND x.rn <= greatest(v_total - 1, 2);
  UPDATE public.items SET series = 'Smoke 2.0'
   WHERE item_id = (SELECT item_id FROM public.items WHERE subset_id = v_subset AND completion_eligible AND series IS NULL ORDER BY item_id LIMIT 1);

  -- 2/3. Series level: "Smoke 1.0" once (case/space folded), "Smoke 2.0", and "No series".
  SELECT count(*), sum(total_count), string_agg(name, ' | ' ORDER BY name) INTO v_rows, v_sum, v_names FROM public.completion_series(v_subset);
  IF v_sum <> v_total THEN RAISE EXCEPTION 'FAIL 3: Series totals add up to %, the subfranchise has %', v_sum, v_total; END IF;
  IF (SELECT count(*) FROM public.completion_series(v_subset) WHERE lower(name) = 'smoke 1.0') <> 1 THEN RAISE EXCEPTION 'FAIL 3: "Smoke 1.0" listed more than once: %', v_names; END IF;
  RAISE NOTICE '2/3 ok: % Series rows (%), totals add up to %', v_rows, v_names, v_total;

  -- Items per Series match the counts, including "No series".
  SELECT total_count INTO v_a FROM public.completion_series(v_subset) WHERE lower(name) = 'smoke 1.0';
  SELECT count(*) INTO v_items FROM public.completion_series_items(v_subset, 'SMOKE 1.0', 200, 0, NULL);
  IF v_items <> least(v_a, 200) THEN RAISE EXCEPTION 'FAIL 7: Smoke 1.0 lists % items, counted %', v_items, v_a; END IF;
  SELECT count(*) INTO v_items FROM public.completion_series_items(v_subset, NULL, 200, 0, NULL);
  IF v_items <> least(coalesce((SELECT total_count FROM public.completion_series(v_subset) WHERE series IS NULL), 0), 200) THEN RAISE EXCEPTION 'FAIL 7: "No series" items do not match its count'; END IF;
  PERFORM * FROM public.completion_series_finishes(v_subset, 'Smoke 2.0');
  RAISE NOTICE '7 ok: Series items match their counts';

  -- Other subfranchises are untouched; the precomputed totals are unchanged.
  IF v_other IS NOT NULL AND (SELECT count(*) FROM public.completion_series(v_other)) <> 0 THEN RAISE EXCEPTION 'FAIL 2: another subfranchise grew a Series level'; END IF;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY scope_type, scope_id) INTO v_totals_after FROM public.completion_totals t WHERE scope_id = v_subset;
  IF v_totals_after IS DISTINCT FROM v_totals_before THEN RAISE EXCEPTION 'FAIL 4: completion_totals changed'; END IF;
  RAISE NOTICE '4/5 ok: other subfranchises and existing totals unchanged';

  RAISE EXCEPTION 'SERIES CHECK PASSED: Series level, counts and items correct (all changes rolled back)';
END $$;
