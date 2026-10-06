-- MyHR, part 4 (run after myhr_personal_data.sql): Job Information.
-- Each employee's job and pay (group, subgroup, position, pay type and rate,
-- hours per pay period, next increase), set by the store's managers/owner and
-- read-only for the employee. Who changed it and when is recorded.

CREATE TABLE IF NOT EXISTS public.store_employee_jobs (
  employee_id       uuid PRIMARY KEY REFERENCES public.store_employees(id) ON DELETE CASCADE,
  employee_group    text,            -- Employee, Contractor, Student, Seasonal
  employee_subgroup text,            -- Full-time hourly, Part-time hourly, Salaried, …
  position_title    text,            -- e.g. Sales Associate, Card Grader, Store Manager
  pay_type          text CHECK (pay_type IS NULL OR pay_type IN ('hourly','salary')),
  pay_rate          numeric(12,2) CHECK (pay_rate IS NULL OR pay_rate >= 0), -- per hour, or per year for salary
  hours_per_period  numeric(6,2) CHECK (hours_per_period IS NULL OR hours_per_period >= 0),
  pay_period        text CHECK (pay_period IS NULL OR pay_period IN ('weekly','biweekly','semimonthly','monthly')),
  next_increase     date,
  changed_by        uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  changed_by_name   text,
  changed_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.store_employee_jobs ENABLE ROW LEVEL SECURITY;

-- Job information for one employee (internal).
CREATE OR REPLACE FUNCTION public.myhr_job_row(p_store_id uuid, p_employee_id uuid)
RETURNS TABLE (
  employee_id uuid, personnel_number text, name text, personnel_area text, business_area text,
  employee_group text, employee_subgroup text, position_title text,
  pay_type text, pay_rate numeric, hours_per_period numeric, pay_period text, next_increase date,
  changed_by_name text, changed_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.personnel_number,
         COALESCE(NULLIF(btrim(concat_ws(' ', d.form_of_address, e.first_name, e.last_name)), ''), e.username),
         COALESCE(o.name, st.store_name),
         (SELECT l.location_name FROM public.store_locations l WHERE l.store_id = p_store_id ORDER BY l.created_at LIMIT 1),
         j.employee_group, j.employee_subgroup, j.position_title,
         j.pay_type, j.pay_rate, j.hours_per_period, j.pay_period, j.next_increase,
         j.changed_by_name, j.changed_at
    FROM public.store_employees e
    LEFT JOIN public.store_employee_details d ON d.employee_id = e.id
    LEFT JOIN public.store_employee_jobs j ON j.employee_id = e.id
    LEFT JOIN public.stores st ON st.id = p_store_id
    LEFT JOIN public.organizations o ON o.id = st.organization_id
   WHERE e.id = p_employee_id
$$;
REVOKE ALL ON FUNCTION public.myhr_job_row(uuid, uuid) FROM PUBLIC;

-- My job information.
DROP FUNCTION IF EXISTS public.myhr_my_job(uuid);
CREATE FUNCTION public.myhr_my_job(p_store_id uuid)
RETURNS TABLE (
  employee_id uuid, personnel_number text, name text, personnel_area text, business_area text,
  employee_group text, employee_subgroup text, position_title text,
  pay_type text, pay_rate numeric, hours_per_period numeric, pay_period text, next_increase date,
  changed_by_name text, changed_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.myhr_job_row(p_store_id, public.myhr_employee_id(p_store_id))
   WHERE public.myhr_employee_id(p_store_id) IS NOT NULL
$$;

-- Managers: one staff member's job information.
CREATE OR REPLACE FUNCTION public.myhr_staff_job(p_store_id uuid, p_employee_id uuid)
RETURNS TABLE (
  employee_id uuid, personnel_number text, name text, personnel_area text, business_area text,
  employee_group text, employee_subgroup text, position_title text,
  pay_type text, pay_rate numeric, hours_per_period numeric, pay_period text, next_increase date,
  changed_by_name text, changed_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see staff job information.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_employees e WHERE e.id = p_employee_id AND COALESCE(e.store_id, p_store_id) = p_store_id) THEN
    RAISE EXCEPTION 'That employee isn''t at this store.';
  END IF;
  RETURN QUERY SELECT * FROM public.myhr_job_row(p_store_id, p_employee_id);
END $$;

-- Managers: set one staff member's job information (only the keys given change).
CREATE OR REPLACE FUNCTION public.myhr_save_staff_job(p_store_id uuid, p_employee_id uuid, p_job jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := public.myhr_employee_id(p_store_id);
  v_me_name text;
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can change job information.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_employees e WHERE e.id = p_employee_id AND COALESCE(e.store_id, p_store_id) = p_store_id) THEN
    RAISE EXCEPTION 'That employee isn''t at this store.';
  END IF;
  SELECT COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username) INTO v_me_name
    FROM public.store_employees e WHERE e.id = v_me;

  INSERT INTO public.store_employee_jobs (employee_id) VALUES (p_employee_id) ON CONFLICT (employee_id) DO NOTHING;
  UPDATE public.store_employee_jobs SET
    employee_group    = CASE WHEN p_job ? 'employee_group' THEN NULLIF(btrim(p_job->>'employee_group'), '') ELSE employee_group END,
    employee_subgroup = CASE WHEN p_job ? 'employee_subgroup' THEN NULLIF(btrim(p_job->>'employee_subgroup'), '') ELSE employee_subgroup END,
    position_title    = CASE WHEN p_job ? 'position_title' THEN NULLIF(btrim(p_job->>'position_title'), '') ELSE position_title END,
    pay_type          = CASE WHEN p_job ? 'pay_type' THEN NULLIF(btrim(p_job->>'pay_type'), '') ELSE pay_type END,
    pay_rate          = CASE WHEN p_job ? 'pay_rate' THEN NULLIF(p_job->>'pay_rate', '')::numeric ELSE pay_rate END,
    hours_per_period  = CASE WHEN p_job ? 'hours_per_period' THEN NULLIF(p_job->>'hours_per_period', '')::numeric ELSE hours_per_period END,
    pay_period        = CASE WHEN p_job ? 'pay_period' THEN NULLIF(btrim(p_job->>'pay_period'), '') ELSE pay_period END,
    next_increase     = CASE WHEN p_job ? 'next_increase' THEN NULLIF(p_job->>'next_increase', '')::date ELSE next_increase END,
    changed_by        = v_me,
    changed_by_name   = COALESCE(v_me_name, 'Store owner'),
    changed_at        = now()
  WHERE employee_id = p_employee_id;
END $$;

GRANT EXECUTE ON FUNCTION public.myhr_my_job(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_staff_job(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_save_staff_job(uuid, uuid, jsonb) TO authenticated;
