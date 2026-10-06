-- MyHR, part 9 (run after myhr_schedule_builder.sql): the Availability
-- profile. Each employee sets, for themselves: the days and time windows they
-- can work, preferred and most hours per week, restrictions (can't open,
-- can't close, needs a keyholder on shift, can't work alone) and a note.
-- Managers see it in the Schedule Builder; they can't change it.

ALTER TABLE public.store_employee_schedule_profiles
  ADD COLUMN IF NOT EXISTS preferred_hours   numeric(5,2),
  ADD COLUMN IF NOT EXISTS most_hours        numeric(5,2),
  ADD COLUMN IF NOT EXISTS restrictions      text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS availability_note text;

-- My availability profile.
CREATE OR REPLACE FUNCTION public.myhr_my_availability_profile(p_store_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
           'availability', COALESCE(p.availability, '{}'::jsonb),
           'preferred_hours', p.preferred_hours,
           'most_hours', p.most_hours,
           'restrictions', to_jsonb(COALESCE(p.restrictions, '{}')),
           'note', p.availability_note,
           'updated_at', p.updated_at)
    FROM (SELECT public.myhr_employee_id(p_store_id) AS id) me
    LEFT JOIN public.store_employee_schedule_profiles p ON p.employee_id = me.id
   WHERE me.id IS NOT NULL
$$;

-- Save my availability profile.
CREATE OR REPLACE FUNCTION public.myhr_save_my_availability_profile(p_store_id uuid, p_profile jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;
  INSERT INTO public.store_employee_schedule_profiles (employee_id) VALUES (v_emp) ON CONFLICT (employee_id) DO NOTHING;
  UPDATE public.store_employee_schedule_profiles SET
    availability      = COALESCE(p_profile->'availability', '{}'::jsonb),
    preferred_hours   = NULLIF(p_profile->>'preferred_hours', '')::numeric,
    most_hours        = NULLIF(p_profile->>'most_hours', '')::numeric,
    restrictions      = COALESCE(ARRAY(SELECT x FROM jsonb_array_elements_text(COALESCE(p_profile->'restrictions', '[]'::jsonb)) x
                                        WHERE x IN ('no_open','no_close','needs_keyholder','not_alone')), '{}'),
    availability_note = NULLIF(btrim(p_profile->>'note'), ''),
    updated_at        = now()
  WHERE employee_id = v_emp;
END $$;

-- Managers: staff for the builder, now with the availability profile.
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
         COALESCE(p.schedule_role, 'Employee'), COALESCE(p.can_cover, '{}'), p.target_hours, p.min_hours, p.max_hours,
         COALESCE(p.availability, '{}'::jsonb),
         CASE WHEN j.pay_type = 'salary' THEN round(j.pay_rate / 2080, 2) ELSE j.pay_rate END,
         p.preferred_hours, p.most_hours, COALESCE(p.restrictions, '{}'), p.availability_note
    FROM public.store_employees e
    LEFT JOIN public.store_employee_schedule_profiles p ON p.employee_id = e.id
    LEFT JOIN public.store_employee_jobs j ON j.employee_id = e.id
   WHERE COALESCE(e.store_id, p_store_id) = p_store_id AND e.status = 'active'
   ORDER BY 2;
END $$;

GRANT EXECUTE ON FUNCTION public.myhr_my_availability_profile(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_save_my_availability_profile(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_schedule_staff(uuid) TO authenticated;
