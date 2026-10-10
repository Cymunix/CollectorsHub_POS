-- CollectorsHub POS: Personal Settings (the signed-in employee's own profile, password and info).
-- Safe to run more than once.
--
-- Only the employee's own row is read or changed, and only their profile photo
-- (photo_path). Name, display name, role, permissions, store, organization and location
-- assignments stay read-only here (they're managed by the organization).
-- The password is the same one used to sign in (Supabase sign-in + the store PIN):
-- the app checks the current password, changes the Supabase password, then the PIN
-- with me_change_pin (which checks the current password again).

ALTER TABLE public.store_employees ADD COLUMN IF NOT EXISTS photo_path text;

-- Profile photos: private bucket, one folder per signed-in user.
INSERT INTO storage.buckets (id, name, public) VALUES ('employee-photos', 'employee-photos', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'employee_photos_own_insert') THEN
    CREATE POLICY employee_photos_own_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'employee-photos' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'employee_photos_own_select') THEN
    CREATE POLICY employee_photos_own_select ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'employee-photos' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'employee_photos_own_delete') THEN
    CREATE POLICY employee_photos_own_delete ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'employee-photos' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
END $$;

-- The signed-in user's employee row at a store.
CREATE OR REPLACE FUNCTION public.me_employee(p_store_id uuid)
RETURNS public.store_employees LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.* FROM public.store_employees e
   WHERE e.store_id = p_store_id AND (e.auth_user_id = auth.uid() OR e.employee_user_id = auth.uid())
   ORDER BY (e.status = 'active') DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.me_employee(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.me_profile(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE e public.store_employees;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first.'; END IF;
  e := public.me_employee(p_store_id);
  IF e.id IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  RETURN jsonb_build_object(
    'employee', jsonb_build_object('id', e.id, 'first_name', e.first_name, 'last_name', e.last_name, 'username', e.username,
                  'photo_path', e.photo_path, 'email', e.email, 'role', e.role, 'status', e.status, 'all_locations', COALESCE(e.all_locations, true), 'since', e.created_at),
    'store', (SELECT jsonb_build_object('id', s.id, 'name', s.store_name, 'code', s.store_code,
                'organization', (SELECT o.name FROM public.organizations o WHERE o.id = s.organization_id)) FROM public.stores s WHERE s.id = p_store_id),
    'locations', CASE WHEN COALESCE(e.all_locations, true)
                   THEN COALESCE((SELECT jsonb_agg(l.location_name ORDER BY l.created_at) FROM public.store_locations l WHERE l.store_id = p_store_id), '[]'::jsonb)
                   ELSE COALESCE((SELECT jsonb_agg(l.location_name ORDER BY l.created_at) FROM public.store_employee_locations el JOIN public.store_locations l ON l.id = el.location_id
                                   WHERE el.employee_id = e.id), '[]'::jsonb) END,
    -- Every store this account works at (read-only; signing in to another store uses its own store code).
    'assignments', COALESCE((SELECT jsonb_agg(jsonb_build_object('store', s.store_name, 'code', s.store_code, 'role', x.role, 'status', x.status,
                       'organization', (SELECT o.name FROM public.organizations o WHERE o.id = s.organization_id), 'current', x.store_id = p_store_id) ORDER BY s.store_name)
                     FROM public.store_employees x JOIN public.stores s ON s.id = x.store_id
                    WHERE x.auth_user_id = auth.uid() OR x.employee_user_id = auth.uid()), '[]'::jsonb),
    'account', (SELECT jsonb_build_object('email', u.email, 'last_sign_in_at', u.last_sign_in_at, 'created_at', u.created_at) FROM auth.users u WHERE u.id = auth.uid()));
END $$;

-- The only personal field an employee changes: their photo.
DROP FUNCTION IF EXISTS public.me_update_profile(uuid, text, text);
CREATE OR REPLACE FUNCTION public.me_update_photo(p_store_id uuid, p_photo_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e public.store_employees := public.me_employee(p_store_id);
BEGIN
  IF e.id IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  IF p_photo_path IS NOT NULL AND p_photo_path <> '' AND split_part(p_photo_path, '/', 1) <> auth.uid()::text THEN RAISE EXCEPTION 'That photo isn''t yours.'; END IF;
  UPDATE public.store_employees SET photo_path = NULLIF(p_photo_path, ''), updated_at = now() WHERE id = e.id;
END $$;

-- Is this the signed-in employee's current password? (re-authentication for sensitive changes)
CREATE OR REPLACE FUNCTION public.me_check_password(p_store_id uuid, p_password text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE e public.store_employees := public.me_employee(p_store_id);
BEGIN
  IF e.id IS NULL OR e.pin_hash IS NULL THEN RETURN false; END IF;
  RETURN crypt(btrim(COALESCE(p_password, '')), e.pin_hash) = e.pin_hash;
END $$;

-- The store PIN half of a password change (the app changes the Supabase sign-in first).
CREATE OR REPLACE FUNCTION public.me_change_pin(p_store_id uuid, p_current text, p_new text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE e public.store_employees := public.me_employee(p_store_id);
BEGIN
  IF e.id IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  IF e.pin_hash IS NULL OR crypt(btrim(COALESCE(p_current, '')), e.pin_hash) <> e.pin_hash THEN RAISE EXCEPTION 'Your current password isn''t correct.'; END IF;
  IF char_length(btrim(COALESCE(p_new, ''))) < 4 THEN RAISE EXCEPTION 'The new password must be at least 4 characters.'; END IF;
  UPDATE public.store_employees SET pin_hash = crypt(btrim(p_new), gen_salt('bf')), updated_at = now() WHERE id = e.id;
  IF to_regprocedure('public.log_store_employee_action(uuid,uuid,text,jsonb)') IS NOT NULL THEN
    PERFORM public.log_store_employee_action(p_store_id, e.id, 'employee_password_changed', jsonb_build_object('by', 'self'));
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.me_profile(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_update_photo(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_check_password(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.me_change_pin(uuid, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
