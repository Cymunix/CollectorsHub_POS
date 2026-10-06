-- MyHR, part 10 (run after myhr_availability.sql): Onboarding.
-- A new staff member is set up by both sides; each task counts as done from
-- the real data (nothing to tick by hand). The job/position is set when the
-- staff member is created (their role), so it isn't a task:
--   Organization: pay (type, rate, pay period, and hours for hourly),
--   scheduling (role / hour targets saved), leave
--   entitlements (any for the current leave year).
--   Employee: personal data (name, date of birth, language), address (street,
--   city, province, postal code), emergency contact (name + phone),
--   availability (saved at least once).

ALTER TABLE public.store_employee_schedule_profiles
  ADD COLUMN IF NOT EXISTS availability_saved_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduling_saved_at   timestamptz;

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

-- One employee's onboarding (internal).
CREATE OR REPLACE FUNCTION public.myhr_onboarding_of(p_employee_id uuid, p_leave_year_start_month integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'pay', COALESCE(j.pay_type IS NOT NULL AND j.pay_rate IS NOT NULL AND j.pay_period IS NOT NULL
                    AND (j.pay_type = 'salary' OR j.hours_per_period IS NOT NULL), false),
    'scheduling', COALESCE(p.scheduling_saved_at IS NOT NULL, false),
    'leave', EXISTS (SELECT 1 FROM public.store_leave_entitlements le, public.myhr_leave_year(p_leave_year_start_month, current_date) y
                      WHERE le.employee_id = e.id AND le.year_start = y.year_start),
    'personal', COALESCE(NULLIF(btrim(e.first_name), '') IS NOT NULL AND NULLIF(btrim(e.last_name), '') IS NOT NULL
                         AND d.date_of_birth IS NOT NULL AND NULLIF(btrim(d.language), '') IS NOT NULL, false),
    'address', COALESCE(NULLIF(btrim(d.address_line1), '') IS NOT NULL AND NULLIF(btrim(d.city), '') IS NOT NULL
                        AND NULLIF(btrim(d.province), '') IS NOT NULL AND NULLIF(btrim(d.postal_code), '') IS NOT NULL, false),
    'emergency', COALESCE((NULLIF(btrim(d.emergency_first_name), '') IS NOT NULL OR NULLIF(btrim(d.emergency_name), '') IS NOT NULL)
                          AND NULLIF(btrim(d.emergency_phone), '') IS NOT NULL, false),
    'availability', COALESCE(p.availability_saved_at IS NOT NULL, false)
  )
    FROM public.store_employees e
    LEFT JOIN public.store_employee_jobs j ON j.employee_id = e.id
    LEFT JOIN public.store_employee_details d ON d.employee_id = e.id
    LEFT JOIN public.store_employee_schedule_profiles p ON p.employee_id = e.id
   WHERE e.id = p_employee_id
$$;
REVOKE ALL ON FUNCTION public.myhr_onboarding_of(uuid, integer) FROM PUBLIC;

-- My onboarding (the employee).
CREATE OR REPLACE FUNCTION public.myhr_my_onboarding(p_store_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.myhr_onboarding_of(public.myhr_employee_id(p_store_id), public.myhr_leave_year_start_month(p_store_id))
   WHERE public.myhr_employee_id(p_store_id) IS NOT NULL
$$;

-- The org: every employee's onboarding, with when they were added.
CREATE OR REPLACE FUNCTION public.myhr_org_onboarding(p_org_id uuid)
RETURNS TABLE (employee_id uuid, added_at timestamptz, onboarding jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_month integer;
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can see onboarding.';
  END IF;
  SELECT COALESCE((SELECT m.leave_year_start_month FROM public.organization_myhr_settings m WHERE m.organization_id = p_org_id), 1) INTO v_month;
  RETURN QUERY
  SELECT DISTINCT ON (e.id) e.id, e.created_at, public.myhr_onboarding_of(e.id, v_month)
    FROM public.store_employees e
    JOIN public.stores s ON s.organization_id = p_org_id
     AND (e.store_id = s.id OR (e.store_id IS NULL AND e.store_owner_id = s.owner_user_id))
   ORDER BY e.id;
END $$;

GRANT EXECUTE ON FUNCTION public.myhr_save_my_availability_profile(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_save_schedule_profile(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_my_onboarding(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_onboarding(uuid) TO authenticated;

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

CREATE OR REPLACE FUNCTION public.myhr_schedule_staff(p_store_id uuid)
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
   WHERE COALESCE(e.store_id, p_store_id) = p_store_id AND e.status = 'active'
   ORDER BY 2;
END $$;
GRANT EXECUTE ON FUNCTION public.myhr_org_schedule_profile(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_schedule_staff(uuid) TO authenticated;
