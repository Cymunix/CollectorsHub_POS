-- WIPE ALL ITEM DATA (2026-10-19). PERMANENT. Take a Supabase backup first (Database → Backups).
--
-- Empties the catalogue and everything that depends on it, as agreed:
--   * catalogue items, photos records, prices, item details and the catalogue structure under
--     categories (subcategories, franchises, sets, properties, subjects, brands, ...)
--   * store stock, store orders/layaways, test transactions and refunds, the test pawn loan
--   * collector collections (owned_copies), wishlists, trade-proposal items, collector activity
--   * pending scan drafts (cloud review queue) and leftover copies (search index, currency data)
-- KEPT: categories, profiles/accounts, stores, locations, organizations, staff, MyHR, pawn
-- configurations and store settings, identity records, report access.
--
-- Runs as ONE transaction: if any step fails, nothing is deleted. TRUNCATE is used WITHOUT
-- CASCADE on purpose: if some other table still points at one of these, Postgres stops with an
-- error naming it (nothing is deleted) instead of silently emptying a table not on this list.
-- Item photo FILES live in Storage and aren't removed by SQL: empty these buckets in the
-- dashboard afterwards: item-images, store-inventory-images, scan-review, pawn-collateral.

BEGIN;

-- Row counts before the wipe (shown at the end).
DROP TABLE IF EXISTS pg_temp.wipe_counts;
CREATE TEMP TABLE wipe_counts (table_name text PRIMARY KEY, rows_deleted bigint);
DO $$
DECLARE t text; n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- catalogue
    'items', 'item_images', 'item_market_prices', 'item_market_sales', 'item_condition_prices', 'item_properties',
    'item_subjects', 'item_teams', 'item_portrays', 'item_product_lines', 'item_card_types', 'item_metal_components',
    'item_tcgplayer_skus', 'item_favorites', 'catalog_item_relationships', 'catalogue_market_prices', 'card_format_legality',
    'custom_list_overrides', 'deck_cards', 'image_candidates', 'image_search_jobs', 'market_provider_syncs',
    'market_sales', 'market_sales_imports', 'set_contents', 'set_minifigs', 'store_favorite_items',
    'catalogue_search_index', 'currency_item_data', 'currency_north_america_data', 'currency_north_america_light', 'master_light',
    'collector_store_inventory_alerts', 'scan_review_drafts',
    -- catalogue structure under categories
    'subcategories', 'franchises', 'franchise_subcategory', 'collectible_sets', 'subcollectible_sets', 'subsets', 'properties',
    'item_types', 'brands', 'publishers', 'manufacturers', 'rarities', 'series', 'subjects', 'teams', 'portrays',
    'product_lines', 'card_types', 'mtg_card_types', 'print_types', 'subject_franchise', 'brand_franchise', 'species', 'market_variants',
    -- store stock, orders, transactions
    'store_inventory', 'store_inventory_quantities', 'store_inventory_movements', 'store_inventory_images', 'store_inventory_transfers',
    'store_orders', 'store_order_items', 'store_order_payments',
    'store_transactions', 'store_transaction_items', 'store_transaction_payments', 'store_checkout_groups',
    'store_return_records', 'store_refund_lines', 'store_refund_requests', 'store_transaction_audit',
    'store_collector_collection_sync_events', 'inventory_item_locations', 'trade_item_locks',
    'store_buyback_identifications', 'store_seller_verifications', 'store_credit_ledger',
    -- test pawn loan
    'pawn_loans', 'pawn_collateral', 'pawn_agreements', 'pawn_ledger', 'pawn_events', 'pawn_notices',
    -- collector data
    'owned_copies', 'user_collection_items', 'collection_items', 'user_collection_item_sales', 'wishlist_items', 'trade_proposal_items', 'collector_activity',
    'collection_intake_items'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      INSERT INTO wipe_counts VALUES (t, n);
    END IF;
  END LOOP;
END $$;

-- Safety check: any OTHER table that points at one of these (directly or through another)
-- stops the script here with the full list and row counts. Nothing has been deleted at that point.
DO $$
DECLARE v_missing text;
BEGIN
  WITH RECURSIVE wiped AS (
    SELECT ('public.' || quote_ident(table_name))::regclass AS relid FROM wipe_counts
  ), deps(relid) AS (
    SELECT con.conrelid FROM pg_constraint con
     WHERE con.contype = 'f' AND con.confrelid IN (SELECT relid FROM wiped)
       AND con.conrelid NOT IN (SELECT relid FROM wiped)
    UNION
    SELECT con.conrelid FROM pg_constraint con JOIN deps d ON con.confrelid = d.relid
     WHERE con.contype = 'f' AND con.conrelid NOT IN (SELECT relid FROM wiped)
  )
  SELECT string_agg(DISTINCT format('%s (%s rows)', d.relid::regclass,
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %s', d.relid::regclass), false, true, '')))[1]::text), ', ')
    INTO v_missing FROM deps d;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Nothing was deleted. These tables also point at item data and need a decision: %', v_missing;
  END IF;
END $$;

-- The wipe: every table above that exists, in one statement (no CASCADE).
DO $$
DECLARE v_list text;
BEGIN
  SELECT string_agg(format('public.%I', table_name), ', ') INTO v_list FROM wipe_counts;
  EXECUTE 'TRUNCATE TABLE ' || v_list;
END $$;

-- Loan numbers start again at the beginning for each store.
DO $$ BEGIN IF to_regclass('public.pawn_counters') IS NOT NULL THEN DELETE FROM public.pawn_counters; END IF; END $$;

COMMIT;

-- What was deleted (rows per table).
SELECT table_name, rows_deleted FROM wipe_counts WHERE rows_deleted > 0 ORDER BY rows_deleted DESC;
