-- MyHR "My Pay, Vacation & Leaves": staff time clock and leave requests.
--   store_time_entries   one row per shift: clock in, clock out
--   store_leave_requests vacation / sick / personal / unpaid / other requests,
--                        approved or declined by the store's managers/owner
-- Everything goes through the functions below, which work out who the
-- signed-in employee is (never trusted from the app) and check roles.

CREATE TABLE IF NOT EXISTS public.store_time_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.store_employees(id) ON DELETE CASCADE,
  clock_in    timestamptz NOT NULL DEFAULT now(),
  clock_out   timestamptz,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_time_entries_order CHECK (clock_out IS NULL OR clock_out >= clock_in)
);
CREATE INDEX IF NOT EXISTS store_time_entries_employee_idx ON public.store_time_entries(employee_id, clock_in DESC);
CREATE INDEX IF NOT EXISTS store_time_entries_store_idx ON public.store_time_entries(store_id, clock_in DESC);
-- One open shift per employee.
CREATE UNIQUE INDEX IF NOT EXISTS store_time_entries_one_open ON public.store_time_entries(employee_id) WHERE clock_out IS NULL;

CREATE TABLE IF NOT EXISTS public.store_leave_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES public.store_employees(id) ON DELETE CASCADE,
  leave_type    text NOT NULL CHECK (leave_type IN ('vacation','sick','personal','unpaid','other')),
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  days          numeric(5,1) NOT NULL CHECK (days > 0),
  note          text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','cancelled')),
  decided_by    uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_leave_requests_dates CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS store_leave_requests_employee_idx ON public.store_leave_requests(employee_id, start_date DESC);
CREATE INDEX IF NOT EXISTS store_leave_requests_store_idx ON public.store_leave_requests(store_id, status, start_date);

-- No direct table access: only the functions below.
ALTER TABLE public.store_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_leave_requests ENABLE ROW LEVEL SECURITY;

-- The signed-in employee at a store.
CREATE OR REPLACE FUNCTION public.myhr_employee_id(p_store_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id FROM public.store_employees e
   WHERE COALESCE(e.store_id, p_store_id) = p_store_id
     AND (e.employee_user_id = auth.uid() OR e.auth_user_id = auth.uid())
     AND e.status = 'active'
   ORDER BY e.created_at
   LIMIT 1
$$;

-- Managers: the store's owner, or an employee with the owner/manager role.
CREATE OR REPLACE FUNCTION public.myhr_is_manager(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND s.owner_user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.store_employees e
                  WHERE e.id = public.myhr_employee_id(p_store_id)
                    AND lower(e.role) IN ('owner','manager','store_manager','assistant_manager'))
$$;

-- Clock in / out. Returns the open shift's clock-in time, or null after clocking out.
CREATE OR REPLACE FUNCTION public.myhr_clock(p_store_id uuid, p_action text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id); v_in timestamptz;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;
  IF p_action = 'in' THEN
    IF EXISTS (SELECT 1 FROM public.store_time_entries WHERE employee_id = v_emp AND clock_out IS NULL) THEN
      RAISE EXCEPTION 'You are already clocked in.';
    END IF;
    INSERT INTO public.store_time_entries (store_id, employee_id) VALUES (p_store_id, v_emp) RETURNING clock_in INTO v_in;
    RETURN v_in;
  ELSIF p_action = 'out' THEN
    UPDATE public.store_time_entries SET clock_out = now()
     WHERE employee_id = v_emp AND clock_out IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'You are not clocked in.'; END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'Unknown clock action %', p_action;
END $$;

-- My shifts since a date (newest first).
CREATE OR REPLACE FUNCTION public.myhr_my_time(p_store_id uuid, p_since date)
RETURNS TABLE (id uuid, clock_in timestamptz, clock_out timestamptz, note text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.clock_in, t.clock_out, t.note FROM public.store_time_entries t
   WHERE t.employee_id = public.myhr_employee_id(p_store_id)
     AND t.clock_in >= p_since
   ORDER BY t.clock_in DESC
   LIMIT 200
$$;

-- Request leave.
CREATE OR REPLACE FUNCTION public.myhr_request_leave(p_store_id uuid, p_type text, p_start date, p_end date, p_days numeric, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id); v_id uuid;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;
  INSERT INTO public.store_leave_requests (store_id, employee_id, leave_type, start_date, end_date, days, note)
  VALUES (p_store_id, v_emp, p_type, p_start, p_end, p_days, NULLIF(btrim(p_note), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- My leave requests (newest first).
CREATE OR REPLACE FUNCTION public.myhr_my_leave(p_store_id uuid)
RETURNS TABLE (id uuid, leave_type text, start_date date, end_date date, days numeric, note text, status text, decided_at timestamptz, decision_note text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.leave_type, r.start_date, r.end_date, r.days, r.note, r.status, r.decided_at, r.decision_note, r.created_at
    FROM public.store_leave_requests r
   WHERE r.employee_id = public.myhr_employee_id(p_store_id)
   ORDER BY r.start_date DESC
   LIMIT 200
$$;

-- Cancel one of my own requests (pending, or approved and not yet started).
CREATE OR REPLACE FUNCTION public.myhr_cancel_leave(p_store_id uuid, p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.store_leave_requests SET status = 'cancelled'
   WHERE id = p_request_id
     AND employee_id = public.myhr_employee_id(p_store_id)
     AND (status = 'pending' OR (status = 'approved' AND start_date > current_date));
  IF NOT FOUND THEN RAISE EXCEPTION 'That request can''t be cancelled.'; END IF;
END $$;

-- Managers: the store's leave requests (pending first, then upcoming).
CREATE OR REPLACE FUNCTION public.myhr_store_leave(p_store_id uuid)
RETURNS TABLE (id uuid, employee_name text, leave_type text, start_date date, end_date date, days numeric, note text, status text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see the store''s leave requests.'; END IF;
  RETURN QUERY
  SELECT r.id,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'),
         r.leave_type, r.start_date, r.end_date, r.days, r.note, r.status, r.created_at
    FROM public.store_leave_requests r
    JOIN public.store_employees e ON e.id = r.employee_id
   WHERE r.store_id = p_store_id
     AND (r.status = 'pending' OR (r.status = 'approved' AND r.end_date >= current_date - 30))
   ORDER BY (r.status = 'pending') DESC, r.start_date
   LIMIT 200;
END $$;

-- Managers: approve or decline a pending request.
CREATE OR REPLACE FUNCTION public.myhr_decide_leave(p_store_id uuid, p_request_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can approve leave.'; END IF;
  UPDATE public.store_leave_requests
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'declined' END,
         decided_by = public.myhr_employee_id(p_store_id),
         decided_at = now(),
         decision_note = NULLIF(btrim(p_note), '')
   WHERE id = p_request_id AND store_id = p_store_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'That request is no longer waiting for a decision.'; END IF;
END $$;

-- Am I a manager here? (shows the approvals list)
CREATE OR REPLACE FUNCTION public.myhr_am_manager(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.myhr_is_manager(p_store_id)
$$;

REVOKE ALL ON FUNCTION public.myhr_employee_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.myhr_is_manager(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.myhr_clock(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_my_time(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_request_leave(uuid, text, date, date, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_my_leave(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_cancel_leave(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_store_leave(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_decide_leave(uuid, uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_am_manager(uuid) TO authenticated;
