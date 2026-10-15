-- MyHR: Travel & Expenses (run after myhr_pay.sql and myhr_job.sql). Safe to run again.
--
-- Employees create travel requests and expense claims for their own organization.
-- Policy (mileage rate, limits, who may approve) is set by the organization only.
-- Approvals: the organization's owner, or a store manager for claims in their store
-- that are within the organization's manager approval limit (never their own).
-- Approval and payment are separate: an approved claim waits for reimbursement
-- until the organization records the payment with its reference.
-- Tables are reached only through the functions below (RLS on, no table grants).

-- ── Organization policy ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.org_travel_policies (
  organization_id        uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  currency               text NOT NULL DEFAULT 'CAD',
  mileage_enabled        boolean NOT NULL DEFAULT false,
  mileage_rate           numeric(8,4) CHECK (mileage_rate IS NULL OR mileage_rate >= 0),   -- per business km, set by the organization
  meal_daily_limit       numeric(10,2) CHECK (meal_daily_limit IS NULL OR meal_daily_limit >= 0),
  lodging_nightly_limit  numeric(10,2) CHECK (lodging_nightly_limit IS NULL OR lodging_nightly_limit >= 0),
  receipt_required_over  numeric(10,2) CHECK (receipt_required_over IS NULL OR receipt_required_over >= 0),
  manager_approval_limit numeric(12,2) CHECK (manager_approval_limit IS NULL OR manager_approval_limit >= 0), -- null: only the organization approves
  policy_notes           text,
  updated_by_name        text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.org_travel_policies ENABLE ROW LEVEL SECURITY;

CREATE SEQUENCE IF NOT EXISTS public.myhr_te_reference_seq;

-- ── Travel requests ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.myhr_travel_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE,
  organization_id  uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  store_id         uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES public.store_employees(id) ON DELETE CASCADE,
  department       text,
  work_location    text,
  destination      text,
  purpose          text,
  departure_date   date,
  return_date      date,
  transport        text,
  accommodation    text,
  notes            text,
  estimate_lines   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{category, description, amount}]
  estimated_total  numeric(12,2) NOT NULL DEFAULT 0,
  currency         text NOT NULL DEFAULT 'CAD',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_review','approved','rejected','returned','cancelled')),
  submitted_at     timestamptz,
  decided_by_name  text,
  decided_at       timestamptz,
  decision_note    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (return_date IS NULL OR departure_date IS NULL OR return_date >= departure_date)
);
CREATE INDEX IF NOT EXISTS myhr_travel_requests_emp_idx ON public.myhr_travel_requests(employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS myhr_travel_requests_org_idx ON public.myhr_travel_requests(organization_id, status);
ALTER TABLE public.myhr_travel_requests ENABLE ROW LEVEL SECURITY;

-- ── Expense claims and their lines ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.myhr_expense_claims (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL UNIQUE,
  organization_id    uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  store_id           uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  employee_id        uuid NOT NULL REFERENCES public.store_employees(id) ON DELETE CASCADE,
  travel_request_id  uuid REFERENCES public.myhr_travel_requests(id) ON DELETE SET NULL,
  description        text,
  currency           text NOT NULL DEFAULT 'CAD',
  submitted_total    numeric(12,2) NOT NULL DEFAULT 0,
  approved_total     numeric(12,2),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_review','approved','partially_approved','rejected','returned','cancelled')),
  payment_status     text NOT NULL DEFAULT 'not_due' CHECK (payment_status IN ('not_due','awaiting','paid')),
  submitted_at       timestamptz,
  decided_by_name    text,
  decided_at         timestamptz,
  decision_note      text,
  paid_on            date,
  payment_reference  text,
  paid_recorded_by   text,
  paid_recorded_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.myhr_expense_claims ADD COLUMN IF NOT EXISTS reimbursed_total numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.myhr_expense_claims DROP CONSTRAINT IF EXISTS myhr_expense_claims_payment_status_check;
ALTER TABLE public.myhr_expense_claims ADD CONSTRAINT myhr_expense_claims_payment_status_check CHECK (payment_status IN ('not_due','awaiting','partial','paid'));
CREATE INDEX IF NOT EXISTS myhr_expense_claims_emp_idx ON public.myhr_expense_claims(employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS myhr_expense_claims_org_idx ON public.myhr_expense_claims(organization_id, status, payment_status);
ALTER TABLE public.myhr_expense_claims ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.myhr_expense_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id         uuid NOT NULL REFERENCES public.myhr_expense_claims(id) ON DELETE CASCADE,
  line_no          int NOT NULL,
  kind             text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','mileage')),
  expense_date     date,
  category         text,
  description      text,
  business_purpose text,
  payment_method   text,
  amount           numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),  -- in the line's own currency
  currency         text NOT NULL DEFAULT 'CAD',
  exchange_rate    numeric(14,6),          -- to the claim currency, when the currencies differ
  rate_source      text,
  rate_date        date,
  amount_claim     numeric(12,2) NOT NULL DEFAULT 0,  -- in the claim currency
  tax_amount       numeric(12,2) CHECK (tax_amount IS NULL OR tax_amount >= 0),
  receipt_path     text,
  receipt_name     text,
  km               numeric(10,1) CHECK (km IS NULL OR km >= 0),
  from_place       text,
  to_place         text,
  mileage_rate     numeric(8,4),
  approved_amount  numeric(12,2),
  disallowed_note  text
);
CREATE INDEX IF NOT EXISTS myhr_expense_lines_claim_idx ON public.myhr_expense_lines(claim_id, line_no);
ALTER TABLE public.myhr_expense_lines ENABLE ROW LEVEL SECURITY;

-- Reimbursement payments (a claim can be paid in more than one payment).
CREATE TABLE IF NOT EXISTS public.myhr_expense_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id          uuid NOT NULL REFERENCES public.myhr_expense_claims(id) ON DELETE RESTRICT,
  paid_on           date NOT NULL,
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  method            text NOT NULL,
  reference         text NOT NULL,
  processed_by_name text NOT NULL,
  recorded_by_name  text,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_id, reference)
);
CREATE INDEX IF NOT EXISTS myhr_expense_payments_claim_idx ON public.myhr_expense_payments(claim_id, paid_on);
ALTER TABLE public.myhr_expense_payments ENABLE ROW LEVEL SECURITY;

-- Approval and payment history for both kinds of record.
CREATE TABLE IF NOT EXISTS public.myhr_te_history (
  id          bigserial PRIMARY KEY,
  record_kind text NOT NULL CHECK (record_kind IN ('travel','claim')),
  record_id   uuid NOT NULL,
  action      text NOT NULL,
  by_name     text,
  note        text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS myhr_te_history_idx ON public.myhr_te_history(record_kind, record_id, at);
ALTER TABLE public.myhr_te_history ENABLE ROW LEVEL SECURITY;

-- ── Helpers ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.te_store_org(p_store_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT organization_id FROM public.stores WHERE id = p_store_id
$$;
REVOKE ALL ON FUNCTION public.te_store_org(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.te_is_org_owner(p_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_org_id IS NOT NULL AND p_org_id IN (SELECT public.user_org_ids())
$$;
REVOKE ALL ON FUNCTION public.te_is_org_owner(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.te_employee_name(p_employee_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(btrim(concat_ws(' ', first_name, last_name)), ''), username, 'Employee') FROM public.store_employees WHERE id = p_employee_id
$$;
REVOKE ALL ON FUNCTION public.te_employee_name(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.te_next_reference(p_prefix text)
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_prefix || '-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.myhr_te_reference_seq')::text, 6, '0')
$$;
REVOKE ALL ON FUNCTION public.te_next_reference(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.te_policy_json(p_org_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT to_jsonb(p) - 'organization_id' FROM public.org_travel_policies p WHERE p.organization_id = p_org_id),
                  jsonb_build_object('currency', 'CAD', 'mileage_enabled', false))
$$;
REVOKE ALL ON FUNCTION public.te_policy_json(uuid) FROM PUBLIC;

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
  v_me := public.myhr_employee_id(p_store_id);
  IF v_me IS NULL OR v_me = p_employee_id OR NOT public.myhr_is_manager(p_store_id) THEN RETURN NULL; END IF;
  SELECT manager_approval_limit INTO v_limit FROM public.org_travel_policies WHERE organization_id = p_org_id;
  IF v_limit IS NULL OR COALESCE(p_amount, 0) > v_limit THEN RETURN NULL; END IF;
  RETURN public.te_employee_name(v_me);
END $$;
REVOKE ALL ON FUNCTION public.te_approver_name(uuid, uuid, uuid, numeric) FROM PUBLIC;

-- ── Employee: policy and own records ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.te_my_context(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id); v_org uuid := public.te_store_org(p_store_id);
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  RETURN jsonb_build_object(
    'employee_id', v_emp,
    'employee_name', public.te_employee_name(v_emp),
    'organization', COALESCE((SELECT name FROM public.organizations WHERE id = v_org), (SELECT store_name FROM public.stores WHERE id = p_store_id)),
    'store_name', (SELECT store_name FROM public.stores WHERE id = p_store_id),
    'department', (SELECT position_title FROM public.store_employee_jobs WHERE employee_id = v_emp),
    'work_location', (SELECT l.location_name FROM public.store_locations l WHERE l.store_id = p_store_id ORDER BY l.created_at LIMIT 1),
    'policy', public.te_policy_json(v_org),
    'is_manager', public.myhr_is_manager(p_store_id));
END $$;

-- One summary row per record (used by the employee list and the approval lists).
CREATE OR REPLACE FUNCTION public.te_summary_travel(t public.myhr_travel_requests)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('kind', 'travel', 'id', t.id, 'reference', t.reference, 'employee_id', t.employee_id,
    'employee_name', public.te_employee_name(t.employee_id), 'store_id', t.store_id,
    'store_name', (SELECT store_name FROM public.stores WHERE id = t.store_id),
    'description', COALESCE(NULLIF(t.destination, ''), 'Travel request') || COALESCE(' · ' || NULLIF(t.purpose, ''), ''),
    'start_date', t.departure_date, 'end_date', t.return_date, 'total', t.estimated_total, 'currency', t.currency,
    'status', t.status, 'payment_status', NULL, 'updated_at', t.updated_at)
$$;
REVOKE ALL ON FUNCTION public.te_summary_travel(public.myhr_travel_requests) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.te_summary_claim(c public.myhr_expense_claims)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('kind', 'claim', 'id', c.id, 'reference', c.reference, 'employee_id', c.employee_id,
    'employee_name', public.te_employee_name(c.employee_id), 'store_id', c.store_id,
    'store_name', (SELECT store_name FROM public.stores WHERE id = c.store_id),
    'description', COALESCE(NULLIF(c.description, ''), 'Expense claim'),
    'start_date', (SELECT min(expense_date) FROM public.myhr_expense_lines WHERE claim_id = c.id),
    'end_date', (SELECT max(expense_date) FROM public.myhr_expense_lines WHERE claim_id = c.id),
    'total', c.submitted_total, 'approved_total', c.approved_total, 'reimbursed_total', c.reimbursed_total, 'currency', c.currency,
    'status', c.status, 'payment_status', c.payment_status, 'travel_request_id', c.travel_request_id, 'updated_at', c.updated_at)
$$;
REVOKE ALL ON FUNCTION public.te_summary_claim(public.myhr_expense_claims) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.te_my_records(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(r ORDER BY r->>'updated_at' DESC) FROM (
    SELECT public.te_summary_travel(t) AS r FROM public.myhr_travel_requests t WHERE t.employee_id = v_emp
    UNION ALL
    SELECT public.te_summary_claim(c) FROM public.myhr_expense_claims c WHERE c.employee_id = v_emp) x), '[]'::jsonb);
END $$;

-- Full record: the owner, the organization's owner, or a manager who may decide it.
CREATE OR REPLACE FUNCTION public.te_record(p_store_id uuid, p_kind text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t public.myhr_travel_requests; c public.myhr_expense_claims; v_emp uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF p_kind = 'travel' THEN
    SELECT * INTO t FROM public.myhr_travel_requests WHERE id = p_id;
    IF t.id IS NULL THEN RAISE EXCEPTION 'That travel request wasn''t found.'; END IF;
    IF NOT (t.employee_id = v_emp OR public.te_is_org_owner(t.organization_id)
            OR (t.store_id = p_store_id AND public.te_approver_name(t.store_id, t.organization_id, t.employee_id, t.estimated_total) IS NOT NULL)) THEN
      RAISE EXCEPTION 'You can''t open this travel request.';
    END IF;
    RETURN to_jsonb(t) || public.te_summary_travel(t)
      || jsonb_build_object('mine', t.employee_id = v_emp,
           'can_decide', t.employee_id IS DISTINCT FROM v_emp AND public.te_approver_name(t.store_id, t.organization_id, t.employee_id, t.estimated_total) IS NOT NULL,
           'history', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.at) FROM public.myhr_te_history h WHERE h.record_kind = 'travel' AND h.record_id = t.id), '[]'::jsonb));
  ELSIF p_kind = 'claim' THEN
    SELECT * INTO c FROM public.myhr_expense_claims WHERE id = p_id;
    IF c.id IS NULL THEN RAISE EXCEPTION 'That expense claim wasn''t found.'; END IF;
    IF NOT (c.employee_id = v_emp OR public.te_is_org_owner(c.organization_id)
            OR (c.store_id = p_store_id AND public.te_approver_name(c.store_id, c.organization_id, c.employee_id, c.submitted_total) IS NOT NULL)) THEN
      RAISE EXCEPTION 'You can''t open this expense claim.';
    END IF;
    RETURN to_jsonb(c) || public.te_summary_claim(c)
      || jsonb_build_object('mine', c.employee_id = v_emp,
           'can_decide', c.employee_id IS DISTINCT FROM v_emp AND public.te_approver_name(c.store_id, c.organization_id, c.employee_id, c.submitted_total) IS NOT NULL,
           'travel_reference', (SELECT reference FROM public.myhr_travel_requests WHERE id = c.travel_request_id),
           'lines', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_no) FROM public.myhr_expense_lines l WHERE l.claim_id = c.id), '[]'::jsonb),
           'payments', COALESCE((SELECT jsonb_agg(to_jsonb(pm) ORDER BY pm.paid_on, pm.recorded_at) FROM public.myhr_expense_payments pm WHERE pm.claim_id = c.id), '[]'::jsonb),
           'history', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.at) FROM public.myhr_te_history h WHERE h.record_kind = 'claim' AND h.record_id = c.id), '[]'::jsonb));
  END IF;
  RAISE EXCEPTION 'Unknown record type.';
END $$;

-- Approved travel requests that can be claimed against.
CREATE OR REPLACE FUNCTION public.te_my_approved_travel(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id);
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(public.te_summary_travel(t) ORDER BY t.departure_date DESC NULLS LAST)
                     FROM public.myhr_travel_requests t WHERE t.employee_id = v_emp AND t.status = 'approved'), '[]'::jsonb);
END $$;

-- ── Employee: save / submit / cancel ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.te_save_travel(p_store_id uuid, p_id uuid, p_data jsonb, p_submit boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp uuid := public.myhr_employee_id(p_store_id);
  v_org uuid := public.te_store_org(p_store_id);
  v_row public.myhr_travel_requests;
  v_lines jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_line jsonb;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_data->'estimate_lines', '[]'::jsonb)) LOOP
    IF COALESCE(NULLIF(v_line->>'amount', '')::numeric, 0) < 0 THEN RAISE EXCEPTION 'Amounts can''t be negative.'; END IF;
    IF COALESCE(btrim(v_line->>'category'), '') = '' AND COALESCE(NULLIF(v_line->>'amount', '')::numeric, 0) = 0 THEN CONTINUE; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('category', btrim(v_line->>'category'), 'description', btrim(COALESCE(v_line->>'description', '')),
                                                               'amount', round(COALESCE(NULLIF(v_line->>'amount', '')::numeric, 0), 2)));
    v_total := v_total + round(COALESCE(NULLIF(v_line->>'amount', '')::numeric, 0), 2);
  END LOOP;

  IF p_id IS NULL THEN
    INSERT INTO public.myhr_travel_requests (reference, organization_id, store_id, employee_id, currency)
    VALUES (public.te_next_reference('TR'), v_org, p_store_id, v_emp, COALESCE(public.te_policy_json(v_org)->>'currency', 'CAD'))
    RETURNING * INTO v_row;
    INSERT INTO public.myhr_te_history (record_kind, record_id, action, by_name) VALUES ('travel', v_row.id, 'created', public.te_employee_name(v_emp));
  ELSE
    SELECT * INTO v_row FROM public.myhr_travel_requests WHERE id = p_id FOR UPDATE;
    IF v_row.id IS NULL OR v_row.employee_id <> v_emp THEN RAISE EXCEPTION 'That travel request isn''t yours.'; END IF;
    IF v_row.status NOT IN ('draft','returned') THEN RAISE EXCEPTION 'Only drafts and requests returned for correction can be changed.'; END IF;
  END IF;

  UPDATE public.myhr_travel_requests SET
    department = NULLIF(btrim(p_data->>'department'), ''), work_location = NULLIF(btrim(p_data->>'work_location'), ''),
    destination = NULLIF(btrim(p_data->>'destination'), ''), purpose = NULLIF(btrim(p_data->>'purpose'), ''),
    departure_date = NULLIF(p_data->>'departure_date', '')::date, return_date = NULLIF(p_data->>'return_date', '')::date,
    transport = NULLIF(btrim(p_data->>'transport'), ''), accommodation = NULLIF(btrim(p_data->>'accommodation'), ''),
    notes = NULLIF(btrim(p_data->>'notes'), ''), estimate_lines = v_lines, estimated_total = v_total, updated_at = now()
  WHERE id = v_row.id RETURNING * INTO v_row;

  IF p_submit THEN
    IF v_row.destination IS NULL OR v_row.purpose IS NULL OR v_row.departure_date IS NULL OR v_row.return_date IS NULL THEN
      RAISE EXCEPTION 'Add the destination, purpose and travel dates before submitting.';
    END IF;
    UPDATE public.myhr_travel_requests SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = v_row.id;
    INSERT INTO public.myhr_te_history (record_kind, record_id, action, by_name) VALUES ('travel', v_row.id, 'submitted', public.te_employee_name(v_emp));
  END IF;
  RETURN v_row.id;
END $$;

CREATE OR REPLACE FUNCTION public.te_save_claim(p_store_id uuid, p_id uuid, p_data jsonb, p_submit boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp uuid := public.myhr_employee_id(p_store_id);
  v_org uuid := public.te_store_org(p_store_id);
  v_policy jsonb := public.te_policy_json(public.te_store_org(p_store_id));
  v_row public.myhr_expense_claims;
  v_line jsonb;
  v_n int := 0;
  v_kind text; v_amount numeric; v_amount_claim numeric; v_rate numeric; v_currency text; v_km numeric; v_total numeric := 0;
  v_travel uuid := NULLIF(p_data->>'travel_request_id', '')::uuid;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  IF v_travel IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.myhr_travel_requests WHERE id = v_travel AND employee_id = v_emp AND status = 'approved') THEN
    RAISE EXCEPTION 'Claims can only be linked to your own approved travel requests.';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.myhr_expense_claims (reference, organization_id, store_id, employee_id, currency)
    VALUES (public.te_next_reference('EC'), v_org, p_store_id, v_emp, COALESCE(v_policy->>'currency', 'CAD'))
    RETURNING * INTO v_row;
    INSERT INTO public.myhr_te_history (record_kind, record_id, action, by_name) VALUES ('claim', v_row.id, 'created', public.te_employee_name(v_emp));
  ELSE
    SELECT * INTO v_row FROM public.myhr_expense_claims WHERE id = p_id FOR UPDATE;
    IF v_row.id IS NULL OR v_row.employee_id <> v_emp THEN RAISE EXCEPTION 'That expense claim isn''t yours.'; END IF;
    IF v_row.status NOT IN ('draft','returned') THEN RAISE EXCEPTION 'Only drafts and claims returned for correction can be changed.'; END IF;
  END IF;

  DELETE FROM public.myhr_expense_lines WHERE claim_id = v_row.id;
  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_data->'lines', '[]'::jsonb)) LOOP
    v_kind := CASE WHEN v_line->>'kind' = 'mileage' THEN 'mileage' ELSE 'expense' END;
    v_currency := upper(COALESCE(NULLIF(btrim(v_line->>'currency'), ''), v_row.currency));
    v_rate := NULL;
    IF v_kind = 'mileage' THEN
      -- Mileage: the organization's rate, never one typed in.
      IF NOT COALESCE((v_policy->>'mileage_enabled')::boolean, false) OR NULLIF(v_policy->>'mileage_rate', '') IS NULL THEN
        RAISE EXCEPTION 'Your organization hasn''t turned on mileage claims.';
      END IF;
      v_km := COALESCE(NULLIF(v_line->>'km', '')::numeric, 0);
      IF v_km < 0 THEN RAISE EXCEPTION 'Kilometres can''t be negative.'; END IF;
      v_amount := round(v_km * (v_policy->>'mileage_rate')::numeric, 2);
      v_currency := v_row.currency;
    ELSE
      v_km := NULL;
      v_amount := round(COALESCE(NULLIF(v_line->>'amount', '')::numeric, 0), 2);
      IF v_amount < 0 THEN RAISE EXCEPTION 'Amounts can''t be negative.'; END IF;
      IF v_currency <> v_row.currency THEN
        v_rate := NULLIF(v_line->>'exchange_rate', '')::numeric;
        IF p_submit AND (v_rate IS NULL OR v_rate <= 0 OR COALESCE(btrim(v_line->>'rate_source'), '') = '' OR NULLIF(v_line->>'rate_date', '') IS NULL) THEN
          RAISE EXCEPTION 'For amounts in %, add the exchange rate, where it came from and its date.', v_currency;
        END IF;
      END IF;
    END IF;
    v_amount_claim := CASE WHEN v_rate IS NOT NULL THEN round(v_amount * v_rate, 2) WHEN v_currency = v_row.currency THEN v_amount ELSE 0 END;
    IF v_kind = 'expense' AND COALESCE(btrim(v_line->>'category'), '') = '' AND v_amount = 0 THEN CONTINUE; END IF;
    v_n := v_n + 1;
    INSERT INTO public.myhr_expense_lines (claim_id, line_no, kind, expense_date, category, description, business_purpose, payment_method,
      amount, currency, exchange_rate, rate_source, rate_date, amount_claim, tax_amount, receipt_path, receipt_name, km, from_place, to_place, mileage_rate)
    VALUES (v_row.id, v_n, v_kind, NULLIF(v_line->>'expense_date', '')::date,
      CASE WHEN v_kind = 'mileage' THEN 'Mileage' ELSE NULLIF(btrim(v_line->>'category'), '') END,
      NULLIF(btrim(v_line->>'description'), ''), NULLIF(btrim(v_line->>'business_purpose'), ''), NULLIF(btrim(v_line->>'payment_method'), ''),
      v_amount, v_currency, v_rate, NULLIF(btrim(v_line->>'rate_source'), ''), NULLIF(v_line->>'rate_date', '')::date, v_amount_claim,
      NULLIF(v_line->>'tax_amount', '')::numeric,
      -- Receipts must be in the employee's own upload folder.
      CASE WHEN split_part(COALESCE(v_line->>'receipt_path', ''), '/', 1) = auth.uid()::text THEN v_line->>'receipt_path' END,
      NULLIF(v_line->>'receipt_name', ''), v_km, NULLIF(btrim(v_line->>'from_place'), ''), NULLIF(btrim(v_line->>'to_place'), ''),
      CASE WHEN v_kind = 'mileage' THEN (v_policy->>'mileage_rate')::numeric END);
    v_total := v_total + v_amount_claim;
  END LOOP;

  UPDATE public.myhr_expense_claims SET travel_request_id = v_travel, description = NULLIF(btrim(p_data->>'description'), ''),
         submitted_total = v_total, updated_at = now()
   WHERE id = v_row.id RETURNING * INTO v_row;

  IF p_submit THEN
    IF v_n = 0 THEN RAISE EXCEPTION 'Add at least one expense before submitting.'; END IF;
    IF EXISTS (SELECT 1 FROM public.myhr_expense_lines WHERE claim_id = v_row.id AND (expense_date IS NULL OR (kind = 'expense' AND category IS NULL))) THEN
      RAISE EXCEPTION 'Every expense needs a date and a category.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.myhr_expense_lines WHERE claim_id = v_row.id AND kind = 'mileage' AND (COALESCE(km, 0) = 0 OR from_place IS NULL OR to_place IS NULL)) THEN
      RAISE EXCEPTION 'Every mileage line needs the start, the destination and the kilometres.';
    END IF;
    IF NULLIF(v_policy->>'receipt_required_over', '') IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.myhr_expense_lines WHERE claim_id = v_row.id AND kind = 'expense' AND receipt_path IS NULL
            AND amount_claim > (v_policy->>'receipt_required_over')::numeric) THEN
      RAISE EXCEPTION 'Your organization needs a receipt for every expense over %.', to_char((v_policy->>'receipt_required_over')::numeric, 'FM999,990.00');
    END IF;
    UPDATE public.myhr_expense_claims SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = v_row.id;
    INSERT INTO public.myhr_te_history (record_kind, record_id, action, by_name) VALUES ('claim', v_row.id, 'submitted', public.te_employee_name(v_emp));
  END IF;
  RETURN v_row.id;
END $$;

CREATE OR REPLACE FUNCTION public.te_cancel(p_store_id uuid, p_kind text, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id); v_n int;
BEGIN
  IF p_kind = 'travel' THEN
    UPDATE public.myhr_travel_requests SET status = 'cancelled', updated_at = now()
     WHERE id = p_id AND employee_id = v_emp AND status IN ('draft','submitted','returned');
  ELSE
    UPDATE public.myhr_expense_claims SET status = 'cancelled', updated_at = now()
     WHERE id = p_id AND employee_id = v_emp AND status IN ('draft','submitted','returned');
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Only your own drafts, submitted or returned records can be cancelled.'; END IF;
  INSERT INTO public.myhr_te_history (record_kind, record_id, action, by_name) VALUES (p_kind, p_id, 'cancelled', public.te_employee_name(v_emp));
END $$;

-- ── Approvers ──────────────────────────────────────────────────────────────
-- Records a store manager may decide (within the organization's limit, not their own).
CREATE OR REPLACE FUNCTION public.te_store_to_decide(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.myhr_is_manager(p_store_id) THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((SELECT jsonb_agg(r ORDER BY r->>'updated_at') FROM (
    SELECT public.te_summary_travel(t) AS r FROM public.myhr_travel_requests t
     WHERE t.store_id = p_store_id AND t.status IN ('submitted','under_review')
       AND public.te_approver_name(t.store_id, t.organization_id, t.employee_id, t.estimated_total) IS NOT NULL
    UNION ALL
    SELECT public.te_summary_claim(c) FROM public.myhr_expense_claims c
     WHERE c.store_id = p_store_id AND c.status IN ('submitted','under_review')
       AND public.te_approver_name(c.store_id, c.organization_id, c.employee_id, c.submitted_total) IS NOT NULL) x), '[]'::jsonb);
END $$;

-- Decide a record: review | approve | reject | return. For claims, p_lines may give
-- {line_id: {approved_amount, note}} for a partial approval.
CREATE OR REPLACE FUNCTION public.te_decide(p_store_id uuid, p_kind text, p_id uuid, p_decision text, p_note text, p_lines jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t public.myhr_travel_requests; c public.myhr_expense_claims; v_name text; v_line public.myhr_expense_lines;
  v_approved numeric := 0; v_amt numeric; v_full boolean := true;
BEGIN
  IF p_decision NOT IN ('review','approve','reject','return') THEN RAISE EXCEPTION 'Unknown decision.'; END IF;
  IF p_decision IN ('reject','return') AND COALESCE(btrim(p_note), '') = '' THEN RAISE EXCEPTION 'Add a note explaining the decision.'; END IF;

  IF p_kind = 'travel' THEN
    SELECT * INTO t FROM public.myhr_travel_requests WHERE id = p_id FOR UPDATE;
    IF t.id IS NULL THEN RAISE EXCEPTION 'That travel request wasn''t found.'; END IF;
    v_name := public.te_approver_name(COALESCE(p_store_id, t.store_id), t.organization_id, t.employee_id, t.estimated_total);
    IF v_name IS NULL OR (p_store_id IS NOT NULL AND p_store_id <> t.store_id AND NOT public.te_is_org_owner(t.organization_id)) THEN
      RAISE EXCEPTION 'You can''t decide this travel request.';
    END IF;
    IF t.status NOT IN ('submitted','under_review') THEN RAISE EXCEPTION 'This travel request isn''t waiting for a decision.'; END IF;
    UPDATE public.myhr_travel_requests SET
      status = CASE p_decision WHEN 'review' THEN 'under_review' WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'returned' END,
      decided_by_name = CASE WHEN p_decision = 'review' THEN decided_by_name ELSE v_name END,
      decided_at = CASE WHEN p_decision = 'review' THEN decided_at ELSE now() END,
      decision_note = CASE WHEN p_decision = 'review' THEN decision_note ELSE NULLIF(btrim(p_note), '') END,
      updated_at = now()
    WHERE id = t.id;
    INSERT INTO public.myhr_te_history (record_kind, record_id, action, by_name, note)
    VALUES ('travel', t.id, CASE p_decision WHEN 'review' THEN 'under review' WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'returned for correction' END, v_name, NULLIF(btrim(p_note), ''));
    RETURN;
  END IF;

  SELECT * INTO c FROM public.myhr_expense_claims WHERE id = p_id FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'That expense claim wasn''t found.'; END IF;
  v_name := public.te_approver_name(COALESCE(p_store_id, c.store_id), c.organization_id, c.employee_id, c.submitted_total);
  IF v_name IS NULL OR (p_store_id IS NOT NULL AND p_store_id <> c.store_id AND NOT public.te_is_org_owner(c.organization_id)) THEN
    RAISE EXCEPTION 'You can''t decide this expense claim.';
  END IF;
  IF c.status NOT IN ('submitted','under_review') THEN RAISE EXCEPTION 'This expense claim isn''t waiting for a decision.'; END IF;

  IF p_decision = 'approve' THEN
    FOR v_line IN SELECT * FROM public.myhr_expense_lines WHERE claim_id = c.id ORDER BY line_no LOOP
      v_amt := COALESCE(NULLIF(p_lines->v_line.id::text->>'approved_amount', '')::numeric, v_line.amount_claim);
      IF v_amt < 0 OR v_amt > v_line.amount_claim THEN RAISE EXCEPTION 'An approved amount must be between 0 and the amount claimed.'; END IF;
      IF v_amt < v_line.amount_claim THEN
        v_full := false;
        IF COALESCE(btrim(p_lines->v_line.id::text->>'note'), '') = '' THEN RAISE EXCEPTION 'Explain each amount that isn''t approved in full.'; END IF;
      END IF;
      UPDATE public.myhr_expense_lines SET approved_amount = round(v_amt, 2),
             disallowed_note = CASE WHEN v_amt < v_line.amount_claim THEN btrim(p_lines->v_line.id::text->>'note') END
       WHERE id = v_line.id;
      v_approved := v_approved + round(v_amt, 2);
    END LOOP;
  END IF;

  UPDATE public.myhr_expense_claims SET
    status = CASE p_decision WHEN 'review' THEN 'under_review' WHEN 'reject' THEN 'rejected' WHEN 'return' THEN 'returned'
                             ELSE CASE WHEN v_full THEN 'approved' ELSE 'partially_approved' END END,
    approved_total = CASE WHEN p_decision = 'approve' THEN v_approved WHEN p_decision = 'reject' THEN 0 ELSE approved_total END,
    -- Approval never marks a claim paid: it waits for the organization to record the payment.
    payment_status = CASE WHEN p_decision = 'approve' AND v_approved > 0 THEN 'awaiting' ELSE 'not_due' END,
    decided_by_name = CASE WHEN p_decision = 'review' THEN decided_by_name ELSE v_name END,
    decided_at = CASE WHEN p_decision = 'review' THEN decided_at ELSE now() END,
    decision_note = CASE WHEN p_decision = 'review' THEN decision_note ELSE NULLIF(btrim(p_note), '') END,
    updated_at = now()
  WHERE id = c.id;
  INSERT INTO public.myhr_te_history (record_kind, record_id, action, by_name, note)
  VALUES ('claim', c.id, CASE p_decision WHEN 'review' THEN 'under review' WHEN 'reject' THEN 'rejected' WHEN 'return' THEN 'returned for correction'
                              ELSE CASE WHEN v_full THEN 'approved' ELSE 'partially approved' END END, v_name,
          CASE WHEN p_decision = 'approve' THEN concat_ws(' · ', 'Approved ' || to_char(v_approved, 'FM999,999,990.00'), NULLIF(btrim(p_note), '')) ELSE NULLIF(btrim(p_note), '') END);
END $$;

-- ── Organization ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.te_org_policy(p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.te_is_org_owner(p_org_id) THEN RAISE EXCEPTION 'Only the organization''s owner can see travel policy settings.'; END IF;
  RETURN public.te_policy_json(p_org_id);
END $$;

CREATE OR REPLACE FUNCTION public.te_org_policy_save(p_org_id uuid, p_policy jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.te_is_org_owner(p_org_id) THEN RAISE EXCEPTION 'Only the organization''s owner can change the travel policy.'; END IF;
  IF COALESCE((p_policy->>'mileage_enabled')::boolean, false) AND NULLIF(p_policy->>'mileage_rate', '') IS NULL THEN
    RAISE EXCEPTION 'Set the mileage rate per kilometre to turn on mileage claims.';
  END IF;
  INSERT INTO public.org_travel_policies (organization_id) VALUES (p_org_id) ON CONFLICT (organization_id) DO NOTHING;
  UPDATE public.org_travel_policies SET
    currency = upper(COALESCE(NULLIF(btrim(p_policy->>'currency'), ''), 'CAD')),
    mileage_enabled = COALESCE((p_policy->>'mileage_enabled')::boolean, false),
    mileage_rate = NULLIF(p_policy->>'mileage_rate', '')::numeric,
    meal_daily_limit = NULLIF(p_policy->>'meal_daily_limit', '')::numeric,
    lodging_nightly_limit = NULLIF(p_policy->>'lodging_nightly_limit', '')::numeric,
    receipt_required_over = NULLIF(p_policy->>'receipt_required_over', '')::numeric,
    manager_approval_limit = NULLIF(p_policy->>'manager_approval_limit', '')::numeric,
    policy_notes = NULLIF(btrim(p_policy->>'policy_notes'), ''),
    updated_by_name = COALESCE((SELECT name FROM public.organizations WHERE id = p_org_id), 'Organization'),
    updated_at = now()
  WHERE organization_id = p_org_id;
END $$;

CREATE OR REPLACE FUNCTION public.te_org_records(p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.te_is_org_owner(p_org_id) THEN RAISE EXCEPTION 'Only the organization''s owner can see travel and expense records.'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(r ORDER BY r->>'updated_at' DESC) FROM (
    SELECT public.te_summary_travel(t) AS r FROM public.myhr_travel_requests t
      JOIN public.stores s ON s.id = t.store_id WHERE s.organization_id = p_org_id AND t.status <> 'draft'
    UNION ALL
    SELECT public.te_summary_claim(c) FROM public.myhr_expense_claims c
      JOIN public.stores s ON s.id = c.store_id WHERE s.organization_id = p_org_id AND c.status <> 'draft') x), '[]'::jsonb);
END $$;

-- The organization's owner opens any record in their organization (no store sign-in).
CREATE OR REPLACE FUNCTION public.te_org_record(p_org_id uuid, p_kind text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid;
BEGIN
  IF NOT public.te_is_org_owner(p_org_id) THEN RAISE EXCEPTION 'Only the organization''s owner can open this.'; END IF;
  v_store := CASE WHEN p_kind = 'travel' THEN (SELECT store_id FROM public.myhr_travel_requests WHERE id = p_id)
                  ELSE (SELECT store_id FROM public.myhr_expense_claims WHERE id = p_id) END;
  IF v_store IS NULL OR public.te_store_org(v_store) <> p_org_id THEN RAISE EXCEPTION 'That record isn''t in this organization.'; END IF;
  RETURN public.te_record(v_store, p_kind, p_id);
END $$;

CREATE OR REPLACE FUNCTION public.te_org_decide(p_org_id uuid, p_kind text, p_id uuid, p_decision text, p_note text, p_lines jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_store uuid;
BEGIN
  IF NOT public.te_is_org_owner(p_org_id) THEN RAISE EXCEPTION 'Only the organization''s owner can decide this.'; END IF;
  v_store := CASE WHEN p_kind = 'travel' THEN (SELECT store_id FROM public.myhr_travel_requests WHERE id = p_id)
                  ELSE (SELECT store_id FROM public.myhr_expense_claims WHERE id = p_id) END;
  IF v_store IS NULL OR public.te_store_org(v_store) <> p_org_id THEN RAISE EXCEPTION 'That record isn''t in this organization.'; END IF;
  PERFORM public.te_decide(v_store, p_kind, p_id, p_decision, p_note, p_lines);
END $$;

-- Record a reimbursement payment that has actually been made (separately from approval).
-- A claim can be paid in parts; it's Paid once the payments reach the approved amount.
DROP FUNCTION IF EXISTS public.te_org_record_payment(uuid, uuid, date, text);
CREATE OR REPLACE FUNCTION public.te_org_record_payment(p_org_id uuid, p_claim_id uuid, p_paid_on date, p_amount numeric, p_method text, p_reference text, p_processed_by text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.myhr_expense_claims; v_org_name text; v_outstanding numeric; v_paid numeric;
BEGIN
  IF NOT public.te_is_org_owner(p_org_id) THEN RAISE EXCEPTION 'Only the organization''s owner can record reimbursements.'; END IF;
  SELECT * INTO c FROM public.myhr_expense_claims WHERE id = p_claim_id FOR UPDATE;
  IF c.id IS NULL OR public.te_store_org(c.store_id) <> p_org_id THEN RAISE EXCEPTION 'That claim isn''t in this organization.'; END IF;
  IF c.payment_status NOT IN ('awaiting','partial') THEN RAISE EXCEPTION 'This claim isn''t waiting for reimbursement.'; END IF;
  IF p_paid_on IS NULL OR COALESCE(btrim(p_reference), '') = '' OR COALESCE(btrim(p_method), '') = '' OR COALESCE(btrim(p_processed_by), '') = '' THEN
    RAISE EXCEPTION 'Enter the payment date, method, reference and who processed it.';
  END IF;
  v_outstanding := COALESCE(c.approved_total, 0) - COALESCE(c.reimbursed_total, 0);
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Enter the amount paid.'; END IF;
  -- Protects against paying more than was approved, or paying twice.
  IF round(p_amount, 2) > round(v_outstanding, 2) THEN RAISE EXCEPTION 'That''s more than the % still owing.', to_char(v_outstanding, 'FM999,999,990.00'); END IF;
  IF EXISTS (SELECT 1 FROM public.myhr_expense_payments WHERE claim_id = c.id AND lower(reference) = lower(btrim(p_reference))) THEN
    RAISE EXCEPTION 'A payment with reference % is already recorded on this claim.', btrim(p_reference);
  END IF;
  v_org_name := COALESCE((SELECT name FROM public.organizations WHERE id = p_org_id), 'Organization');
  INSERT INTO public.myhr_expense_payments (claim_id, paid_on, amount, method, reference, processed_by_name, recorded_by_name)
  VALUES (c.id, p_paid_on, round(p_amount, 2), btrim(p_method), btrim(p_reference), btrim(p_processed_by), v_org_name);
  v_paid := COALESCE(c.reimbursed_total, 0) + round(p_amount, 2);
  UPDATE public.myhr_expense_claims SET reimbursed_total = v_paid,
         payment_status = CASE WHEN v_paid >= COALESCE(approved_total, 0) THEN 'paid' ELSE 'partial' END,
         paid_on = p_paid_on, payment_reference = btrim(p_reference), paid_recorded_by = btrim(p_processed_by), paid_recorded_at = now(), updated_at = now()
   WHERE id = c.id;
  INSERT INTO public.myhr_te_history (record_kind, record_id, action, by_name, note)
  VALUES ('claim', c.id, CASE WHEN v_paid >= COALESCE(c.approved_total, 0) THEN 'reimbursement paid' ELSE 'partial reimbursement' END, btrim(p_processed_by),
          'Paid ' || to_char(p_amount, 'FM999,999,990.00') || ' by ' || btrim(p_method) || ' on ' || p_paid_on || ' · ref ' || btrim(p_reference));
END $$;

-- Expense lines by category and mileage, for submitted (not draft/cancelled) claims in a date range.
CREATE OR REPLACE FUNCTION public.te_org_line_summary(p_org_id uuid, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.te_is_org_owner(p_org_id) THEN RAISE EXCEPTION 'Only the organization''s owner can see travel and expense reports.'; END IF;
  RETURN jsonb_build_object(
    'categories', COALESCE((SELECT jsonb_agg(jsonb_build_object('category', category, 'lines', n, 'claimed', claimed, 'approved', approved) ORDER BY claimed DESC) FROM (
        SELECT COALESCE(l.category, 'Uncategorised') AS category, count(*) AS n, sum(l.amount_claim) AS claimed, sum(COALESCE(l.approved_amount, 0)) AS approved
          FROM public.myhr_expense_lines l JOIN public.myhr_expense_claims c ON c.id = l.claim_id JOIN public.stores s ON s.id = c.store_id
         WHERE s.organization_id = p_org_id AND c.status NOT IN ('draft','cancelled')
           AND (p_from IS NULL OR l.expense_date >= p_from) AND (p_to IS NULL OR l.expense_date <= p_to)
         GROUP BY 1) x), '[]'::jsonb),
    'mileage', COALESCE((SELECT jsonb_build_object('trips', count(*), 'km', COALESCE(sum(l.km), 0), 'claimed', COALESCE(sum(l.amount_claim), 0), 'approved', COALESCE(sum(l.approved_amount), 0))
          FROM public.myhr_expense_lines l JOIN public.myhr_expense_claims c ON c.id = l.claim_id JOIN public.stores s ON s.id = c.store_id
         WHERE s.organization_id = p_org_id AND l.kind = 'mileage' AND c.status NOT IN ('draft','cancelled')
           AND (p_from IS NULL OR l.expense_date >= p_from) AND (p_to IS NULL OR l.expense_date <= p_to)), '{}'::jsonb));
END $$;

-- ── Receipts: private bucket; employees upload to their own folder ─────────
INSERT INTO storage.buckets (id, name, public) VALUES ('expense-receipts', 'expense-receipts', false) ON CONFLICT (id) DO NOTHING;

-- Can the signed-in user see this receipt? Its uploader, the organization's owner,
-- or a manager who may decide the claim it belongs to.
CREATE OR REPLACE FUNCTION public.te_can_view_receipt(p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT split_part(p_path, '/', 1) = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.myhr_expense_lines l JOIN public.myhr_expense_claims c ON c.id = l.claim_id
                  WHERE l.receipt_path = p_path
                    AND (public.te_is_org_owner(c.organization_id)
                         OR public.te_approver_name(c.store_id, c.organization_id, c.employee_id, c.submitted_total) IS NOT NULL))
$$;
GRANT EXECUTE ON FUNCTION public.te_can_view_receipt(text) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'expense_receipts_own_insert') THEN
    CREATE POLICY expense_receipts_own_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'expense-receipts' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'expense_receipts_select') THEN
    CREATE POLICY expense_receipts_select ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'expense-receipts' AND public.te_can_view_receipt(name));
  END IF;
  -- Only unattached uploads can be removed (a receipt on a submitted claim stays).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'expense_receipts_own_delete') THEN
    CREATE POLICY expense_receipts_own_delete ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'expense-receipts' AND (storage.foldername(name))[1] = auth.uid()::text
             AND NOT EXISTS (SELECT 1 FROM public.myhr_expense_lines l WHERE l.receipt_path = name));
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.te_my_context(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_my_records(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_record(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_my_approved_travel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_save_travel(uuid, uuid, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_save_claim(uuid, uuid, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_cancel(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_store_to_decide(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_decide(uuid, text, uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_org_policy(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_org_policy_save(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_org_records(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_org_record(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_org_decide(uuid, text, uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_org_record_payment(uuid, uuid, date, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.te_org_line_summary(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
