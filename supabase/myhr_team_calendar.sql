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
   WHERE COALESCE(e.store_id, p_store_id) = p_store_id AND e.status = 'active';
END $$;

-- Absences in a date range: everyone's dates and status; the leave type only
-- for my own.
CREATE OR REPLACE FUNCTION public.myhr_team_absences(p_store_id uuid, p_from date, p_to date)
RETURNS TABLE (employee_id uuid, start_date date, end_date date, status text, leave_type text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_me uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF v_me IS NULL AND NOT public.myhr_is_manager(p_store_id) THEN
    RAISE EXCEPTION 'You are not an active employee of this store.';
  END IF;
  RETURN QUERY
  SELECT r.employee_id, r.start_date, r.end_date, r.status,
         CASE WHEN r.employee_id = v_me THEN r.leave_type ELSE NULL END
    FROM public.store_leave_requests r
   WHERE r.store_id = p_store_id
     AND r.status IN ('pending','approved')
     AND r.start_date <= p_to AND r.end_date >= p_from;
END $$;

-- Scheduled days in a date range (days without one show as non-working).
CREATE OR REPLACE FUNCTION public.myhr_team_shift_days(p_store_id uuid, p_from date, p_to date)
RETURNS TABLE (employee_id uuid, day date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.myhr_employee_id(p_store_id) IS NULL AND NOT public.myhr_is_manager(p_store_id) THEN
    RAISE EXCEPTION 'You are not an active employee of this store.';
  END IF;
  RETURN QUERY
  SELECT DISTINCT s.employee_id, (s.starts_at AT TIME ZONE 'America/Halifax')::date
    FROM public.store_shifts s
   WHERE s.store_id = p_store_id
     AND s.starts_at < (p_to + 1)::timestamp AT TIME ZONE 'America/Halifax'
     AND s.ends_at > p_from::timestamp AT TIME ZONE 'America/Halifax';
END $$;

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
   WHERE COALESCE(e.store_id, p_store_id) = p_store_id AND e.status = 'active'
     AND lower(e.role) IN ('owner','manager','store_manager','assistant_manager')
   ORDER BY (lower(e.role) = 'owner') DESC, 1;
END $$;

GRANT EXECUTE ON FUNCTION public.myhr_team_members(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_team_absences(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_team_shift_days(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_store_approvers(uuid) TO authenticated;
