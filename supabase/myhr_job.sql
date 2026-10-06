-- MyHR, part 4 (run after myhr_personal_data.sql): Job Information.
-- Each employee's job and pay (group, subgroup, position, pay type and rate,
-- hours per pay period, next increase), set by the ORGANIZATION (its owner) and
-- read-only for stores and staff. Who changed it and when is recorded.

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

-- ── The organization edits employees (not the store) ────────────────────────
-- Only the organization's owner changes an employee's job and pay. Store
-- managers and staff read it (staff: their own, through myhr_my_job).
DROP FUNCTION IF EXISTS public.myhr_staff_job(uuid, uuid);
DROP FUNCTION IF EXISTS public.myhr_save_staff_job(uuid, uuid, jsonb);

-- The org store an employee works at (their store, or the store of the owner
-- who added them when they cover all locations).
CREATE OR REPLACE FUNCTION public.myhr_org_employee_store(p_org_id uuid, p_employee_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id
    FROM public.store_employees e
    JOIN public.stores s ON s.organization_id = p_org_id
     AND (e.store_id = s.id OR (e.store_id IS NULL AND e.store_owner_id = s.owner_user_id))
   WHERE e.id = p_employee_id
   ORDER BY (e.store_id = s.id) DESC NULLS LAST, s.created_at
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.myhr_org_employee_store(uuid, uuid) FROM PUBLIC;

-- Org owner: every employee across the organization's stores.
CREATE OR REPLACE FUNCTION public.myhr_org_staff(p_org_id uuid)
RETURNS TABLE (id uuid, name text, role text, status text, personnel_number text, store_name text, position_title text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can manage employees.';
  END IF;
  RETURN QUERY
  SELECT DISTINCT ON (e.id)
         e.id,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'),
         e.role, e.status, e.personnel_number, s.store_name, j.position_title
    FROM public.store_employees e
    JOIN public.stores s ON s.organization_id = p_org_id
     AND (e.store_id = s.id OR (e.store_id IS NULL AND e.store_owner_id = s.owner_user_id))
    LEFT JOIN public.store_employee_jobs j ON j.employee_id = e.id
   ORDER BY e.id, (e.store_id = s.id) DESC NULLS LAST;
END $$;

-- Org owner: one employee's job information.
CREATE OR REPLACE FUNCTION public.myhr_org_staff_job(p_org_id uuid, p_employee_id uuid)
RETURNS TABLE (
  employee_id uuid, personnel_number text, name text, personnel_area text, business_area text,
  employee_group text, employee_subgroup text, position_title text,
  pay_type text, pay_rate numeric, hours_per_period numeric, pay_period text, next_increase date,
  changed_by_name text, changed_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid;
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can manage employees.';
  END IF;
  v_store := public.myhr_org_employee_store(p_org_id, p_employee_id);
  IF v_store IS NULL THEN RAISE EXCEPTION 'That employee isn''t in this organization.'; END IF;
  RETURN QUERY SELECT * FROM public.myhr_job_row(v_store, p_employee_id);
END $$;

-- Org owner: set one employee's job information (only the keys given change).
CREATE OR REPLACE FUNCTION public.myhr_org_save_staff_job(p_org_id uuid, p_employee_id uuid, p_job jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org_name text;
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can change job information.';
  END IF;
  IF public.myhr_org_employee_store(p_org_id, p_employee_id) IS NULL THEN
    RAISE EXCEPTION 'That employee isn''t in this organization.';
  END IF;
  SELECT o.name INTO v_org_name FROM public.organizations o WHERE o.id = p_org_id;

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
    changed_by        = NULL,
    changed_by_name   = COALESCE(v_org_name, 'Organization'),
    changed_at        = now()
  WHERE employee_id = p_employee_id;
END $$;

GRANT EXECUTE ON FUNCTION public.myhr_my_job(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_staff_job(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_save_staff_job(uuid, uuid, jsonb) TO authenticated;
