-- MyHR, part 5 (run after myhr_job.sql): Leave Overview.
--   * Leave is booked in hours, with start/end times, and more leave types.
--   * Time accounts: each employee's yearly entitlement per account (vacation,
--     sick, medical/dental, …), set by the ORGANIZATION; the remainder is the
--     entitlement minus approved leave in that leave year.
--   * The leave year starts in the month the organization chooses (default
--     January; e.g. April for an April–March year).

-- ── Leave requests: hours, times, more types ────────────────────────────────
ALTER TABLE public.store_leave_requests
  ADD COLUMN IF NOT EXISTS start_time time,
  ADD COLUMN IF NOT EXISTS end_time   time,
  ADD COLUMN IF NOT EXISTS hours      numeric(7,2);
UPDATE public.store_leave_requests SET hours = days * 8 WHERE hours IS NULL;

ALTER TABLE public.store_leave_requests DROP CONSTRAINT IF EXISTS store_leave_requests_leave_type_check;
ALTER TABLE public.store_leave_requests ADD CONSTRAINT store_leave_requests_leave_type_check CHECK (leave_type IN (
  'vacation','sick','medical','family_illness','lieu','statutory','personal','unpaid','other'));

-- Which time account each leave type uses (null: none).
CREATE OR REPLACE FUNCTION public.myhr_leave_account(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
    WHEN 'vacation' THEN 'vacation'
    WHEN 'sick' THEN 'sick'
    WHEN 'medical' THEN 'medical'
    WHEN 'family_illness' THEN 'family_illness'
    WHEN 'lieu' THEN 'banked_overtime'
    WHEN 'statutory' THEN 'statutory'
    ELSE NULL END
$$;

-- ── Leave year (per organization) ───────────────────────────────────────────
ALTER TABLE public.organization_myhr_settings
  ADD COLUMN IF NOT EXISTS leave_year_start_month integer NOT NULL DEFAULT 1
  CHECK (leave_year_start_month BETWEEN 1 AND 12);

CREATE OR REPLACE FUNCTION public.myhr_leave_year_start_month(p_store_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT m.leave_year_start_month
                     FROM public.stores s
                     JOIN public.organization_myhr_settings m ON m.organization_id = s.organization_id
                    WHERE s.id = p_store_id), 1)
$$;

-- The leave year containing a date: [start, end].
CREATE OR REPLACE FUNCTION public.myhr_leave_year(p_start_month integer, p_date date)
RETURNS TABLE (year_start date, year_end date) LANGUAGE sql IMMUTABLE AS $$
  SELECT s, (s + interval '1 year' - interval '1 day')::date
    FROM (SELECT make_date(CASE WHEN extract(month FROM p_date) >= p_start_month
                                THEN extract(year FROM p_date)::int
                                ELSE extract(year FROM p_date)::int - 1 END, p_start_month, 1) AS s) y
$$;

-- ── Time accounts: entitlements set by the organization ─────────────────────
CREATE TABLE IF NOT EXISTS public.store_leave_entitlements (
  employee_id       uuid NOT NULL REFERENCES public.store_employees(id) ON DELETE CASCADE,
  account           text NOT NULL CHECK (account IN (
                      'banked_overtime','vacation','carryover_vacation','accumulated_vacation',
                      'sick','medical','family_illness','statutory')),
  year_start        date NOT NULL,
  entitlement_hours numeric(7,2) NOT NULL DEFAULT 0 CHECK (entitlement_hours >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, account, year_start)
);
ALTER TABLE public.store_leave_entitlements ENABLE ROW LEVEL SECURITY;

-- One employee's accounts for the leave year containing p_key_date (internal).
-- Used = approved leave in that leave year. Vacation leave draws from
-- carryover first, then vacation, then accumulated; anything beyond that
-- shows as a negative vacation remainder.
CREATE OR REPLACE FUNCTION public.myhr_accounts(p_employee_id uuid, p_start_month integer, p_key_date date)
RETURNS TABLE (account text, year_start date, year_end date, entitlement_hours numeric, used_hours numeric, remainder_hours numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start date; v_end date;
  v_ent jsonb := '{}'::jsonb;
  v_used jsonb := '{}'::jsonb;
  v_left numeric; v_take numeric;
  v_acc text;
BEGIN
  SELECT y.year_start, y.year_end INTO v_start, v_end FROM public.myhr_leave_year(p_start_month, p_key_date) y;

  SELECT COALESCE(jsonb_object_agg(e.account, e.entitlement_hours), '{}'::jsonb) INTO v_ent
    FROM public.store_leave_entitlements e
   WHERE e.employee_id = p_employee_id AND e.year_start = v_start;

  SELECT COALESCE(jsonb_object_agg(t.acc, t.total), '{}'::jsonb) INTO v_used
    FROM (SELECT public.myhr_leave_account(r.leave_type) AS acc, sum(r.hours) AS total
            FROM public.store_leave_requests r
           WHERE r.employee_id = p_employee_id AND r.status = 'approved'
             AND r.start_date BETWEEN v_start AND v_end
             AND public.myhr_leave_account(r.leave_type) IS NOT NULL
           GROUP BY 1) t;

  -- Spread vacation over carryover, vacation, accumulated.
  v_left := COALESCE((v_used->>'vacation')::numeric, 0);
  v_used := v_used - 'vacation';
  FOREACH v_acc IN ARRAY ARRAY['carryover_vacation','vacation','accumulated_vacation'] LOOP
    v_take := LEAST(v_left, COALESCE((v_ent->>v_acc)::numeric, 0));
    v_used := jsonb_set(v_used, ARRAY[v_acc], to_jsonb(v_take));
    v_left := v_left - v_take;
  END LOOP;
  IF v_left > 0 THEN
    v_used := jsonb_set(v_used, ARRAY['vacation'], to_jsonb((v_used->>'vacation')::numeric + v_left));
  END IF;

  FOREACH v_acc IN ARRAY ARRAY['banked_overtime','vacation','carryover_vacation','accumulated_vacation','sick','medical','family_illness','statutory'] LOOP
    account := v_acc;
    year_start := v_start;
    year_end := v_end;
    entitlement_hours := COALESCE((v_ent->>v_acc)::numeric, 0);
    used_hours := COALESCE((v_used->>v_acc)::numeric, 0);
    remainder_hours := entitlement_hours - used_hours;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.myhr_accounts(uuid, integer, date) FROM PUBLIC;

-- My time accounts on a key date.
CREATE OR REPLACE FUNCTION public.myhr_my_time_accounts(p_store_id uuid, p_key_date date)
RETURNS TABLE (account text, year_start date, year_end date, entitlement_hours numeric, used_hours numeric, remainder_hours numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.myhr_accounts(public.myhr_employee_id(p_store_id), public.myhr_leave_year_start_month(p_store_id), p_key_date)
   WHERE public.myhr_employee_id(p_store_id) IS NOT NULL
$$;

-- ── Leave requests with hours and times ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.myhr_request_leave(uuid, text, date, date, numeric, text);
CREATE OR REPLACE FUNCTION public.myhr_request_leave(
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

-- Edit one of my requests while it's still waiting for approval.
CREATE OR REPLACE FUNCTION public.myhr_update_leave(
  p_store_id uuid, p_request_id uuid, p_type text, p_start date, p_end date, p_start_time time, p_end_time time, p_hours numeric, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter the absence hours.'; END IF;
  UPDATE public.store_leave_requests
     SET leave_type = p_type, start_date = p_start, end_date = p_end, start_time = p_start_time, end_time = p_end_time,
         hours = p_hours, days = GREATEST(round(p_hours / 8, 1), 0.1), note = NULLIF(btrim(p_note), '')
   WHERE id = p_request_id AND employee_id = public.myhr_employee_id(p_store_id) AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only requests waiting for approval can be edited.'; END IF;
END $$;

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

-- ── The organization: leave year and entitlements ──────────────────────────
CREATE OR REPLACE FUNCTION public.myhr_org_set_leave_year(p_org_id uuid, p_start_month integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can change the leave year.';
  END IF;
  INSERT INTO public.organization_myhr_settings (organization_id, leave_year_start_month)
  VALUES (p_org_id, p_start_month)
  ON CONFLICT (organization_id) DO UPDATE SET leave_year_start_month = EXCLUDED.leave_year_start_month, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.myhr_org_leave_year(p_org_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT m.leave_year_start_month FROM public.organization_myhr_settings m WHERE m.organization_id = p_org_id), 1)
   WHERE p_org_id IN (SELECT public.user_org_ids())
$$;

-- An employee's accounts (org owner).
CREATE OR REPLACE FUNCTION public.myhr_org_employee_accounts(p_org_id uuid, p_employee_id uuid, p_key_date date)
RETURNS TABLE (account text, year_start date, year_end date, entitlement_hours numeric, used_hours numeric, remainder_hours numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can see leave entitlements.';
  END IF;
  IF public.myhr_org_employee_store(p_org_id, p_employee_id) IS NULL THEN
    RAISE EXCEPTION 'That employee isn''t in this organization.';
  END IF;
  RETURN QUERY SELECT * FROM public.myhr_accounts(p_employee_id,
    COALESCE((SELECT m.leave_year_start_month FROM public.organization_myhr_settings m WHERE m.organization_id = p_org_id), 1), p_key_date);
END $$;

-- Set an employee's entitlement for one account in the leave year starting p_year_start (org owner).
CREATE OR REPLACE FUNCTION public.myhr_org_set_entitlement(p_org_id uuid, p_employee_id uuid, p_account text, p_year_start date, p_hours numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can set leave entitlements.';
  END IF;
  IF public.myhr_org_employee_store(p_org_id, p_employee_id) IS NULL THEN
    RAISE EXCEPTION 'That employee isn''t in this organization.';
  END IF;
  INSERT INTO public.store_leave_entitlements (employee_id, account, year_start, entitlement_hours, updated_at)
  VALUES (p_employee_id, p_account, p_year_start, GREATEST(COALESCE(p_hours, 0), 0), now())
  ON CONFLICT (employee_id, account, year_start) DO UPDATE SET entitlement_hours = EXCLUDED.entitlement_hours, updated_at = now();
END $$;

GRANT EXECUTE ON FUNCTION public.myhr_my_time_accounts(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_request_leave(uuid, text, date, date, time, time, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_update_leave(uuid, uuid, text, date, date, time, time, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_my_leave(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_store_leave(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_set_leave_year(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_leave_year(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_employee_accounts(uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_org_set_entitlement(uuid, uuid, text, date, numeric) TO authenticated;
