-- MyHR, part 8 (run after myhr_team_calendar.sql): the Schedule Builder.
--   * Scheduling profile per employee: scheduling role, which other roles they
--     can cover (e.g. a Supervisor who can cover Keyholder), target/min/max
--     weekly hours (set by the ORGANIZATION), and availability (set by the
--     employee).
--   * Coverage needs per store: e.g. Saturday 9:00–17:00 needs 1 Manager and
--     2 Employees (set by the store's managers).
--   * Shifts get a role and an unpaid break.
--   * Draft → publish: managers edit the draft; staff see the published week
--     only. Republishing marks what changed.

-- ── Scheduling profiles ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_employee_schedule_profiles (
  employee_id   uuid PRIMARY KEY REFERENCES public.store_employees(id) ON DELETE CASCADE,
  schedule_role text NOT NULL DEFAULT 'Employee',
  can_cover     text[] NOT NULL DEFAULT '{}',
  target_hours  numeric(5,2),
  min_hours     numeric(5,2),
  max_hours     numeric(5,2),
  availability  jsonb NOT NULL DEFAULT '{}'::jsonb, -- { "1": [{"from":"09:00","to":"17:00"}], … } by weekday (0 = Sunday); a day missing = available all day; [] = unavailable
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.store_employee_schedule_profiles ENABLE ROW LEVEL SECURITY;

-- Org owner: set an employee's scheduling role, cover roles and hour targets.
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
    schedule_role = CASE WHEN p_profile ? 'schedule_role' THEN COALESCE(NULLIF(btrim(p_profile->>'schedule_role'), ''), 'Employee') ELSE schedule_role END,
    can_cover     = CASE WHEN p_profile ? 'can_cover' THEN COALESCE(ARRAY(SELECT btrim(x) FROM jsonb_array_elements_text(p_profile->'can_cover') x WHERE btrim(x) <> ''), '{}') ELSE can_cover END,
    target_hours  = CASE WHEN p_profile ? 'target_hours' THEN NULLIF(p_profile->>'target_hours', '')::numeric ELSE target_hours END,
    min_hours     = CASE WHEN p_profile ? 'min_hours' THEN NULLIF(p_profile->>'min_hours', '')::numeric ELSE min_hours END,
    max_hours     = CASE WHEN p_profile ? 'max_hours' THEN NULLIF(p_profile->>'max_hours', '')::numeric ELSE max_hours END,
    updated_at    = now()
  WHERE employee_id = p_employee_id;
END $$;

CREATE OR REPLACE FUNCTION public.myhr_org_schedule_profile(p_org_id uuid, p_employee_id uuid)
RETURNS TABLE (schedule_role text, can_cover text[], target_hours numeric, min_hours numeric, max_hours numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can see scheduling settings.';
  END IF;
  RETURN QUERY
  SELECT COALESCE(p.schedule_role, 'Employee'), COALESCE(p.can_cover, '{}'), p.target_hours, p.min_hours, p.max_hours
    FROM (SELECT p_employee_id AS id) e
    LEFT JOIN public.store_employee_schedule_profiles p ON p.employee_id = e.id;
END $$;

-- Employee: my availability.
CREATE OR REPLACE FUNCTION public.myhr_my_availability(p_store_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT p.availability FROM public.store_employee_schedule_profiles p
                    WHERE p.employee_id = public.myhr_employee_id(p_store_id)), '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.myhr_save_my_availability(p_store_id uuid, p_availability jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;
  INSERT INTO public.store_employee_schedule_profiles (employee_id, availability) VALUES (v_emp, COALESCE(p_availability, '{}'::jsonb))
  ON CONFLICT (employee_id) DO UPDATE SET availability = EXCLUDED.availability, updated_at = now();
END $$;

-- Managers: staff with their scheduling profile and an hourly cost (for the
-- labour total; salaried staff are counted at salary / 2080 hours).
CREATE OR REPLACE FUNCTION public.myhr_schedule_staff(p_store_id uuid)
RETURNS TABLE (id uuid, name text, short_name text, schedule_role text, can_cover text[], target_hours numeric, min_hours numeric, max_hours numeric, availability jsonb, hourly_cost numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can build the schedule.'; END IF;
  RETURN QUERY
  SELECT e.id,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'),
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, CASE WHEN e.last_name IS NOT NULL AND e.last_name <> '' THEN left(e.last_name, 1) || '.' END)), ''), e.username, 'Employee'),
         COALESCE(p.schedule_role, 'Employee'), COALESCE(p.can_cover, '{}'), p.target_hours, p.min_hours, p.max_hours,
         COALESCE(p.availability, '{}'::jsonb),
         CASE WHEN j.pay_type = 'salary' THEN round(j.pay_rate / 2080, 2) ELSE j.pay_rate END
    FROM public.store_employees e
    LEFT JOIN public.store_employee_schedule_profiles p ON p.employee_id = e.id
    LEFT JOIN public.store_employee_jobs j ON j.employee_id = e.id
   WHERE COALESCE(e.store_id, p_store_id) = p_store_id AND e.status = 'active'
   ORDER BY 2;
END $$;

-- ── Coverage needs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_coverage_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  weekday    integer NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
  start_time time NOT NULL,
  end_time   time NOT NULL,
  role       text NOT NULL DEFAULT 'Employee',  -- 'Employee' = anyone
  needed     integer NOT NULL DEFAULT 1 CHECK (needed BETWEEN 1 AND 50),
  label      text,                              -- e.g. 'Closing'
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_coverage_rules_order CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS store_coverage_rules_store_idx ON public.store_coverage_rules(store_id, weekday);
ALTER TABLE public.store_coverage_rules ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.myhr_coverage_rules(p_store_id uuid)
RETURNS TABLE (id uuid, weekday integer, start_time time, end_time time, role text, needed integer, label text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see coverage needs.'; END IF;
  RETURN QUERY SELECT r.id, r.weekday, r.start_time, r.end_time, r.role, r.needed, r.label
    FROM public.store_coverage_rules r WHERE r.store_id = p_store_id ORDER BY r.weekday, r.start_time, r.role;
END $$;

CREATE OR REPLACE FUNCTION public.myhr_save_coverage_rule(p_store_id uuid, p_id uuid, p_weekday integer, p_start time, p_end time, p_role text, p_needed integer, p_label text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can change coverage needs.'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.store_coverage_rules (store_id, weekday, start_time, end_time, role, needed, label)
    VALUES (p_store_id, p_weekday, p_start, p_end, COALESCE(NULLIF(btrim(p_role), ''), 'Employee'), GREATEST(COALESCE(p_needed, 1), 1), NULLIF(btrim(p_label), ''))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.store_coverage_rules
       SET weekday = p_weekday, start_time = p_start, end_time = p_end, role = COALESCE(NULLIF(btrim(p_role), ''), 'Employee'),
           needed = GREATEST(COALESCE(p_needed, 1), 1), label = NULLIF(btrim(p_label), '')
     WHERE id = p_id AND store_id = p_store_id
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.myhr_delete_coverage_rule(p_store_id uuid, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can change coverage needs.'; END IF;
  DELETE FROM public.store_coverage_rules WHERE id = p_id AND store_id = p_store_id;
END $$;

-- ── Shifts: role and break; editing ─────────────────────────────────────────
ALTER TABLE public.store_shifts
  ADD COLUMN IF NOT EXISTS role          text,
  ADD COLUMN IF NOT EXISTS break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 240);

DROP FUNCTION IF EXISTS public.myhr_store_schedule(uuid, timestamptz, timestamptz);
CREATE FUNCTION public.myhr_store_schedule(p_store_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (id uuid, employee_id uuid, employee_name text, starts_at timestamptz, ends_at timestamptz, note text, role text, break_minutes integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see the store schedule.'; END IF;
  RETURN QUERY
  SELECT s.id, s.employee_id,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'),
         s.starts_at, s.ends_at, s.note, s.role, s.break_minutes
    FROM public.store_shifts s
    JOIN public.store_employees e ON e.id = s.employee_id
   WHERE s.store_id = p_store_id AND s.starts_at < p_to AND s.ends_at > p_from
   ORDER BY s.starts_at, 3;
END $$;

DROP FUNCTION IF EXISTS public.myhr_add_shift(uuid, uuid, timestamptz, timestamptz, text);
CREATE OR REPLACE FUNCTION public.myhr_save_shift(
  p_store_id uuid, p_shift_id uuid, p_employee_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_role text, p_break_minutes integer, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can schedule shifts.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_employees e WHERE e.id = p_employee_id AND COALESCE(e.store_id, p_store_id) = p_store_id AND e.status = 'active') THEN
    RAISE EXCEPTION 'That employee isn''t active at this store.';
  END IF;
  IF p_ends_at <= p_starts_at THEN RAISE EXCEPTION 'A shift has to end after it starts.'; END IF;
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

-- ── Draft → publish ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_schedule_weeks (
  store_id     uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  week_start   date NOT NULL, -- the Monday
  version      integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  published_by uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  shifts       jsonb NOT NULL DEFAULT '[]'::jsonb, -- the published shifts, each with "changed" when it changed since the last publish
  PRIMARY KEY (store_id, week_start)
);
ALTER TABLE public.store_schedule_weeks ENABLE ROW LEVEL SECURITY;

-- Managers: the published version of a week.
CREATE OR REPLACE FUNCTION public.myhr_schedule_week(p_store_id uuid, p_week_start date)
RETURNS TABLE (version integer, published_at timestamptz, shifts jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see schedule drafts.'; END IF;
  RETURN QUERY SELECT w.version, w.published_at, w.shifts FROM public.store_schedule_weeks w
   WHERE w.store_id = p_store_id AND w.week_start = p_week_start;
END $$;

-- Managers: publish the draft of a week (Monday to Sunday) to staff.
CREATE OR REPLACE FUNCTION public.myhr_publish_schedule(p_store_id uuid, p_week_start date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev jsonb;
  v_prev_version integer;
  v_new jsonb;
  v_version integer;
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can publish the schedule.'; END IF;
  IF extract(isodow FROM p_week_start) <> 1 THEN RAISE EXCEPTION 'A schedule week starts on a Monday.'; END IF;
  SELECT w.shifts, w.version INTO v_prev, v_prev_version FROM public.store_schedule_weeks w WHERE w.store_id = p_store_id AND w.week_start = p_week_start;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id, 'employee_id', s.employee_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
           'role', s.role, 'break_minutes', s.break_minutes, 'note', s.note,
           -- Changed: anything different from the last published version (new shifts too).
           'changed', v_prev IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(v_prev) p
              WHERE p->>'id' = s.id::text AND p->>'employee_id' = s.employee_id::text
                AND (p->>'starts_at')::timestamptz = s.starts_at AND (p->>'ends_at')::timestamptz = s.ends_at
                AND COALESCE(p->>'role', '') = COALESCE(s.role, '') AND COALESCE((p->>'break_minutes')::int, 0) = s.break_minutes)
         ) ORDER BY s.starts_at), '[]'::jsonb)
    INTO v_new
    FROM public.store_shifts s
   WHERE s.store_id = p_store_id
     AND s.starts_at >= (p_week_start::timestamp AT TIME ZONE 'America/Halifax')
     AND s.starts_at < ((p_week_start + 7)::timestamp AT TIME ZONE 'America/Halifax');

  v_version := COALESCE(v_prev_version, 0) + 1;
  INSERT INTO public.store_schedule_weeks (store_id, week_start, version, published_at, published_by, shifts)
  VALUES (p_store_id, p_week_start, v_version, now(), public.myhr_employee_id(p_store_id), v_new)
  ON CONFLICT (store_id, week_start) DO UPDATE
    SET version = EXCLUDED.version, published_at = EXCLUDED.published_at, published_by = EXCLUDED.published_by, shifts = EXCLUDED.shifts;
  RETURN v_version;
END $$;

-- Staff see published shifts only (replaces part 2's version, which read the
-- draft). Includes role, break and whether it changed at the last publish.
DROP FUNCTION IF EXISTS public.myhr_my_schedule(uuid, timestamptz, timestamptz);
CREATE FUNCTION public.myhr_my_schedule(p_store_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (id uuid, starts_at timestamptz, ends_at timestamptz, note text, role text, break_minutes integer, changed boolean, published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (x->>'id')::uuid, (x->>'starts_at')::timestamptz, (x->>'ends_at')::timestamptz, x->>'note', x->>'role',
         COALESCE((x->>'break_minutes')::int, 0), COALESCE((x->>'changed')::boolean, false), w.published_at
    FROM public.store_schedule_weeks w, jsonb_array_elements(w.shifts) x
   WHERE w.store_id = p_store_id
     AND (x->>'employee_id')::uuid = public.myhr_employee_id(p_store_id)
     AND (x->>'starts_at')::timestamptz < p_to AND (x->>'ends_at')::timestamptz > p_from
   ORDER BY 2
$$;

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

GRANT EXECUTE ON FUNCTION public.myhr_org_save_schedule_profile(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_schedule_profile(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_my_availability(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_save_my_availability(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_schedule_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_coverage_rules(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_save_coverage_rule(uuid, uuid, integer, time, time, text, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_delete_coverage_rule(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_store_schedule(uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_save_shift(uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_schedule_week(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_publish_schedule(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_my_schedule(uuid, timestamptz, timestamptz) TO authenticated;
