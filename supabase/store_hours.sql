-- Store hours (run after myhr_onboarding.sql): opening hours per location,
-- set by the ORGANIZATION. Stored by weekday (0 = Sunday … 6 = Saturday):
--   { "1": { "open": "10:00", "close": "18:00" }, "0": null, … }
-- null (or missing) = closed that day. A readable summary is also kept in
-- store_locations.business_hours for anything that shows the old text field.
-- Staff and managers read their store's hours (the Schedule Builder uses them).

ALTER TABLE public.store_locations
  ADD COLUMN IF NOT EXISTS opening_hours  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS business_hours text;

-- The org owner: every location's hours.
CREATE OR REPLACE FUNCTION public.org_location_hours(p_org_id uuid)
RETURNS TABLE (location_id uuid, location_name text, store_id uuid, store_name text, opening_hours jsonb, business_hours text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can see store hours.';
  END IF;
  RETURN QUERY
  SELECT l.id, l.location_name, s.id, s.store_name, COALESCE(l.opening_hours, '{}'::jsonb), l.business_hours
    FROM public.store_locations l
    JOIN public.stores s ON s.id = l.store_id
   WHERE s.organization_id = p_org_id
   ORDER BY s.store_name, l.created_at;
END $$;

-- The org owner: set one location's hours (and its readable summary).
CREATE OR REPLACE FUNCTION public.org_set_location_hours(p_org_id uuid, p_location_id uuid, p_hours jsonb, p_summary text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can change store hours.';
  END IF;
  UPDATE public.store_locations l
     SET opening_hours = COALESCE(p_hours, '{}'::jsonb),
         business_hours = NULLIF(btrim(p_summary), '')
    FROM public.stores s
   WHERE l.id = p_location_id AND s.id = l.store_id AND s.organization_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That location isn''t in this organization.'; END IF;
END $$;

-- Staff / managers: their store's hours (its first location).
CREATE OR REPLACE FUNCTION public.store_opening_hours(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.myhr_employee_id(p_store_id) IS NULL AND NOT public.myhr_is_manager(p_store_id) THEN
    RAISE EXCEPTION 'You are not an active employee of this store.';
  END IF;
  RETURN (SELECT COALESCE(l.opening_hours, '{}'::jsonb) FROM public.store_locations l
           WHERE l.store_id = p_store_id ORDER BY l.created_at LIMIT 1);
END $$;

GRANT EXECUTE ON FUNCTION public.org_location_hours(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_set_location_hours(uuid, uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.store_opening_hours(uuid) TO authenticated;
