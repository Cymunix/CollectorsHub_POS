-- MyHR, part 6 (run after myhr_leave_accounts.sql): Record Working Times.
-- A weekly timesheet per employee. The app builds each week automatically
-- (attendance from clock in/out, overtime over 7 hours a day, approved paid
-- leave, planned hours from the schedule); the employee's edits are kept as
-- overrides on top. "Save and send" freezes the lines and sends the week for
-- approval; a manager approves or rejects it.

CREATE TABLE IF NOT EXISTS public.store_timesheet_weeks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES public.store_employees(id) ON DELETE CASCADE,
  week_start      date NOT NULL,                       -- the Sunday
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  overrides       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { cells: {row: {date: hours}}, extraRows: [...], hiddenRows: [...] }
  submitted_lines jsonb,                               -- [{ row, label, days: {date: hours}, total }]
  total_hours     numeric(7,2),
  overtime_hours  numeric(7,2),
  submitted_at    timestamptz,
  decided_by      uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  decision_note   text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, week_start)
);
CREATE INDEX IF NOT EXISTS store_timesheet_weeks_store_idx ON public.store_timesheet_weeks(store_id, status, week_start);
ALTER TABLE public.store_timesheet_weeks ENABLE ROW LEVEL SECURITY;

-- My weeks in a date range (for the calendar and the timesheet).
CREATE OR REPLACE FUNCTION public.myhr_my_timesheets(p_store_id uuid, p_from date, p_to date)
RETURNS TABLE (id uuid, week_start date, status text, overrides jsonb, submitted_lines jsonb, total_hours numeric, overtime_hours numeric,
               submitted_at timestamptz, decided_at timestamptz, decision_note text, processor text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.id, w.week_start, w.status, w.overrides, w.submitted_lines, w.total_hours, w.overtime_hours,
         w.submitted_at, w.decided_at, w.decision_note,
         COALESCE(NULLIF(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.username)
    FROM public.store_timesheet_weeks w
    LEFT JOIN public.store_employees p ON p.id = w.decided_by
   WHERE w.employee_id = public.myhr_employee_id(p_store_id)
     AND w.week_start BETWEEN p_from AND p_to
   ORDER BY w.week_start
$$;

-- Save my week (edits only), or save and send it for approval.
CREATE OR REPLACE FUNCTION public.myhr_save_timesheet(
  p_store_id uuid, p_week_start date, p_overrides jsonb, p_lines jsonb, p_total numeric, p_overtime numeric, p_submit boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp uuid := public.myhr_employee_id(p_store_id);
  v_status text;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'You are not an active employee of this store.'; END IF;
  IF extract(dow FROM p_week_start) <> 0 THEN RAISE EXCEPTION 'A timesheet week starts on a Sunday.'; END IF;
  SELECT w.status INTO v_status FROM public.store_timesheet_weeks w WHERE w.employee_id = v_emp AND w.week_start = p_week_start;
  IF v_status = 'approved' THEN RAISE EXCEPTION 'This week is already approved and can''t be changed.'; END IF;

  INSERT INTO public.store_timesheet_weeks (store_id, employee_id, week_start) VALUES (p_store_id, v_emp, p_week_start)
  ON CONFLICT (employee_id, week_start) DO NOTHING;
  UPDATE public.store_timesheet_weeks SET
    overrides       = COALESCE(p_overrides, '{}'::jsonb),
    status          = CASE WHEN p_submit THEN 'submitted' WHEN status = 'rejected' THEN 'draft' ELSE status END,
    submitted_lines = CASE WHEN p_submit THEN p_lines ELSE submitted_lines END,
    total_hours     = CASE WHEN p_submit THEN p_total ELSE total_hours END,
    overtime_hours  = CASE WHEN p_submit THEN p_overtime ELSE overtime_hours END,
    submitted_at    = CASE WHEN p_submit THEN now() ELSE submitted_at END,
    decided_by      = CASE WHEN p_submit THEN NULL ELSE decided_by END,
    decided_at      = CASE WHEN p_submit THEN NULL ELSE decided_at END,
    decision_note   = CASE WHEN p_submit THEN NULL ELSE decision_note END,
    updated_at      = now()
  WHERE employee_id = v_emp AND week_start = p_week_start
  RETURNING status INTO v_status;
  RETURN v_status;
END $$;

-- Managers: weeks waiting for approval (and recently decided).
CREATE OR REPLACE FUNCTION public.myhr_store_timesheets(p_store_id uuid)
RETURNS TABLE (id uuid, employee_name text, week_start date, status text, submitted_lines jsonb, total_hours numeric, overtime_hours numeric, submitted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can see the store''s timesheets.'; END IF;
  RETURN QUERY
  SELECT w.id,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Employee'),
         w.week_start, w.status, w.submitted_lines, w.total_hours, w.overtime_hours, w.submitted_at
    FROM public.store_timesheet_weeks w
    JOIN public.store_employees e ON e.id = w.employee_id
   WHERE w.store_id = p_store_id AND w.status = 'submitted'
   ORDER BY w.week_start, 2;
END $$;

-- Managers: approve or reject a submitted week.
CREATE OR REPLACE FUNCTION public.myhr_decide_timesheet(p_store_id uuid, p_week_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can approve timesheets.'; END IF;
  UPDATE public.store_timesheet_weeks
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decided_by = public.myhr_employee_id(p_store_id),
         decided_at = now(),
         decision_note = NULLIF(btrim(p_note), ''),
         updated_at = now()
   WHERE id = p_week_id AND store_id = p_store_id AND status = 'submitted';
  IF NOT FOUND THEN RAISE EXCEPTION 'That timesheet is no longer waiting for approval.'; END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.myhr_my_timesheets(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_save_timesheet(uuid, date, jsonb, jsonb, numeric, numeric, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_store_timesheets(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.myhr_decide_timesheet(uuid, uuid, boolean, text) TO authenticated;
