-- Customers' full (legal) name on their CollectorsHub profile, and whether a
-- store has confirmed it against ID. A customer can't sell to a store (a buy
-- or trade-in at the register) until their full name is confirmed.
--
--   * profiles.full_name: set at sign-up (or by the register's Create Customer)
--   * full_name_confirmed_at / _store_id / _by: set only by a store confirming it
--     (the register's "Confirm name" or Create Customer with "I checked their
--     ID"); changing the name afterwards clears the confirmation, and a
--     customer can't mark their own name confirmed.
--
-- Changes handle_new_user (the website's new-account trigger) only to also
-- save full_name; copy this into the website's migrations too.
-- Rerunnable.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name_confirmed_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name_confirmed_store_id uuid REFERENCES public.stores(id) ON DELETE SET NULL;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name_confirmed_by uuid REFERENCES public.store_employees(id) ON DELETE SET NULL;

-- Keep the confirmation honest: only the confirm function (or the service
-- role, used by the Create Customer Edge Function) can set it, and any change
-- to the name clears it.
CREATE OR REPLACE FUNCTION public.profiles_full_name_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_confirming boolean := COALESCE(current_setting('collectorshub.confirming_name', true), '') = 'on' OR auth.uid() IS NULL;
BEGIN
  IF NOT v_confirming AND (NEW.full_name_confirmed_at IS DISTINCT FROM OLD.full_name_confirmed_at
      OR NEW.full_name_confirmed_store_id IS DISTINCT FROM OLD.full_name_confirmed_store_id
      OR NEW.full_name_confirmed_by IS DISTINCT FROM OLD.full_name_confirmed_by) THEN
    NEW.full_name_confirmed_at := OLD.full_name_confirmed_at;
    NEW.full_name_confirmed_store_id := OLD.full_name_confirmed_store_id;
    NEW.full_name_confirmed_by := OLD.full_name_confirmed_by;
  END IF;
  IF NEW.full_name IS DISTINCT FROM OLD.full_name AND NEW.full_name_confirmed_at IS NOT DISTINCT FROM OLD.full_name_confirmed_at THEN
    NEW.full_name_confirmed_at := NULL;
    NEW.full_name_confirmed_store_id := NULL;
    NEW.full_name_confirmed_by := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profiles_full_name_guard ON public.profiles;
CREATE TRIGGER profiles_full_name_guard
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_full_name_guard();

-- New accounts: as before (website migration 20260814_profiles_username), plus full_name.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, username, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name'),
    NULLIF(NEW.raw_user_meta_data ->> 'username', ''),
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), '')
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      -- Only set username if the profile doesn't already have one (immutable).
      username = COALESCE(public.profiles.username, EXCLUDED.username),
      full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name);

  RETURN NEW;
END $$;

-- Register: attach a member to the sale. Links them to the store as a
-- customer (if they aren't already) and returns their full name and whether
-- it's confirmed. Staff of the store only.
CREATE OR REPLACE FUNCTION public.attach_store_member(p_store_id uuid, p_profile_id uuid)
RETURNS TABLE (customer_id uuid, full_name text, full_name_confirmed_at timestamptz, confirmed_store_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_customer jsonb;
BEGIN
  IF p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  v_customer := public.ensure_store_customer_for_profile(p_store_id, p_profile_id);
  RETURN QUERY
  SELECT (v_customer->>'customer_id')::uuid, p.full_name, p.full_name_confirmed_at, st.store_name
    FROM public.profiles p
    LEFT JOIN public.stores st ON st.id = p.full_name_confirmed_store_id
   WHERE p.id = p_profile_id;
END $$;

-- Register: confirm (or correct and confirm) a member's full name after
-- checking their ID. Staff of the store only.
CREATE OR REPLACE FUNCTION public.confirm_customer_full_name(p_store_id uuid, p_profile_id uuid, p_full_name text)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name text := regexp_replace(btrim(COALESCE(p_full_name, '')), '\s+', ' ', 'g');
  v_at timestamptz := now();
BEGIN
  IF p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  IF length(v_name) < 2 THEN RAISE EXCEPTION 'Enter the customer''s full name as it appears on their ID.'; END IF;
  PERFORM public.ensure_store_customer_for_profile(p_store_id, p_profile_id);
  PERFORM set_config('collectorshub.confirming_name', 'on', true);
  UPDATE public.profiles
     SET full_name = v_name,
         full_name_confirmed_at = v_at,
         full_name_confirmed_store_id = p_store_id,
         full_name_confirmed_by = public.myhr_employee_id(p_store_id)
   WHERE id = p_profile_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CollectorsHub account not found.'; END IF;
  PERFORM set_config('collectorshub.confirming_name', 'off', true);
  RETURN v_at;
END $$;

GRANT EXECUTE ON FUNCTION public.attach_store_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_customer_full_name(uuid, uuid, text) TO authenticated;
