-- CollectorsHub POS: Customers directory eligibility + wishlist matching.
-- Run after supabase/customers.sql. Safe to run more than once.
--
-- * The directory shows the store's own (non-member) customers, and CollectorsHub
--   members only once they have at least one completed transaction at this store.
--   Checkout lookup (search_store_credit_profiles / attach_store_member) is unchanged.
-- * Wishlists stay in public.wishlist_items (owner-only RLS, unchanged). There is no
--   existing "share my wishlist" setting. A member who has completed a transaction at a
--   store shares their wishlist with that store automatically; they can turn it off (or
--   back on) per store at collectorshub.ca/collection-scanning, and a store can ask a
--   member who hasn't shopped there (?wishlist=<id>). Choices live in store_wishlist_access.
--   Stores only read wishlists; nothing here lets a store change one.
-- * Matching is exact on the catalogue id (items.item_id), so variants, editions and
--   sets that are separate catalogue items never cross-match. Only active stock with
--   quantity - quantity_reserved > 0 counts. Counts are computed live from indexed
--   joins, so they follow inventory and wishlist changes without a refresh job.

-- ── Member consent: which stores may match against a member's wishlist ──────
CREATE TABLE IF NOT EXISTS public.store_wishlist_access (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  profile_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'declined', 'revoked', 'expired', 'withdrawn')),
  requested_by  uuid,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '2 days',
  decided_at    timestamptz,
  revoked_at    timestamptz,
  CONSTRAINT store_wishlist_access_store_profile_key UNIQUE (store_id, profile_id)
);
CREATE INDEX IF NOT EXISTS store_wishlist_access_granted_idx ON public.store_wishlist_access (store_id, profile_id) WHERE status = 'granted';
CREATE INDEX IF NOT EXISTS store_wishlist_access_profile_idx ON public.store_wishlist_access (profile_id, status);
ALTER TABLE public.store_wishlist_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_wishlist_access FROM anon, authenticated;

-- Directory counts use completed transactions per customer at a store.
CREATE INDEX IF NOT EXISTS store_txn_store_customer_completed_idx ON public.store_transactions (store_id, customer_id) WHERE status = 'completed';

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Catalogue items this store (or one location) has available to sell now.
CREATE OR REPLACE FUNCTION public.customers_available_stock(p_store_id uuid, p_location_id uuid DEFAULT NULL)
RETURNS TABLE (catalog_item_id uuid, available bigint, price_min numeric, price_max numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT si.catalog_item_id,
         sum(q.quantity - q.quantity_reserved)::bigint,
         min(COALESCE(si.in_store_price, si.sell_price)),
         max(COALESCE(si.in_store_price, si.sell_price))
    FROM public.store_inventory si
    JOIN public.store_inventory_quantities q ON q.inventory_id = si.id
   WHERE si.store_id = p_store_id AND si.status = 'active' AND si.catalog_item_id IS NOT NULL
     AND (p_location_id IS NULL OR q.location_id = p_location_id)
     AND (q.quantity - q.quantity_reserved) > 0
   GROUP BY si.catalog_item_id
$$;
REVOKE ALL ON FUNCTION public.customers_available_stock(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Has this member completed a transaction at this store?
CREATE OR REPLACE FUNCTION public.customers_member_shopped(p_store_id uuid, p_profile_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.store_customers c JOIN public.store_transactions t ON t.store_id = c.store_id AND t.customer_id = c.id AND t.status = 'completed'
     WHERE c.store_id = p_store_id AND c.collectorshub_user_id = p_profile_id)
$$;
REVOKE ALL ON FUNCTION public.customers_member_shopped(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Effective wishlist access for a store: the member's own choice wins (granted,
-- or revoked / declined, or the store withdrew); otherwise a member who has
-- shopped at the store shares their wishlist with it automatically, unless they
-- once turned sharing off for that store (revoked_at stays set until they turn
-- it back on, so a store asking again can't bring automatic sharing back).
-- Returns granted | revoked | declined | withdrawn | pending | expired | none.
CREATE OR REPLACE FUNCTION public.customers_wishlist_status(p_store_id uuid, p_profile_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN a.status = 'granted' THEN 'granted'
    WHEN a.status IN ('revoked', 'declined', 'withdrawn') THEN a.status
    WHEN a.status = 'pending' AND a.expires_at > now() THEN 'pending'
    WHEN a.revoked_at IS NULL AND public.customers_member_shopped(p_store_id, p_profile_id) THEN 'granted'
    WHEN a.status = 'pending' AND a.expires_at < now() THEN 'expired'
    ELSE COALESCE(a.status, 'none') END
  FROM (SELECT 1) one
  LEFT JOIN public.store_wishlist_access a ON a.store_id = p_store_id AND a.profile_id = p_profile_id
$$;
REVOKE ALL ON FUNCTION public.customers_wishlist_status(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.customers_wishlist_granted(p_store_id uuid, p_profile_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_profile_id IS NOT NULL AND public.customers_wishlist_status(p_store_id, p_profile_id) = 'granted'
$$;
REVOKE ALL ON FUNCTION public.customers_wishlist_granted(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── Summary (same eligibility as the directory) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.customers_summary(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  RETURN (
    WITH eligible AS (
      SELECT c.* FROM public.store_customers c
       WHERE c.store_id = p_store_id AND c.status <> 'merged'
         AND (c.collectorshub_user_id IS NULL OR EXISTS (SELECT 1 FROM public.store_transactions t WHERE t.store_id = p_store_id AND t.customer_id = c.id AND t.status = 'completed'))
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM eligible),
      'members', (SELECT count(*) FROM eligible WHERE collectorshub_user_id IS NOT NULL),
      'outstanding_credit', (SELECT COALESCE(sum(amount), 0) FROM public.store_credit_ledger WHERE store_id = p_store_id),
      'new_this_month', (SELECT count(*) FROM eligible WHERE created_at >= date_trunc('month', now())),
      'wishlist_customers', (SELECT count(*) FROM eligible e WHERE e.collectorshub_user_id IS NOT NULL AND public.customers_wishlist_granted(p_store_id, e.collectorshub_user_id)))
  );
END $$;

-- ── Directory ───────────────────────────────────────────────────────────────
-- p_filter: all | members | store | active | inactive | wishlist (has matches)
-- p_sort:   recent | name | transactions | matches
DROP FUNCTION IF EXISTS public.customers_list(uuid, text, text, integer, integer);
DROP FUNCTION IF EXISTS public.customers_list(uuid, text, text, integer, integer, text, uuid);
CREATE FUNCTION public.customers_list(p_store_id uuid, p_search text DEFAULT '', p_filter text DEFAULT 'all', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0,
                                      p_sort text DEFAULT 'recent', p_location_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, customer_number text, name text, first_name text, last_name text, username text, avatar_url text, is_member boolean,
               status text, email text, phone text, balance numeric, last_purchase timestamptz, transactions integer,
               wishlist_access text, wishlist_matches integer, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q text := lower(btrim(COALESCE(p_search, '')));
        v_digits text := regexp_replace(COALESCE(p_search, ''), '[^0-9]', '', 'g');
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.store_locations l WHERE l.id = p_location_id AND l.store_id = p_store_id) THEN p_location_id := NULL; END IF;
  RETURN QUERY
  WITH tx AS (
    SELECT t.customer_id, count(*)::int AS n, max(t.created_at) AS last_at
      FROM public.store_transactions t
     WHERE t.store_id = p_store_id AND t.status = 'completed' AND t.customer_id IS NOT NULL
     GROUP BY t.customer_id
  ),
  -- Wishlist access of each member who has shopped here (automatic unless turned off; customers_wishlist_status).
  member_access AS (
    SELECT g.uid, public.customers_wishlist_status(p_store_id, g.uid) AS st
      FROM (SELECT DISTINCT c.collectorshub_user_id AS uid
              FROM public.store_customers c JOIN tx ON tx.customer_id = c.id
             WHERE c.store_id = p_store_id AND c.status <> 'merged' AND c.collectorshub_user_id IS NOT NULL) g
  ),
  avail AS (SELECT s.catalog_item_id FROM public.customers_available_stock(p_store_id, p_location_id) s),
  matches AS (
    SELECT w.user_id, count(*)::int AS n
      FROM member_access g
      JOIN public.wishlist_items w ON w.user_id = g.uid
      JOIN avail v ON v.catalog_item_id = w.catalog_item_id
     WHERE g.st = 'granted'
     GROUP BY w.user_id
  ),
  base AS (
    SELECT c.*, p.username AS p_username, p.avatar_url AS p_avatar, tx.n AS tx_n, tx.last_at AS tx_last, ac.st AS acc_status,
           CASE WHEN ac.st = 'granted' THEN COALESCE(m.n, 0) END AS m_n,
           COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), NULLIF(btrim(c.display_name), ''), p.display_name, p.username, c.membership_code, 'Customer') AS c_name
      FROM public.store_customers c
      LEFT JOIN public.profiles p ON p.id = c.collectorshub_user_id
      LEFT JOIN tx ON tx.customer_id = c.id
      LEFT JOIN member_access ac ON ac.uid = c.collectorshub_user_id
      LEFT JOIN matches m ON m.user_id = c.collectorshub_user_id
     WHERE c.store_id = p_store_id AND c.status <> 'merged'
       -- Members appear once they've completed a transaction here; the store's own customers always do.
       AND (c.collectorshub_user_id IS NULL OR tx.n > 0)
       AND CASE p_filter WHEN 'members' THEN c.collectorshub_user_id IS NOT NULL WHEN 'store' THEN c.collectorshub_user_id IS NULL
                         WHEN 'active' THEN c.status = 'active' WHEN 'inactive' THEN c.status = 'inactive'
                         WHEN 'wishlist' THEN ac.st = 'granted' AND COALESCE(m.n, 0) > 0 ELSE true END
       AND (v_q = '' OR lower(COALESCE(concat_ws(' ', c.first_name, c.last_name), '')) LIKE '%' || v_q || '%'
            OR lower(COALESCE(c.display_name, '')) LIKE '%' || v_q || '%' OR lower(COALESCE(p.username, '')) LIKE '%' || ltrim(v_q, '@') || '%'
            OR lower(COALESCE(c.customer_number, '')) LIKE '%' || v_q || '%' OR lower(COALESCE(c.membership_code, '')) LIKE '%' || ltrim(v_q, '@') || '%'
            OR lower(COALESCE(c.email, '')) LIKE '%' || v_q || '%'
            OR (length(v_digits) >= 4 AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE '%' || v_digits || '%'))
  )
  SELECT b.id, b.customer_number, b.c_name, b.first_name, b.last_name, b.p_username, b.p_avatar, b.collectorshub_user_id IS NOT NULL,
         b.status, b.email, b.phone, public.customers_balance(p_store_id, b.id, b.collectorshub_user_id),
         b.tx_last, COALESCE(b.tx_n, 0), b.acc_status, b.m_n,
         count(*) OVER ()
    FROM base b
   ORDER BY
     CASE WHEN p_sort = 'name' THEN lower(b.c_name) END ASC,
     CASE WHEN p_sort = 'transactions' THEN COALESCE(b.tx_n, 0) END DESC,
     CASE WHEN p_sort = 'matches' THEN COALESCE(b.m_n, -1) END DESC,
     b.tx_last DESC NULLS LAST, b.updated_at DESC NULLS LAST, b.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0);
END $$;

-- ── A member's wishlist, as this store may see it ───────────────────────────
-- p_filter: all | in_store | not_in_store. Returns { access, items } and only
-- returns items when the member has granted this store access.
CREATE OR REPLACE FUNCTION public.customer_wishlist(p_store_id uuid, p_customer_id uuid, p_location_id uuid DEFAULT NULL, p_filter text DEFAULT 'all')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.store_customers; a public.store_wishlist_access; v_status text;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  SELECT * INTO c FROM public.store_customers WHERE id = p_customer_id AND store_id = p_store_id AND status <> 'merged';
  IF c.id IS NULL THEN RAISE EXCEPTION 'Customer not found.'; END IF;
  IF c.collectorshub_user_id IS NULL THEN RETURN jsonb_build_object('access', jsonb_build_object('status', 'not_member'), 'items', '[]'::jsonb); END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.store_locations l WHERE l.id = p_location_id AND l.store_id = p_store_id) THEN p_location_id := NULL; END IF;
  SELECT * INTO a FROM public.store_wishlist_access WHERE store_id = p_store_id AND profile_id = c.collectorshub_user_id;
  v_status := public.customers_wishlist_status(p_store_id, c.collectorshub_user_id);
  IF v_status <> 'granted' THEN
    RETURN jsonb_build_object('access', jsonb_build_object('status', v_status, 'id', a.id, 'expires_at', a.expires_at, 'decided_at', COALESCE(a.revoked_at, a.decided_at)), 'items', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object(
    'access', jsonb_build_object('status', 'granted', 'id', a.id, 'automatic', a.status IS DISTINCT FROM 'granted',
                                'decided_at', CASE WHEN a.status = 'granted' THEN a.decided_at END),
    'counts', (SELECT jsonb_build_object('all', count(*), 'in_store', count(s.catalog_item_id), 'not_in_store', count(*) - count(s.catalog_item_id))
                 FROM public.wishlist_items w LEFT JOIN public.customers_available_stock(p_store_id, p_location_id) s ON s.catalog_item_id = w.catalog_item_id
                WHERE w.user_id = c.collectorshub_user_id),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'catalog_item_id', w.catalog_item_id, 'name', i.name, 'subject', i.subject, 'card_number', i.card_number,
               'release_year', i.release_year, 'set_name', cs.name,
               'image_path', COALESCE((SELECT ii.image_path FROM public.item_images ii WHERE ii.item_id = w.catalog_item_id AND NULLIF(ii.image_path, '') IS NOT NULL ORDER BY ii.position LIMIT 1), NULLIF(i.image_path, '')),
               'notes', to_jsonb(w) ->> 'notes', 'priority', to_jsonb(w) -> 'priority', 'added_at', to_jsonb(w) -> 'created_at',
               'available', COALESCE(s.available, 0), 'price_min', s.price_min, 'price_max', s.price_max,
               'stock', CASE WHEN s.catalog_item_id IS NULL THEN '[]'::jsonb ELSE (
                  SELECT COALESCE(jsonb_agg(jsonb_build_object('inventory_id', x.id, 'sku', x.sku, 'condition', x.condition, 'grade', x.grade,
                                                               'price', COALESCE(x.in_store_price, x.sell_price), 'available', x.qty) ORDER BY COALESCE(x.in_store_price, x.sell_price)), '[]'::jsonb)
                    FROM (SELECT si.id, si.sku, si.condition, si.grade, si.in_store_price, si.sell_price, sum(q.quantity - q.quantity_reserved) AS qty
                            FROM public.store_inventory si JOIN public.store_inventory_quantities q ON q.inventory_id = si.id
                           WHERE si.store_id = p_store_id AND si.status = 'active' AND si.catalog_item_id = w.catalog_item_id
                             AND (p_location_id IS NULL OR q.location_id = p_location_id) AND (q.quantity - q.quantity_reserved) > 0
                           GROUP BY si.id) x) END)
             ORDER BY (s.catalog_item_id IS NULL), (to_jsonb(w) ->> 'priority')::numeric DESC NULLS LAST, to_jsonb(w) ->> 'created_at' DESC NULLS LAST, i.name)
        FROM public.wishlist_items w
        JOIN public.items i ON i.item_id = w.catalog_item_id
        LEFT JOIN public.collectible_sets cs ON cs.collectible_set_id = i.collectible_set_id
        LEFT JOIN public.customers_available_stock(p_store_id, p_location_id) s ON s.catalog_item_id = w.catalog_item_id
       WHERE w.user_id = c.collectorshub_user_id
         AND CASE p_filter WHEN 'in_store' THEN s.catalog_item_id IS NOT NULL WHEN 'not_in_store' THEN s.catalog_item_id IS NULL ELSE true END), '[]'::jsonb)
  );
END $$;

-- ── Staff: ask a member for wishlist access, or stop using it ───────────────
CREATE OR REPLACE FUNCTION public.customer_wishlist_access_request(p_store_id uuid, p_customer_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.store_customers; v_id uuid;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  SELECT * INTO c FROM public.store_customers WHERE id = p_customer_id AND store_id = p_store_id AND status <> 'merged';
  IF c.id IS NULL THEN RAISE EXCEPTION 'Customer not found.'; END IF;
  IF c.collectorshub_user_id IS NULL THEN RAISE EXCEPTION 'Link their CollectorsHub account first.'; END IF;
  IF public.customers_wishlist_granted(p_store_id, c.collectorshub_user_id) THEN RAISE EXCEPTION 'This member already shares their wishlist with your store.'; END IF;
  -- The store had stopped using it itself (the member never turned it off): lifting that restores automatic sharing.
  DELETE FROM public.store_wishlist_access WHERE store_id = p_store_id AND profile_id = c.collectorshub_user_id AND status = 'withdrawn' AND revoked_at IS NULL;
  IF public.customers_wishlist_granted(p_store_id, c.collectorshub_user_id) THEN
    PERFORM public.customers_audit(p_store_id, c.id, 'wishlist_access_resumed', '{}'::jsonb);
    RETURN NULL;
  END IF;
  INSERT INTO public.store_wishlist_access AS x (store_id, profile_id, status, requested_by, requested_at, expires_at)
  VALUES (p_store_id, c.collectorshub_user_id, 'pending', auth.uid(), now(), now() + interval '2 days')
  ON CONFLICT (store_id, profile_id) DO UPDATE SET status = 'pending', requested_by = auth.uid(), requested_at = now(), expires_at = now() + interval '2 days', decided_at = NULL
  RETURNING x.id INTO v_id;
  PERFORM public.customers_audit(p_store_id, c.id, 'wishlist_access_requested', jsonb_build_object('access_id', v_id));
  RETURN v_id;
END $$;

-- Managers can stop using a member's wishlist (also blocks the automatic sharing).
-- Asking again (customer_wishlist_access_request) lifts it.
CREATE OR REPLACE FUNCTION public.customer_wishlist_access_withdraw(p_store_id uuid, p_customer_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.store_customers;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  IF NOT public.customers_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can stop using a customer''s wishlist.'; END IF;
  SELECT * INTO c FROM public.store_customers WHERE id = p_customer_id AND store_id = p_store_id;
  IF c.collectorshub_user_id IS NULL THEN RAISE EXCEPTION 'Customer not found.'; END IF;
  INSERT INTO public.store_wishlist_access (store_id, profile_id, status, requested_by, decided_at)
  VALUES (p_store_id, c.collectorshub_user_id, 'withdrawn', auth.uid(), now())
  ON CONFLICT (store_id, profile_id) DO UPDATE SET status = 'withdrawn', decided_at = now()
   WHERE public.store_wishlist_access.status IN ('pending', 'granted', 'expired');
  PERFORM public.customers_audit(p_store_id, c.id, 'wishlist_access_withdrawn', '{}'::jsonb);
END $$;

-- ── Member side (collectorshub.ca/collection-scanning) ──────────────────────
-- Every store that can see (or is asking to see) this member's wishlist:
-- stores they've shopped at share automatically unless turned off.
CREATE OR REPLACE FUNCTION public.wishlist_access_mine()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first.'; END IF;
  RETURN COALESCE((
    WITH stores_here AS (
      SELECT DISTINCT c.store_id FROM public.store_customers c
        JOIN public.store_transactions t ON t.store_id = c.store_id AND t.customer_id = c.id AND t.status = 'completed'
       WHERE c.collectorshub_user_id = auth.uid()
      UNION
      SELECT a.store_id FROM public.store_wishlist_access a
       WHERE a.profile_id = auth.uid() AND (a.status IN ('pending', 'granted', 'revoked', 'declined', 'withdrawn') OR a.requested_at > now() - interval '30 days')
    )
    SELECT jsonb_agg(jsonb_build_object(
             'store_id', h.store_id, 'store_name', s.store_name, 'id', a.id,
             'status', public.customers_wishlist_status(h.store_id, auth.uid()),
             'request_pending', a.status = 'pending' AND a.expires_at > now(),
             'automatic', a.status IS DISTINCT FROM 'granted' AND public.customers_wishlist_status(h.store_id, auth.uid()) = 'granted',
             'requested_at', a.requested_at, 'expires_at', a.expires_at, 'decided_at', COALESCE(a.revoked_at, a.decided_at))
           ORDER BY s.store_name)
      FROM stores_here h JOIN public.stores s ON s.id = h.store_id
      LEFT JOIN public.store_wishlist_access a ON a.store_id = h.store_id AND a.profile_id = auth.uid()
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.wishlist_access_decide(p_access_id uuid, p_approve boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.store_wishlist_access; v_customer uuid;
BEGIN
  SELECT * INTO a FROM public.store_wishlist_access WHERE id = p_access_id FOR UPDATE;
  IF a.id IS NULL OR a.profile_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Request not found.'; END IF;
  IF a.status <> 'pending' THEN RAISE EXCEPTION 'This request is already %.', a.status; END IF;
  IF a.expires_at < now() THEN UPDATE public.store_wishlist_access SET status = 'expired' WHERE id = a.id; RAISE EXCEPTION 'This request has expired.'; END IF;
  UPDATE public.store_wishlist_access SET status = CASE WHEN p_approve THEN 'granted' ELSE 'declined' END, decided_at = now(),
         revoked_at = CASE WHEN p_approve THEN NULL ELSE revoked_at END WHERE id = a.id;
  SELECT id INTO v_customer FROM public.store_customers WHERE store_id = a.store_id AND collectorshub_user_id = a.profile_id AND status <> 'merged' LIMIT 1;
  IF v_customer IS NOT NULL THEN
    INSERT INTO public.store_customer_audit (store_id, customer_id, actor_user, action) VALUES (a.store_id, v_customer, auth.uid(), CASE WHEN p_approve THEN 'wishlist_access_granted' ELSE 'wishlist_access_declined' END);
  END IF;
  RETURN CASE WHEN p_approve THEN 'granted' ELSE 'declined' END;
END $$;

-- The member turns sharing with one store on or off (works for automatic sharing too).
CREATE OR REPLACE FUNCTION public.wishlist_access_set(p_store_id uuid, p_share boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_customer uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id = p_store_id) THEN RAISE EXCEPTION 'Store not found.'; END IF;
  INSERT INTO public.store_wishlist_access AS x (store_id, profile_id, status, decided_at, revoked_at)
  VALUES (p_store_id, auth.uid(), CASE WHEN p_share THEN 'granted' ELSE 'revoked' END, CASE WHEN p_share THEN now() END, CASE WHEN p_share THEN NULL ELSE now() END)
  ON CONFLICT (store_id, profile_id) DO UPDATE SET status = EXCLUDED.status, decided_at = COALESCE(EXCLUDED.decided_at, x.decided_at), revoked_at = EXCLUDED.revoked_at;
  SELECT id INTO v_customer FROM public.store_customers WHERE store_id = p_store_id AND collectorshub_user_id = auth.uid() AND status <> 'merged' LIMIT 1;
  IF v_customer IS NOT NULL THEN
    INSERT INTO public.store_customer_audit (store_id, customer_id, actor_user, action)
    VALUES (p_store_id, v_customer, auth.uid(), CASE WHEN p_share THEN 'wishlist_access_granted' ELSE 'wishlist_access_revoked_by_member' END);
  END IF;
  RETURN CASE WHEN p_share THEN 'granted' ELSE 'revoked' END;
END $$;

GRANT EXECUTE ON FUNCTION public.customers_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customers_list(uuid, text, text, integer, integer, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_wishlist(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_wishlist_access_request(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_wishlist_access_withdraw(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wishlist_access_mine() TO authenticated;
GRANT EXECUTE ON FUNCTION public.wishlist_access_decide(uuid, boolean) TO authenticated;
DROP FUNCTION IF EXISTS public.wishlist_access_revoke(uuid);
GRANT EXECUTE ON FUNCTION public.wishlist_access_set(uuid, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
