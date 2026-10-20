-- Wishlist "back in stock" emails (2026-10-20). Run after customer_wishlists.sql and
-- wishlist_open_profiles.sql. Safe to run more than once.
--
-- When a store's stock of a catalogue item becomes available (bought from a customer, scanned
-- into stock, transferred in), every member who
--   * has that item on their wishlist,
--   * has completed a transaction at that store (bought from it or sold to it),
--   * hasn't turned wishlist sharing off for that store, and
--   * has wishlist alerts and email notifications on (website Settings)
-- is queued for an email. The send-wishlist-alerts Edge Function sends the queue (the POS calls
-- it after a buy or a stock scan) and groups each member's items into one email.
-- One email per member, store and item per 7 days. Test stores only email admins / testers.
-- Queueing can never block a sale or a buy: any problem here is skipped.

CREATE TABLE IF NOT EXISTS public.wishlist_stock_email_queue (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  store_id         uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  location_id      uuid,
  catalog_item_id  uuid NOT NULL,
  inventory_id     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  error            text
);
CREATE INDEX IF NOT EXISTS wishlist_stock_email_queue_pending_idx ON public.wishlist_stock_email_queue (store_id, created_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS wishlist_stock_email_queue_recent_idx ON public.wishlist_stock_email_queue (user_id, store_id, catalog_item_id, created_at DESC);
ALTER TABLE public.wishlist_stock_email_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wishlist_stock_email_queue FROM anon, authenticated;

-- Can this member see test-store data (admins and testers)?
CREATE OR REPLACE FUNCTION public.wishlist_user_sees_test_data(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT p.subscription_tier = 'platform_admin' OR COALESCE(p.pricing_view_test_data, false)
                     FROM public.profiles p WHERE p.id = p_user_id), false)
$$;
REVOKE ALL ON FUNCTION public.wishlist_user_sees_test_data(uuid) FROM PUBLIC, anon, authenticated;

-- Queue the emails for one inventory record that just became available at a location.
CREATE OR REPLACE FUNCTION public.wishlist_queue_stock_emails(p_inventory_id uuid, p_location_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_item uuid; v_store uuid; v_test boolean; v_count integer := 0;
BEGIN
  SELECT si.catalog_item_id, si.store_id, COALESCE(s.is_test_store, false)
    INTO v_item, v_store, v_test
    FROM public.store_inventory si JOIN public.stores s ON s.id = si.store_id
   WHERE si.id = p_inventory_id;
  IF v_item IS NULL THEN RETURN 0; END IF;

  INSERT INTO public.wishlist_stock_email_queue (user_id, store_id, location_id, catalog_item_id, inventory_id)
  SELECT DISTINCT w.user_id, v_store, p_location_id, v_item, p_inventory_id
    FROM public.wishlist_items w
    JOIN public.profiles p ON p.id = w.user_id
   WHERE w.catalog_item_id = v_item
     AND COALESCE(p.notifications_wishlist_alerts, true)
     AND COALESCE(p.notifications_email, true)
     AND public.customers_member_shopped(v_store, w.user_id)
     AND public.customers_wishlist_status(v_store, w.user_id) NOT IN ('revoked', 'declined', 'withdrawn')
     AND (NOT v_test OR public.wishlist_user_sees_test_data(w.user_id))
     AND NOT EXISTS (
       SELECT 1 FROM public.wishlist_stock_email_queue q
        WHERE q.user_id = w.user_id AND q.store_id = v_store AND q.catalog_item_id = v_item
          AND q.created_at > now() - interval '7 days');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.wishlist_queue_stock_emails(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Stock becoming available (none available before, some now).
CREATE OR REPLACE FUNCTION public.trg_wishlist_stock_emails()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new integer; v_old integer;
BEGIN
  v_new := COALESCE(NEW.quantity, 0) - COALESCE(NEW.quantity_reserved, 0);
  v_old := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.quantity, 0) - COALESCE(OLD.quantity_reserved, 0) END;
  IF v_old <= 0 AND v_new > 0 THEN
    BEGIN
      PERFORM public.wishlist_queue_stock_emails(NEW.inventory_id, NEW.location_id);
    EXCEPTION WHEN OTHERS THEN
      NULL; -- never block the stock change
    END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wishlist_stock_emails ON public.store_inventory_quantities;
CREATE TRIGGER wishlist_stock_emails AFTER INSERT OR UPDATE OF quantity, quantity_reserved ON public.store_inventory_quantities
  FOR EACH ROW EXECUTE FUNCTION public.trg_wishlist_stock_emails();
