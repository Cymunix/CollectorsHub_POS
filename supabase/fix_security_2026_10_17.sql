-- Security fixes and MyHR repair (2026-10-17). Run once in the Supabase SQL editor. Safe to run again.
--
-- Part A puts every MyHR function that is defined in more than one file back to its newest
-- version. Re-running older MyHR files (for example myhr_pay.sql or myhr_schedule_builder.sql)
-- replaces newer versions with older ones, so after this, don't re-run whole MyHR files.
-- Part B: the security fixes.
-- 1. MyHR: an all-locations employee (no store set) belongs only to the stores of the owner
--    who added them, not to every store.
-- 2. Travel & Expenses: a store manager decides only in a store they can access.
-- 3. Refunds and voids: a missing permission means "not allowed" (needs approval); the same
--    item listed twice, in any letter case, is counted once.

-- ── Part A: MyHR functions defined in more than one file, restored to their newest version ──
-- Re-running older MyHR files can put back older versions (or leave older overloads behind).

-- myhr_my_details: newest in myhr_personal_data.sql
DROP FUNCTION IF EXISTS public.myhr_my_details(uuid);
CREATE FUNCTION public.myhr_my_details(p_store_id uuid)
RETURNS TABLE (
  first_name text, last_name text, email text, username text, role text, status text,
  employee_since timestamptz, store_name text, personnel_number text,
  phone text, address_line1 text, address_line2 text, city text, province text, postal_code text,
  emergency_name text, emergency_relationship text, emergency_phone text,
  form_of_address text, middle_name text, initials text, known_as text,
  marital_status text, marital_since date, date_of_birth date, gender text, language text, nationality text,
  country text, care_of text, phone_area text,
  emergency_first_name text, emergency_last_name text, emergency_phone_area text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.first_name, e.last_name, d.contact_email, e.username, e.role, e.status, e.created_at, st.store_name, e.personnel_number,
         d.phone, d.address_line1, d.address_line2, d.city, d.province, d.postal_code,
         d.emergency_name, d.emergency_relationship, d.emergency_phone,
         d.form_of_address, d.middle_name, d.initials, d.known_as,
         d.marital_status, d.marital_since, d.date_of_birth, d.gender, d.language, d.nationality,
         d.country, d.care_of, d.phone_area,
         d.emergency_first_name, d.emergency_last_name, d.emergency_phone_area
    FROM public.store_employees e
    LEFT JOIN public.stores st ON st.id = p_store_id
    LEFT JOIN public.store_employee_details d ON d.employee_id = e.id
   WHERE e.id = public.myhr_employee_id(p_store_id)
$$;
GRANT EXECUTE ON FUNCTION public.myhr_my_details(uuid) TO authenticated;

-- myhr_my_leave: newest in myhr_leave_accounts.sql
DROP FUNCTION IF EXISTS public.myhr_my_leave(uuid);
CREATE FUNCTION public.myhr_my_leave(p_store_id uuid)
RETURNS TABLE (id uuid, leave_type text, start_date date, end_date date, start_time time, end_time time, hours numeric, days numeric,
               note text, status text, processor text, decided_at timestamptz, decision_note text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.leave_type, r.start_date, r.end_date, r.start_time, r.end_time, r.hours, r.days, r.note, r.status,
         COALESCE(NULLIF(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.username),
         r.decided_at, r.decision_note, r.created_at
    FROM public.store_leave_requests r
    LEFT JOIN public.store_employees p ON p.id = r.decided_by
   WHERE r.employee_id = public.myhr_employee_id(p_store_id)
   ORDER BY r.start_date DESC, r.start_time DESC NULLS LAST
   LIMIT 300
$$;
GRANT EXECUTE ON FUNCTION public.myhr_my_leave(uuid) TO authenticated;

-- myhr_org_save_schedule_profile: newest in myhr_onboarding.sql
DROP FUNCTION IF EXISTS public.myhr_org_save_schedule_profile(uuid, uuid, jsonb);
-- The org's scheduling saves record when (replaces part 8's version; same signature).
CREATE OR REPLACE FUNCTION public.myhr_org_save_schedule_profile(p_org_id uuid, p_employee_id uuid, p_profile jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can change scheduling settings.';
  END IF;
  IF public.myhr_org_employee_store(p_org_id, p_employee_id) IS NULL THEN
    RAISE EXCEPTION 'That employee isn''t in this organization.';
  END IF;
  INSERT INTO public.store_employee_schedule_profiles (employee_id) VALUES (p_employee_id) ON CONFLICT (employee_id) DO NOTHING;
  UPDATE public.store_employee_schedule_profiles SET
    schedule_role       = CASE WHEN p_profile ? 'schedule_role' THEN COALESCE(NULLIF(btrim(p_profile->>'schedule_role'), ''), 'Employee') ELSE schedule_role END,
    can_cover           = CASE WHEN p_profile ? 'can_cover' THEN COALESCE(ARRAY(SELECT btrim(x) FROM jsonb_array_elements_text(p_profile->'can_cover') x WHERE btrim(x) <> ''), '{}') ELSE can_cover END,
    target_hours        = CASE WHEN p_profile ? 'target_hours' THEN NULLIF(p_profile->>'target_hours', '')::numeric ELSE target_hours END,
    min_hours           = CASE WHEN p_profile ? 'min_hours' THEN NULLIF(p_profile->>'min_hours', '')::numeric ELSE min_hours END,
    max_hours           = CASE WHEN p_profile ? 'max_hours' THEN NULLIF(p_profile->>'max_hours', '')::numeric ELSE max_hours END,
    scheduling_saved_at = now(),
    updated_at          = now()
  WHERE employee_id = p_employee_id;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_org_save_schedule_profile(uuid, uuid, jsonb) TO authenticated;

-- myhr_org_schedule_profile: newest in myhr_onboarding.sql
DROP FUNCTION IF EXISTS public.myhr_org_schedule_profile(uuid, uuid);
-- Scheduling role defaults to the role they were created with (Manager,
-- Supervisor, Cashier…) until the organization sets one (replaces parts 8
-- and 9's versions; same signatures).
CREATE OR REPLACE FUNCTION public.myhr_org_schedule_profile(p_org_id uuid, p_employee_id uuid)
RETURNS TABLE (schedule_role text, can_cover text[], target_hours numeric, min_hours numeric, max_hours numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can see scheduling settings.';
  END IF;
  RETURN QUERY
  SELECT COALESCE(p.schedule_role, initcap(replace(e.role, '_', ' ')), 'Employee'), COALESCE(p.can_cover, '{}'), p.target_hours, p.min_hours, p.max_hours
    FROM public.store_employees e
    LEFT JOIN public.store_employee_schedule_profiles p ON p.employee_id = e.id
   WHERE e.id = p_employee_id;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_org_schedule_profile(uuid, uuid) TO authenticated;

-- myhr_request_leave: newest in myhr_leave_accounts.sql
DROP FUNCTION IF EXISTS public.myhr_request_leave(uuid, text, date, date, numeric, text);
DROP FUNCTION IF EXISTS public.myhr_request_leave(uuid, text, date, date, time, time, numeric, text);
CREATE FUNCTION public.myhr_request_leave(
  p_store_id uuid, p_type text, p_start date, p_end date, p_start_time time, p_end_time time, p_hours numeric, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id); v_id uuid;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;
  IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter the absence hours.'; END IF;
  INSERT INTO public.store_leave_requests (store_id, employee_id, leave_type, start_date, end_date, start_time, end_time, hours, days, note)
  VALUES (p_store_id, v_emp, p_type, p_start, p_end, p_start_time, p_end_time, p_hours, GREATEST(round(p_hours / 8, 1), 0.1), NULLIF(btrim(p_note), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_request_leave(uuid, text, date, date, time, time, numeric, text) TO authenticated;

-- myhr_save_details: newest in myhr_personal_data.sql
DROP FUNCTION IF EXISTS public.myhr_save_details(uuid, jsonb);
-- Save my details (only the keys given change). First and last name are
-- required whenever they're given. Name updates the employee record; contact
-- email and the remaining personal fields update the private details row.
CREATE OR REPLACE FUNCTION public.myhr_save_details(p_store_id uuid, p_details jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp uuid := public.myhr_employee_id(p_store_id);
  v_text text[] := ARRAY['phone','address_line1','address_line2','city','province','postal_code',
                         'emergency_name','emergency_relationship','emergency_phone',
                         'form_of_address','middle_name','initials','known_as',
                         'marital_status','gender','language','nationality','country','care_of','contact_email','phone_area',
                         'emergency_first_name','emergency_last_name','emergency_phone_area'];
  v_key text;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;

  IF p_details ? 'first_name' OR p_details ? 'last_name' THEN
    IF (p_details ? 'first_name' AND COALESCE(btrim(p_details->>'first_name'), '') = '')
       OR (p_details ? 'last_name' AND COALESCE(btrim(p_details->>'last_name'), '') = '') THEN
      RAISE EXCEPTION 'First and last name are required.';
    END IF;
    UPDATE public.store_employees SET
      first_name = CASE WHEN p_details ? 'first_name' THEN btrim(p_details->>'first_name') ELSE first_name END,
      last_name  = CASE WHEN p_details ? 'last_name' THEN btrim(p_details->>'last_name') ELSE last_name END
    WHERE id = v_emp;
  END IF;

  INSERT INTO public.store_employee_details (employee_id) VALUES (v_emp) ON CONFLICT (employee_id) DO NOTHING;
  IF p_details ? 'email' THEN
    UPDATE public.store_employee_details
       SET contact_email = NULLIF(btrim(p_details->>'email'), '')
     WHERE employee_id = v_emp;
  END IF;
  FOREACH v_key IN ARRAY v_text LOOP
    IF p_details ? v_key THEN
      EXECUTE format('UPDATE public.store_employee_details SET %I = $1 WHERE employee_id = $2', v_key)
        USING NULLIF(btrim(p_details->>v_key), ''), v_emp;
    END IF;
  END LOOP;
  IF p_details ? 'date_of_birth' THEN
    UPDATE public.store_employee_details SET date_of_birth = NULLIF(p_details->>'date_of_birth', '')::date WHERE employee_id = v_emp;
  END IF;
  IF p_details ? 'marital_since' THEN
    UPDATE public.store_employee_details SET marital_since = NULLIF(p_details->>'marital_since', '')::date WHERE employee_id = v_emp;
  END IF;
  UPDATE public.store_employee_details SET updated_at = now() WHERE employee_id = v_emp;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_save_details(uuid, jsonb) TO authenticated;

-- myhr_save_my_availability_profile: newest in myhr_onboarding.sql
DROP FUNCTION IF EXISTS public.myhr_save_my_availability_profile(uuid, jsonb);
-- Availability saves record when (replaces part 9's version; same signature).
CREATE OR REPLACE FUNCTION public.myhr_save_my_availability_profile(p_store_id uuid, p_profile jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;
  INSERT INTO public.store_employee_schedule_profiles (employee_id) VALUES (v_emp) ON CONFLICT (employee_id) DO NOTHING;
  UPDATE public.store_employee_schedule_profiles SET
    availability          = COALESCE(p_profile->'availability', '{}'::jsonb),
    preferred_hours       = NULLIF(p_profile->>'preferred_hours', '')::numeric,
    most_hours            = NULLIF(p_profile->>'most_hours', '')::numeric,
    restrictions          = COALESCE(ARRAY(SELECT x FROM jsonb_array_elements_text(COALESCE(p_profile->'restrictions', '[]'::jsonb)) x
                                            WHERE x IN ('no_open','no_close','needs_keyholder','not_alone')), '{}'),
    availability_note     = NULLIF(btrim(p_profile->>'note'), ''),
    availability_saved_at = now(),
    updated_at            = now()
  WHERE employee_id = v_emp;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_save_my_availability_profile(uuid, jsonb) TO authenticated;

-- myhr_schedule_staff: newest in myhr_onboarding.sql
DROP FUNCTION IF EXISTS public.myhr_schedule_staff(uuid);
CREATE FUNCTION public.myhr_schedule_staff(p_store_id uuid)
RETURNS TABLE (id uuid, name text, short_name text, schedule_role text, can_cover text[], target_hours numeric, min_hours numeric, max_hours numeric,
               availability jsonb, hourly_cost numeric, preferred_hours numeric, most_hours numeric, restrictions text[], availability_note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can build the schedule.'; END IF;
  RETURN QUERY
  SELECT e.id,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'),
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, CASE WHEN e.last_name IS NOT NULL AND e.last_name <> '' THEN left(e.last_name, 1) || '.' END)), ''), e.username, 'Employee'),
         COALESCE(p.schedule_role, initcap(replace(e.role, '_', ' ')), 'Employee'), COALESCE(p.can_cover, '{}'), p.target_hours, p.min_hours, p.max_hours,
         COALESCE(p.availability, '{}'::jsonb),
         CASE WHEN j.pay_type = 'salary' THEN round(j.pay_rate / 2080, 2) ELSE j.pay_rate END,
         p.preferred_hours, p.most_hours, COALESCE(p.restrictions, '{}'), p.availability_note
    FROM public.store_employees e
    LEFT JOIN public.store_employee_schedule_profiles p ON p.employee_id = e.id
    LEFT JOIN public.store_employee_jobs j ON j.employee_id = e.id
   WHERE (e.store_id = p_store_id OR (e.store_id IS NULL AND e.store_owner_id = (SELECT s0.owner_user_id FROM public.stores s0 WHERE s0.id = p_store_id))) AND e.status = 'active'
   ORDER BY 2;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_schedule_staff(uuid) TO authenticated;

-- myhr_store_leave: newest in myhr_leave_accounts.sql
DROP FUNCTION IF EXISTS public.myhr_store_leave(uuid);
CREATE FUNCTION public.myhr_store_leave(p_store_id uuid)
RETURNS TABLE (id uuid, employee_name text, leave_type text, start_date date, end_date date, start_time time, end_time time,
               hours numeric, days numeric, note text, status text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see the store''s leave requests.'; END IF;
  RETURN QUERY
  SELECT r.id,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'),
         r.leave_type, r.start_date, r.end_date, r.start_time, r.end_time, r.hours, r.days, r.note, r.status, r.created_at
    FROM public.store_leave_requests r
    JOIN public.store_employees e ON e.id = r.employee_id
   WHERE r.store_id = p_store_id
     AND (r.status = 'pending' OR (r.status = 'approved' AND r.end_date >= current_date - 30))
   ORDER BY (r.status = 'pending') DESC, r.start_date
   LIMIT 200;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_store_leave(uuid) TO authenticated;

-- myhr_store_schedule: newest in myhr_schedule_builder.sql
DROP FUNCTION IF EXISTS public.myhr_store_schedule(uuid, timestamptz, timestamptz);
CREATE FUNCTION public.myhr_store_schedule(p_store_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (id uuid, employee_id uuid, employee_name text, starts_at timestamptz, ends_at timestamptz, note text, role text, break_minutes integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see the store schedule.'; END IF;
  RETURN QUERY
  SELECT s.id, s.employee_id,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Open shift'),
         s.starts_at, s.ends_at, s.note, s.role, s.break_minutes
    FROM public.store_shifts s
    LEFT JOIN public.store_employees e ON e.id = s.employee_id
   WHERE s.store_id = p_store_id AND s.starts_at < p_to AND s.ends_at > p_from
   ORDER BY s.starts_at, 3;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_store_schedule(uuid, timestamptz, timestamptz) TO authenticated;

-- myhr_team_shift_days: newest in myhr_schedule_builder.sql
DROP FUNCTION IF EXISTS public.myhr_team_shift_days(uuid, date, date);
-- The team calendar's "non-working day" uses the published schedule too.
CREATE OR REPLACE FUNCTION public.myhr_team_shift_days(p_store_id uuid, p_from date, p_to date)
RETURNS TABLE (employee_id uuid, day date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.myhr_employee_id(p_store_id) IS NULL AND NOT public.myhr_is_manager(p_store_id) THEN
    RAISE EXCEPTION 'You are not an active employee of this store.';
  END IF;
  RETURN QUERY
  SELECT DISTINCT (x->>'employee_id')::uuid, ((x->>'starts_at')::timestamptz AT TIME ZONE 'America/Halifax')::date
    FROM public.store_schedule_weeks w, jsonb_array_elements(w.shifts) x
   WHERE w.store_id = p_store_id
     AND ((x->>'starts_at')::timestamptz AT TIME ZONE 'America/Halifax')::date BETWEEN p_from AND p_to;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_team_shift_days(uuid, date, date) TO authenticated;

-- ── Part B: the security fixes (each function defined in one file only) ──

-- myhr_employee_id (from myhr_pay.sql)
-- The signed-in employee at a store.
CREATE OR REPLACE FUNCTION public.myhr_employee_id(p_store_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id FROM public.store_employees e
   WHERE (e.store_id = p_store_id
          -- An all-locations employee belongs only to the stores of the owner who added them.
          OR (e.store_id IS NULL AND EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND s.owner_user_id = e.store_owner_id)))
     AND (e.employee_user_id = auth.uid() OR e.auth_user_id = auth.uid())
     AND e.status = 'active'
   ORDER BY e.created_at
   LIMIT 1
$$;

-- myhr_store_staff (from myhr_schedule_profile.sql)
-- Managers: the store's active staff (for scheduling).
CREATE OR REPLACE FUNCTION public.myhr_store_staff(p_store_id uuid)
RETURNS TABLE (id uuid, name text, role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see the store''s staff.'; END IF;
  RETURN QUERY
  SELECT e.id, COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'), e.role
    FROM public.store_employees e
   WHERE (e.store_id = p_store_id OR (e.store_id IS NULL AND e.store_owner_id = (SELECT s0.owner_user_id FROM public.stores s0 WHERE s0.id = p_store_id))) AND e.status = 'active'
   ORDER BY 2;
END $$;

-- myhr_add_shift (from myhr_schedule_profile.sql)
-- Managers: add a shift.
CREATE OR REPLACE FUNCTION public.myhr_add_shift(p_store_id uuid, p_employee_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can schedule shifts.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_employees e WHERE e.id = p_employee_id AND (e.store_id = p_store_id OR (e.store_id IS NULL AND e.store_owner_id = (SELECT s0.owner_user_id FROM public.stores s0 WHERE s0.id = p_store_id))) AND e.status = 'active') THEN
    RAISE EXCEPTION 'That employee isn''t active at this store.';
  END IF;
  INSERT INTO public.store_shifts (store_id, employee_id, starts_at, ends_at, note, created_by)
  VALUES (p_store_id, p_employee_id, p_starts_at, p_ends_at, NULLIF(btrim(p_note), ''), public.myhr_employee_id(p_store_id))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- myhr_team_members (from myhr_team_calendar.sql)
-- MyHR, part 7 (run after myhr_timesheets.sql): the Team Calendar on the
-- leave request screen. Staff of a store can see who else is off and when
-- (sent / approved), never the type of someone else's leave; and who
-- approves leave at their store.

-- The store's active staff (names only), for the team calendar.
CREATE OR REPLACE FUNCTION public.myhr_team_members(p_store_id uuid)
RETURNS TABLE (id uuid, name text, first_name text, last_name text, is_me boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_me uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF v_me IS NULL AND NOT public.myhr_is_manager(p_store_id) THEN
    RAISE EXCEPTION 'You are not an active employee of this store.';
  END IF;
  RETURN QUERY
  SELECT e.id,
         COALESCE(NULLIF(btrim(concat_ws(' ', d.form_of_address, e.first_name, e.last_name)), ''), e.username, 'Employee'),
         COALESCE(e.first_name, e.username), COALESCE(e.last_name, ''),
         e.id = v_me
    FROM public.store_employees e
    LEFT JOIN public.store_employee_details d ON d.employee_id = e.id
   WHERE (e.store_id = p_store_id OR (e.store_id IS NULL AND e.store_owner_id = (SELECT s0.owner_user_id FROM public.stores s0 WHERE s0.id = p_store_id))) AND e.status = 'active';
END $$;

-- myhr_store_approvers (from myhr_team_calendar.sql)
-- Who approves leave at this store (its managers and the store owner's staff
-- record, if any).
CREATE OR REPLACE FUNCTION public.myhr_store_approvers(p_store_id uuid)
RETURNS TABLE (name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.myhr_employee_id(p_store_id) IS NULL AND NOT public.myhr_is_manager(p_store_id) THEN
    RAISE EXCEPTION 'You are not an active employee of this store.';
  END IF;
  RETURN QUERY
  SELECT COALESCE(NULLIF(btrim(concat_ws(' ', d.form_of_address, e.first_name, e.last_name)), ''), e.username)
    FROM public.store_employees e
    LEFT JOIN public.store_employee_details d ON d.employee_id = e.id
   WHERE (e.store_id = p_store_id OR (e.store_id IS NULL AND e.store_owner_id = (SELECT s0.owner_user_id FROM public.stores s0 WHERE s0.id = p_store_id))) AND e.status = 'active'
     AND lower(e.role) IN ('owner','manager','store_manager','assistant_manager')
   ORDER BY (lower(e.role) = 'owner') DESC, 1;
END $$;

-- myhr_save_shift (from myhr_schedule_builder.sql)
CREATE OR REPLACE FUNCTION public.myhr_save_shift(
  p_store_id uuid, p_shift_id uuid, p_employee_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_role text, p_break_minutes integer, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can schedule shifts.'; END IF;
  IF p_employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.store_employees e WHERE e.id = p_employee_id AND (e.store_id = p_store_id OR (e.store_id IS NULL AND e.store_owner_id = (SELECT s0.owner_user_id FROM public.stores s0 WHERE s0.id = p_store_id))) AND e.status = 'active') THEN
    RAISE EXCEPTION 'That employee isn''t active at this store.';
  END IF;
  IF p_ends_at <= p_starts_at THEN RAISE EXCEPTION 'A shift has to end after it starts.'; END IF;
  IF p_ends_at - p_starts_at < interval '4 hours' THEN RAISE EXCEPTION 'A shift must be at least 4 hours.'; END IF;
  IF p_ends_at - p_starts_at > interval '8 hours' THEN RAISE EXCEPTION 'A shift cannot be longer than 8 hours.'; END IF;
  IF p_shift_id IS NULL THEN
    INSERT INTO public.store_shifts (store_id, employee_id, starts_at, ends_at, note, role, break_minutes, created_by)
    VALUES (p_store_id, p_employee_id, p_starts_at, p_ends_at, NULLIF(btrim(p_note), ''), NULLIF(btrim(p_role), ''), GREATEST(COALESCE(p_break_minutes, 0), 0), public.myhr_employee_id(p_store_id))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.store_shifts
       SET employee_id = p_employee_id, starts_at = p_starts_at, ends_at = p_ends_at, note = NULLIF(btrim(p_note), ''),
           role = NULLIF(btrim(p_role), ''), break_minutes = GREATEST(COALESCE(p_break_minutes, 0), 0)
     WHERE id = p_shift_id AND store_id = p_store_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'That shift wasn''t found.'; END IF;
  END IF;
  RETURN v_id;
END $$;

-- te_approver_name (from myhr_travel_expenses.sql)
-- Who is deciding: the organization's owner (anywhere in their organization), or a store
-- manager (their own store, within the manager limit, never their own record).
-- Returns the approver's name, or null when they may not decide.
CREATE OR REPLACE FUNCTION public.te_approver_name(p_store_id uuid, p_org_id uuid, p_employee_id uuid, p_amount numeric)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_me uuid; v_limit numeric;
BEGIN
  IF public.te_is_org_owner(p_org_id) THEN
    RETURN COALESCE((SELECT name FROM public.organizations WHERE id = p_org_id), 'Organization');
  END IF;
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RETURN NULL; END IF;
  v_me := public.myhr_employee_id(p_store_id);
  IF v_me IS NULL OR v_me = p_employee_id OR NOT public.myhr_is_manager(p_store_id) THEN RETURN NULL; END IF;
  SELECT manager_approval_limit INTO v_limit FROM public.org_travel_policies WHERE organization_id = p_org_id;
  IF v_limit IS NULL OR COALESCE(p_amount, 0) > v_limit THEN RETURN NULL; END IF;
  RETURN public.te_employee_name(v_me);
END $$;

-- tx_access (from transactions.sql)
-- ── Access ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tx_access(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid; v_role text; v_perm jsonb := '{}'::jsonb; v_boss boolean; v_lead boolean;
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  v_emp := public.current_store_employee_id(p_store_id);
  SELECT lower(COALESCE(e.role, '')), COALESCE(e.action_permissions, e.permissions, '{}'::jsonb) INTO v_role, v_perm FROM public.store_employees e WHERE e.id = v_emp;
  v_boss := EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND (s.owner_user_id = auth.uid() OR s.organization_id IN (SELECT public.user_org_ids())));
  v_lead := COALESCE(v_boss, false) OR COALESCE(v_role, '') IN ('owner', 'manager', 'store_manager', 'assistant_manager', 'supervisor');
  v_perm := COALESCE(v_perm, '{}'::jsonb);
  -- Always true or false: a missing permission setting means "not allowed" (never null, which would skip checks).
  RETURN jsonb_build_object(
    'employee_id', v_emp,
    'view_all', v_lead OR COALESCE(v_perm ->> 'view_all_transactions', '') = 'true',
    'refund', v_lead OR COALESCE(v_perm ->> 'refunds', '') = 'true',
    'void', v_lead OR COALESCE(v_perm ->> 'voids', '') = 'true',
    'sensitive', v_lead,
    'refund_limit', 50);
END $$;

-- tx_refund (from transactions.sql)
-- ── Refund ──────────────────────────────────────────────────────────────────
-- p_lines: [{ item_id, quantity, restock }] (returned items), or [] for an amount-only refund.
-- p_amount: the amount to refund (defaults to the lines' value incl. their share of tax).
-- p_method: cash | card | store_credit.  p_request_id: a fresh uuid per attempt (retries return the first result).
CREATE OR REPLACE FUNCTION public.tx_refund(p_store_id uuid, p_location_id uuid, p_transaction_id uuid, p_lines jsonb, p_amount numeric,
                                            p_method text, p_reason text, p_request_id uuid, p_approver jsonb DEFAULT NULL, p_card_confirmed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_access jsonb := public.tx_access(p_store_id); t public.store_transactions; v_prev jsonb; v_paid numeric; v_refunded numeric; v_remaining numeric;
        v_line jsonb; it public.store_transaction_items; v_qty integer; v_done integer; v_amount numeric := 0; v_lines_amount numeric := 0; v_tax numeric := 0;
        v_out_total numeric; v_restock jsonb := '[]'::jsonb; v_records jsonb := '[]'::jsonb; v_approver uuid; v_card_paid numeric; v_card_refunded numeric;
        v_result jsonb; v_return uuid; v_share numeric; v_line_tax numeric; v_lines_tax numeric := 0; v_money_paid numeric; v_money_refunded numeric;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Missing request id.'; END IF;
  SELECT result INTO v_prev FROM public.store_refund_requests WHERE request_id = p_request_id;
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repeated', true); END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'A refund reason is required.'; END IF;
  IF p_method NOT IN ('cash', 'card', 'store_credit') THEN RAISE EXCEPTION 'Choose cash, card or store credit.'; END IF;

  -- Locks the sale so two refunds can't run at once.
  SELECT * INTO t FROM public.store_transactions WHERE id = p_transaction_id AND store_id = p_store_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Transaction not found.'; END IF;
  IF t.status <> 'completed' THEN RAISE EXCEPTION 'Only completed transactions can be refunded.'; END IF;
  IF t.transaction_type NOT IN ('sale', 'exchange') THEN RAISE EXCEPTION 'Only sales can be refunded. Buys and trade-ins aren''t refunds.'; END IF;
  IF p_location_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.store_locations l WHERE l.id = p_location_id AND l.store_id = p_store_id) THEN p_location_id := t.location_id; END IF;

  v_paid := public.tx_paid(t.id);
  v_refunded := public.tx_refunded(t.id);
  v_remaining := round(v_paid - v_refunded, 2);
  IF v_remaining <= 0 THEN RAISE EXCEPTION 'This transaction has already been fully refunded.'; END IF;

  SELECT COALESCE(sum(line_total), 0) INTO v_out_total FROM public.store_transaction_items WHERE transaction_id = t.id AND direction = 'out';
  -- The same item listed more than once counts once, with its quantities added together.
  FOR v_line IN
    SELECT jsonb_build_object('item_id', NULLIF(btrim(x ->> 'item_id'), '')::uuid, 'quantity', sum(GREATEST(COALESCE((x ->> 'quantity')::integer, 0), 0)),
                              'restock', bool_or(COALESCE((x ->> 'restock')::boolean, false)))
      FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) x
     GROUP BY NULLIF(btrim(x ->> 'item_id'), '')::uuid
  LOOP
    SELECT * INTO it FROM public.store_transaction_items WHERE id = NULLIF(v_line ->> 'item_id', '')::uuid AND transaction_id = t.id AND direction = 'out';
    IF it.id IS NULL THEN RAISE EXCEPTION 'That item isn''t part of this sale.'; END IF;
    v_qty := COALESCE((v_line ->> 'quantity')::integer, 0);
    IF v_qty < 1 THEN CONTINUE; END IF;
    SELECT COALESCE(sum(quantity), 0) INTO v_done FROM public.store_refund_lines WHERE original_item_id = it.id;
    IF v_qty > it.quantity - v_done THEN RAISE EXCEPTION 'Only % of "%" can still be refunded.', it.quantity - v_done, COALESCE(it.name_snapshot, 'this item'); END IF;
    -- The line's price paid, plus its share of the sale's tax.
    v_share := round(it.line_total / GREATEST(it.quantity, 1) * v_qty, 2);
    v_line_tax := CASE WHEN v_out_total > 0 THEN round(t.tax_total * v_share / v_out_total, 2) ELSE 0 END;
    v_share := v_share + v_line_tax;
    v_lines_tax := v_lines_tax + v_line_tax;
    v_lines_amount := v_lines_amount + v_share;
    v_records := v_records || jsonb_build_object('item_id', it.id, 'quantity', v_qty, 'amount', v_share, 'restock', COALESCE((v_line ->> 'restock')::boolean, false) AND it.inventory_id IS NOT NULL);
    IF COALESCE((v_line ->> 'restock')::boolean, false) AND it.inventory_id IS NOT NULL THEN
      v_restock := v_restock || jsonb_build_object('inventory_id', it.inventory_id, 'catalog_item_id', it.catalog_item_id, 'direction', 'in',
                    'name_snapshot', it.name_snapshot, 'sku_snapshot', it.sku_snapshot, 'condition', it.condition, 'grade', it.grade,
                    'unit_price', it.unit_price, 'quantity', v_qty, 'line_total', round(it.line_total / GREATEST(it.quantity, 1) * v_qty, 2));
    END IF;
  END LOOP;

  v_amount := round(COALESCE(NULLIF(p_amount, 0), v_lines_amount), 2);
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount or choose items to refund.'; END IF;
  IF v_amount > v_remaining THEN RAISE EXCEPTION 'At most % can still be refunded on this transaction.', to_char(v_remaining, 'FM$999,999,990.00'); END IF;

  -- What was paid with store credit goes back as store credit, not cash or card.
  IF p_method IN ('cash', 'card') THEN
    SELECT COALESCE(sum(amount) FILTER (WHERE amount > 0 AND method NOT IN ('store_credit', 'trade_credit')), 0) INTO v_money_paid FROM public.store_transaction_payments WHERE transaction_id = t.id;
    SELECT COALESCE(sum(refund_amount), 0) INTO v_money_refunded FROM public.store_return_records WHERE original_transaction_id = t.id AND refund_method IN ('cash', 'card');
    IF v_amount > v_money_paid - v_money_refunded + 0.005 THEN
      RAISE EXCEPTION 'At most % can be refunded as cash or card; the rest was paid with store credit, so refund that as store credit.', to_char(GREATEST(v_money_paid - v_money_refunded, 0), 'FM$999,999,990.00');
    END IF;
  END IF;

  -- Card: no more than was paid by card, and only after it was refunded on the terminal.
  IF p_method = 'card' THEN
    SELECT COALESCE(sum(amount) FILTER (WHERE amount > 0), 0) INTO v_card_paid FROM public.store_transaction_payments WHERE transaction_id = t.id AND method IN ('card', 'debit', 'credit');
    SELECT COALESCE(sum(refund_amount), 0) INTO v_card_refunded FROM public.store_return_records WHERE original_transaction_id = t.id AND refund_method = 'card';
    IF v_card_paid <= 0 THEN RAISE EXCEPTION 'This sale wasn''t paid by card. Refund it as cash or store credit.'; END IF;
    IF v_amount > v_card_paid - v_card_refunded + 0.005 THEN RAISE EXCEPTION 'At most % can go back to the card.', to_char(v_card_paid - v_card_refunded, 'FM$999,999,990.00'); END IF;
    IF NOT COALESCE(p_card_confirmed, false) THEN RAISE EXCEPTION 'Refund the card on the payment terminal first, then confirm it here.'; END IF;
  END IF;

  -- Permission: refunds permission, or up to the limit, or a manager's approval.
  IF NOT COALESCE((v_access ->> 'refund')::boolean, false) AND v_amount > COALESCE((v_access ->> 'refund_limit')::numeric, 0) THEN
    v_approver := public.tx_check_approver(p_store_id, p_approver);
    IF v_approver IS NULL THEN RAISE EXCEPTION 'APPROVAL_REQUIRED: Refunds over % need a supervisor or manager.', to_char((v_access ->> 'refund_limit')::numeric, 'FM$999,990.00'); END IF;
  ELSIF p_approver IS NOT NULL THEN
    v_approver := public.tx_check_approver(p_store_id, p_approver);
  END IF;

  -- The existing return engine: linked 'return' transaction, return record, restock, store credit.
  v_result := public.complete_store_return(t.id, p_location_id, v_restock, p_method, v_amount, btrim(p_reason));
  v_return := (v_result ->> 'transaction_id')::uuid;
  v_tax := CASE WHEN v_lines_amount > 0 THEN round(v_lines_tax * v_amount / v_lines_amount, 2)
                ELSE round(v_amount * t.tax_total / NULLIF(t.subtotal + t.tax_total, 0), 2) END;
  v_tax := LEAST(v_amount, GREATEST(COALESCE(v_tax, 0), 0));
  UPDATE public.store_transactions SET subtotal = -(v_amount - v_tax), tax_total = -v_tax WHERE id = v_return;

  INSERT INTO public.store_refund_lines (store_id, original_transaction_id, return_transaction_id, original_item_id, quantity, amount, restocked)
  SELECT p_store_id, t.id, v_return, (r ->> 'item_id')::uuid, (r ->> 'quantity')::integer, (r ->> 'amount')::numeric, (r ->> 'restock')::boolean
    FROM jsonb_array_elements(v_records) r;

  INSERT INTO public.store_transaction_audit (store_id, transaction_id, location_id, employee_id, actor_user, action, reason, detail)
  VALUES (p_store_id, t.id, p_location_id, public.current_store_employee_id(p_store_id), auth.uid(), 'refund_completed', btrim(p_reason),
          jsonb_build_object('return_transaction_id', v_return, 'return_number', v_result ->> 'transaction_number', 'amount', v_amount, 'tax', v_tax,
                             'method', p_method, 'lines', v_records, 'approved_by', v_approver, 'card_terminal_confirmed', p_method = 'card'));

  v_result := jsonb_build_object('transaction_id', v_return, 'transaction_number', v_result ->> 'transaction_number', 'amount', v_amount, 'tax', v_tax,
                                 'method', p_method, 'remaining', round(v_remaining - v_amount, 2));
  INSERT INTO public.store_refund_requests (request_id, store_id, original_transaction_id, result) VALUES (p_request_id, p_store_id, t.id, v_result);
  RETURN v_result;
END $$;

-- tx_void (from transactions.sql)
-- ── Void (only transactions that aren't completed) ──────────────────────────
CREATE OR REPLACE FUNCTION public.tx_void(p_store_id uuid, p_transaction_id uuid, p_reason text, p_approver jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_access jsonb := public.tx_access(p_store_id); t public.store_transactions; v_approver uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'A reason is required.'; END IF;
  SELECT * INTO t FROM public.store_transactions WHERE id = p_transaction_id AND store_id = p_store_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Transaction not found.'; END IF;
  IF t.status = 'void' THEN RAISE EXCEPTION 'This transaction is already voided.'; END IF;
  IF t.status = 'completed' THEN RAISE EXCEPTION 'Completed transactions can''t be voided. Refund it instead.'; END IF;
  IF NOT COALESCE((v_access ->> 'void')::boolean, false) THEN
    v_approver := public.tx_check_approver(p_store_id, p_approver);
    IF v_approver IS NULL THEN RAISE EXCEPTION 'APPROVAL_REQUIRED: Voids need a supervisor or manager.'; END IF;
  END IF;
  -- Not completed: no stock or payment was taken, so there's nothing to reverse.
  UPDATE public.store_transactions SET status = 'void' WHERE id = t.id;
  INSERT INTO public.store_transaction_audit (store_id, transaction_id, location_id, employee_id, actor_user, action, reason, detail)
  VALUES (p_store_id, t.id, t.location_id, public.current_store_employee_id(p_store_id), auth.uid(), 'voided', btrim(p_reason),
          jsonb_build_object('previous_status', t.status, 'approved_by', v_approver));
END $$;

NOTIFY pgrst, 'reload schema';
