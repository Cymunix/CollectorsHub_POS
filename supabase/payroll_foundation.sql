-- NORDVIK payroll: records foundation (run after myhr_job.sql). Safe to run again.
--
-- This holds the organization's payroll settings and the RESULTS of payroll: runs,
-- payslips and year-end tax documents. It does not calculate pay. The calculation
-- engine (effective-dated CRA rules, CPP/CPP2/EI, provincial tax) is built and
-- validated separately; until a jurisdiction is validated nothing here is produced
-- for live payroll. Employees only ever see finalised, published payslips and
-- issued tax forms of their own; nothing here is writable by employees.

-- ── Organization payroll settings (pay calendar) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.org_payroll_settings (
  organization_id      uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  legal_employer_name  text,
  business_number      text,          -- CRA business number (BN9)
  payroll_account      text,          -- payroll program account, e.g. 123456789RP0001
  province             text,          -- operating province or territory code, e.g. NS
  pay_frequency        text CHECK (pay_frequency IS NULL OR pay_frequency IN ('weekly','biweekly','semimonthly','monthly')),
  first_period_start   date,          -- anchor for weekly / bi-weekly calendars
  pay_date_offset_days int NOT NULL DEFAULT 5 CHECK (pay_date_offset_days BETWEEN 0 AND 31), -- pay date = period end + offset
  live_processing      boolean NOT NULL DEFAULT false,  -- stays off until a documented compliance review
  updated_by_name      text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.org_payroll_settings ENABLE ROW LEVEL SECURITY;

-- ── Payroll runs and payslips (results) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  pay_date         date NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculating','needs_review','ready_for_approval','approved','finalised','payment_pending','partially_paid','paid','failed','cancelled')),
  is_test          boolean NOT NULL DEFAULT true,
  approved_by_name text, approved_at timestamptz,
  finalised_by_name text, finalised_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS payroll_runs_org_idx ON public.payroll_runs(organization_id, pay_date DESC);
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.payroll_payslips (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE RESTRICT,
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES public.store_employees(id) ON DELETE RESTRICT,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  pay_date              date NOT NULL,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalised','reversed')),
  payment_status        text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed')),
  -- [{code, label, hours, rate, amount, ytd}] / [{code, label, amount, ytd}] / [{code, label, amount, ytd}]
  earnings              jsonb NOT NULL DEFAULT '[]'::jsonb,
  deductions            jsonb NOT NULL DEFAULT '[]'::jsonb,
  employer_contributions jsonb NOT NULL DEFAULT '[]'::jsonb,
  gross                 numeric(12,2) NOT NULL DEFAULT 0,
  taxable               numeric(12,2) NOT NULL DEFAULT 0,
  pensionable           numeric(12,2) NOT NULL DEFAULT 0,
  insurable             numeric(12,2) NOT NULL DEFAULT 0,
  total_deductions      numeric(12,2) NOT NULL DEFAULT 0,
  net                   numeric(12,2) NOT NULL DEFAULT 0,
  ytd                   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {gross, deductions, net, ...}
  rules_version         text,           -- the effective-dated rule set used
  published_at          timestamptz,    -- visible to the employee only once finalised and published
  reverses_payslip_id   uuid REFERENCES public.payroll_payslips(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_payslips_emp_idx ON public.payroll_payslips(employee_id, pay_date DESC);
ALTER TABLE public.payroll_payslips ENABLE ROW LEVEL SECURITY;

-- Finalised payslips are never edited in place: corrections are new adjustment or reversal payslips.
CREATE OR REPLACE FUNCTION public.payroll_payslip_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'finalised' AND (
       NEW.earnings IS DISTINCT FROM OLD.earnings OR NEW.deductions IS DISTINCT FROM OLD.deductions
    OR NEW.employer_contributions IS DISTINCT FROM OLD.employer_contributions OR NEW.gross IS DISTINCT FROM OLD.gross
    OR NEW.net IS DISTINCT FROM OLD.net OR NEW.total_deductions IS DISTINCT FROM OLD.total_deductions
    OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.pay_date IS DISTINCT FROM OLD.pay_date) THEN
    RAISE EXCEPTION 'A finalised payslip can''t be changed. Make an adjustment or reversal instead.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_payslip_guard ON public.payroll_payslips;
CREATE TRIGGER payroll_payslip_guard BEFORE UPDATE ON public.payroll_payslips FOR EACH ROW EXECUTE FUNCTION public.payroll_payslip_guard();

-- ── Year-end tax documents ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_tax_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES public.store_employees(id) ON DELETE RESTRICT,
  tax_year         int NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  form_type        text NOT NULL CHECK (form_type IN ('T4','T4A','RL-1')),
  version          int NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','under_review','finalised','issued','amended')),
  amends_id        uuid REFERENCES public.payroll_tax_documents(id),
  boxes            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- form box values, from finalised payroll only
  document_path    text,                                 -- PDF in the payroll-documents bucket
  issued_at        timestamptz,
  issued_by_name   text,
  filed_reference  text,                                 -- CRA filing confirmation, when filed (generating a PDF is not filing)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, tax_year, form_type, version)
);
ALTER TABLE public.payroll_tax_documents ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.payroll_taxdoc_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('issued','amended') AND (NEW.boxes IS DISTINCT FROM OLD.boxes OR NEW.document_path IS DISTINCT FROM OLD.document_path
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.tax_year IS DISTINCT FROM OLD.tax_year OR NEW.form_type IS DISTINCT FROM OLD.form_type) THEN
    RAISE EXCEPTION 'An issued tax form can''t be changed. Issue an amended version instead.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_taxdoc_guard ON public.payroll_tax_documents;
CREATE TRIGGER payroll_taxdoc_guard BEFORE UPDATE ON public.payroll_tax_documents FOR EACH ROW EXECUTE FUNCTION public.payroll_taxdoc_guard();

-- ── Organization: payroll settings ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.payroll_org_settings(p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN RAISE EXCEPTION 'Only the organization''s owner can see payroll settings.'; END IF;
  RETURN COALESCE((SELECT to_jsonb(s) - 'organization_id' FROM public.org_payroll_settings s WHERE s.organization_id = p_org_id), '{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.payroll_org_settings_save(p_org_id uuid, p_settings jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN RAISE EXCEPTION 'Only the organization''s owner can change payroll settings.'; END IF;
  IF NULLIF(p_settings->>'pay_frequency', '') IN ('weekly','biweekly') AND NULLIF(p_settings->>'first_period_start', '') IS NULL THEN
    RAISE EXCEPTION 'Weekly and bi-weekly pay need the start date of a pay period.';
  END IF;
  INSERT INTO public.org_payroll_settings (organization_id) VALUES (p_org_id) ON CONFLICT (organization_id) DO NOTHING;
  UPDATE public.org_payroll_settings SET
    legal_employer_name = NULLIF(btrim(p_settings->>'legal_employer_name'), ''),
    business_number = NULLIF(btrim(p_settings->>'business_number'), ''),
    payroll_account = NULLIF(upper(btrim(p_settings->>'payroll_account')), ''),
    province = NULLIF(upper(btrim(p_settings->>'province')), ''),
    pay_frequency = NULLIF(p_settings->>'pay_frequency', ''),
    first_period_start = NULLIF(p_settings->>'first_period_start', '')::date,
    pay_date_offset_days = COALESCE(NULLIF(p_settings->>'pay_date_offset_days', '')::int, 5),
    -- live_processing is never switched on from here.
    updated_by_name = COALESCE((SELECT name FROM public.organizations WHERE id = p_org_id), 'Organization'),
    updated_at = now()
  WHERE organization_id = p_org_id;
END $$;

-- ── Employee: own pay (finalised and published only) ───────────────────────
CREATE OR REPLACE FUNCTION public.payroll_visible(p public.payroll_payslips)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p.status = 'finalised' AND p.published_at IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.pay_my_overview(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_emp uuid := public.myhr_employee_id(p_store_id);
  v_org uuid := (SELECT organization_id FROM public.stores WHERE id = p_store_id);
  v_set public.org_payroll_settings;
  v_latest public.payroll_payslips;
  v_year int := extract(year FROM current_date)::int;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  SELECT * INTO v_set FROM public.org_payroll_settings WHERE organization_id = v_org;
  SELECT * INTO v_latest FROM public.payroll_payslips p WHERE p.employee_id = v_emp AND public.payroll_visible(p) ORDER BY p.pay_date DESC, p.created_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'employee_name', (SELECT COALESCE(NULLIF(btrim(concat_ws(' ', first_name, last_name)), ''), username) FROM public.store_employees WHERE id = v_emp),
    'personnel_number', (SELECT personnel_number FROM public.store_employees WHERE id = v_emp),
    'organization', COALESCE(v_set.legal_employer_name, (SELECT name FROM public.organizations WHERE id = v_org), (SELECT store_name FROM public.stores WHERE id = p_store_id)),
    'pay_frequency', COALESCE(v_set.pay_frequency, (SELECT pay_period FROM public.store_employee_jobs WHERE employee_id = v_emp)),
    'first_period_start', v_set.first_period_start,
    'pay_date_offset_days', v_set.pay_date_offset_days,
    'next_run', (SELECT jsonb_build_object('period_start', r.period_start, 'period_end', r.period_end, 'pay_date', r.pay_date)
                   FROM public.payroll_runs r WHERE r.organization_id = v_org AND r.pay_date >= current_date AND r.status <> 'cancelled' AND NOT r.is_test
                  ORDER BY r.pay_date LIMIT 1),
    'latest', CASE WHEN v_latest.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_latest.id, 'pay_date', v_latest.pay_date, 'gross', v_latest.gross, 'net', v_latest.net) END,
    'ytd_gross', (SELECT COALESCE(sum(p.gross), 0) FROM public.payroll_payslips p WHERE p.employee_id = v_emp AND public.payroll_visible(p) AND extract(year FROM p.pay_date) = v_year),
    'ytd_deductions', (SELECT COALESCE(sum(p.total_deductions), 0) FROM public.payroll_payslips p WHERE p.employee_id = v_emp AND public.payroll_visible(p) AND extract(year FROM p.pay_date) = v_year),
    'ytd_net', (SELECT COALESCE(sum(p.net), 0) FROM public.payroll_payslips p WHERE p.employee_id = v_emp AND public.payroll_visible(p) AND extract(year FROM p.pay_date) = v_year),
    'year', v_year);
END $$;

CREATE OR REPLACE FUNCTION public.pay_my_payslips(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'period_start', p.period_start, 'period_end', p.period_end, 'pay_date', p.pay_date,
                     'gross', p.gross, 'total_deductions', p.total_deductions, 'net', p.net, 'payment_status', p.payment_status,
                     'is_reversal', p.reverses_payslip_id IS NOT NULL) ORDER BY p.pay_date DESC, p.created_at DESC)
                     FROM public.payroll_payslips p WHERE p.employee_id = v_emp AND public.payroll_visible(p)), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.pay_my_payslip(p_store_id uuid, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id); p public.payroll_payslips;
BEGIN
  SELECT * INTO p FROM public.payroll_payslips WHERE id = p_id;
  IF v_emp IS NULL OR p.id IS NULL OR p.employee_id <> v_emp OR NOT public.payroll_visible(p) THEN RAISE EXCEPTION 'That payslip isn''t available.'; END IF;
  RETURN to_jsonb(p) || jsonb_build_object(
    'employee_name', (SELECT COALESCE(NULLIF(btrim(concat_ws(' ', first_name, last_name)), ''), username) FROM public.store_employees WHERE id = v_emp),
    'personnel_number', (SELECT personnel_number FROM public.store_employees WHERE id = v_emp),
    'employer', COALESCE((SELECT legal_employer_name FROM public.org_payroll_settings WHERE organization_id = p.organization_id), (SELECT name FROM public.organizations WHERE id = p.organization_id)));
END $$;

CREATE OR REPLACE FUNCTION public.pay_my_tax_documents(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid := public.myhr_employee_id(p_store_id);
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'No employee account for you at this store.'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'tax_year', d.tax_year, 'form_type', d.form_type, 'version', d.version,
                     'status', d.status, 'amends_id', d.amends_id, 'document_path', d.document_path, 'issued_at', d.issued_at,
                     'superseded', EXISTS (SELECT 1 FROM public.payroll_tax_documents n WHERE n.amends_id = d.id AND n.status IN ('issued','amended')))
                     ORDER BY d.tax_year DESC, d.form_type, d.version DESC)
                     FROM public.payroll_tax_documents d WHERE d.employee_id = v_emp AND d.status IN ('issued','amended')), '[]'::jsonb);
END $$;

-- Issued tax form PDFs: private bucket, readable by the employee they belong to and the organization's owner.
INSERT INTO storage.buckets (id, name, public) VALUES ('payroll-documents', 'payroll-documents', false) ON CONFLICT (id) DO NOTHING;
CREATE OR REPLACE FUNCTION public.payroll_can_view_document(p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.payroll_tax_documents d JOIN public.store_employees e ON e.id = d.employee_id
                  WHERE d.document_path = p_path
                    AND ((d.status IN ('issued','amended') AND (e.employee_user_id = auth.uid() OR e.auth_user_id = auth.uid()))
                         OR d.organization_id IN (SELECT public.user_org_ids())))
$$;
GRANT EXECUTE ON FUNCTION public.payroll_can_view_document(text) TO authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'payroll_documents_select') THEN
    CREATE POLICY payroll_documents_select ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'payroll-documents' AND public.payroll_can_view_document(name));
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.payroll_org_settings(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_org_settings_save(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_my_overview(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_my_payslips(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_my_payslip(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_my_tax_documents(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
