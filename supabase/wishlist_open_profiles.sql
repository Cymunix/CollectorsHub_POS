-- Wishlist sharing with stores, widened (2026-10-20). Run after customer_wishlists.sql.
-- Safe to run more than once.
--
-- A store can see a member's wishlist when:
--   * the member has completed any transaction at the store (bought from it OR sold to it), or
--   * the member's CollectorsHub profile is open (profiles.public_profile_enabled), or
--   * the member approved the store's request.
-- The member's own choice for a store still wins: turning sharing off for that store (or
-- declining) hides it again, whatever the rule above says.
--
-- store_wishlist_demand: while the store is buying, which catalogue items members it can see
-- have on their wishlist (for the "Wanted" badge on the register and the stock scanner).

-- Is the member's profile open (shared)? Missing column or profile: no.
CREATE OR REPLACE FUNCTION public.customers_profile_open(p_profile_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT p.public_profile_enabled FROM public.profiles p WHERE p.id = p_profile_id), false)
$$;
REVOKE ALL ON FUNCTION public.customers_profile_open(uuid) FROM PUBLIC, anon, authenticated;

-- Same as customer_wishlists.sql, with an open profile counting like having shopped here.
CREATE OR REPLACE FUNCTION public.customers_wishlist_status(p_store_id uuid, p_profile_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN a.status = 'granted' THEN 'granted'
    WHEN a.status IN ('revoked', 'declined', 'withdrawn') THEN a.status
    WHEN a.status = 'pending' AND a.expires_at > now() THEN 'pending'
    WHEN a.revoked_at IS NULL AND (public.customers_member_shopped(p_store_id, p_profile_id) OR public.customers_profile_open(p_profile_id)) THEN 'granted'
    WHEN a.status = 'pending' AND a.expires_at < now() THEN 'expired'
    ELSE COALESCE(a.status, 'none') END
  FROM (SELECT 1) one
  LEFT JOIN public.store_wishlist_access a ON a.store_id = p_store_id AND a.profile_id = p_profile_id
$$;
REVOKE ALL ON FUNCTION public.customers_wishlist_status(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- For each catalogue item: how many members whose wishlist this store can see want it,
-- and up to three of their names (staff of the store only).
DROP FUNCTION IF EXISTS public.store_wishlist_demand(uuid, uuid[]);
CREATE OR REPLACE FUNCTION public.store_wishlist_demand(p_store_id uuid, p_catalog_item_ids uuid[])
RETURNS TABLE (catalog_item_id uuid, members integer, names text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  IF p_catalog_item_ids IS NULL OR cardinality(p_catalog_item_ids) = 0 THEN RETURN; END IF;
  RETURN QUERY
  SELECT w.catalog_item_id,
         count(DISTINCT w.user_id)::integer,
         (array_agg(DISTINCT COALESCE(NULLIF(btrim(p.display_name), ''), p.username)) FILTER (WHERE p.id IS NOT NULL))[1:3]
    FROM public.wishlist_items w
    LEFT JOIN public.profiles p ON p.id = w.user_id
   WHERE w.catalog_item_id = ANY (p_catalog_item_ids[1:200])
     AND public.customers_wishlist_granted(p_store_id, w.user_id)
   GROUP BY w.catalog_item_id;
END $$;
REVOKE ALL ON FUNCTION public.store_wishlist_demand(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_wishlist_demand(uuid, uuid[]) TO authenticated;
