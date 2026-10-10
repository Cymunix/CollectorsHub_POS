-- CollectorsHub POS: Pawn & Loans (collateral-backed pawn loans only).
-- Run after store_features.sql, customers.sql and transactions.sql. Safe to run more than once.
--
-- SAFETY
-- * Lending is OFF by default (pawn_store_settings.lending_enabled = false).
-- * Nothing legal is hard-coded. Every rate, fee, limit, grace / waiting period,
--   disclosure and the agreement template comes from a jurisdiction configuration
--   (pawn_configs) that the store owner / organization fills in. A configuration
--   only becomes usable for real loans after it is marked reviewed against the
--   law (reviewer + reference recorded); a value in this table is not proof of compliance.
-- * Real loans need: the Pawns & Loans feature on, lending enabled, a reviewed
--   configuration, and (when the configuration requires it) a verified licence.
-- * Test stores (stores.is_test_store) can run the whole flow with test loans
--   (is_test; agreements marked TEST) to try it out before anything is live.
-- * Passing the due date never transfers ownership. Forfeiture is a separate,
--   authorised step with checks; collateral reaches inventory only after that.
--
-- Money: every movement is a pawn_ledger row and a store_transactions row of a
-- pawn type (pawn_loan, pawn_payment, pawn_redemption, pawn_renewal, pawn_reversal),
-- so it shows in Transactions and the cash drawer but never as sales revenue.
--
-- Permissions: pawn_view, pawn_create, pawn_approve, pawn_disburse, pawn_payments,
-- pawn_renew, pawn_release, pawn_overdue, pawn_forfeit, pawn_transfer, pawn_reports.
-- Role defaults (pawn_role_defaults), each switchable per employee in
-- store_employees.action_permissions (true grants, false removes):
--   owner / manager / store_manager: all except forfeit and transfer
--   assistant_manager / supervisor: view, create, payments, renew, release, overdue, reports
--   everyone else: none
-- The store owner and the organization have everything. Pawn settings (configurations,
-- lending switch, licence, staff permissions) are managed by the organization from its
-- own login (Org portal → Stores → Pawn), or by the store owner, never from a store login.

-- ── Transactions: pawn types (separate from sales) ───────────────────────────
ALTER TABLE public.store_transactions DROP CONSTRAINT IF EXISTS store_transactions_type_check;
ALTER TABLE public.store_transactions ADD CONSTRAINT store_transactions_type_check CHECK (transaction_type IN
  ('sale', 'trade_in', 'exchange', 'return', 'refund', 'adjustment', 'pawn_loan', 'pawn_payment', 'pawn_redemption', 'pawn_renewal', 'pawn_reversal'));

-- ── Configuration ───────────────────────────────────────────────────────────
-- rules (all optional until approval; see pawn_config_missing):
--   term_days_default, term_days_max, interest_monthly_pct_max, charges_after_due (bool),
--   charges_cap_pct_of_principal, fees [{code,label,basis:'flat'|'percent',amount,max}],
--   min_principal, max_principal, grace_days, forfeiture_wait_days,
--   forfeiture_notice_required (bool), forfeiture_notice_days, renewals_allowed (bool),
--   max_renewals, partial_payments_allowed (bool), electronic_signature_allowed (bool),
--   borrower_min_age, id_fields [name,date_of_birth,address,id_type,id_expiry,id_number],
--   record_retention_years, licence_required (bool), disclosures (text), agreement_template (text)
-- Configurations are CollectorsHub's (organization_id and store_id NULL), one set per province /
-- territory, managed in the Admin workspace (Pawn Jurisdictions) by platform administrators.
CREATE TABLE IF NOT EXISTS public.pawn_configs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid,
  store_id         uuid REFERENCES public.stores(id) ON DELETE CASCADE,
  name             text NOT NULL,
  jurisdiction     text NOT NULL,                 -- e.g. CA-NS
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'test', 'approved', 'retired')),
  rules            jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by      text,
  review_reference text,
  reviewed_at      timestamptz,
  approved_by_user uuid,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pawn_store_settings (
  store_id             uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  lending_enabled      boolean NOT NULL DEFAULT false,
  config_id            uuid REFERENCES public.pawn_configs(id) ON DELETE SET NULL,
  interest_monthly_pct numeric(6,3),              -- the store's rate; never above the configuration's maximum
  licence_number       text,
  licence_verified     boolean NOT NULL DEFAULT false,
  licence_verified_by  uuid,
  licence_verified_at  timestamptz,
  due_soon_days        integer NOT NULL DEFAULT 7 CHECK (due_soon_days BETWEEN 1 AND 60),
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pawn_counters (store_id uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE, last integer NOT NULL DEFAULT 0);

-- ── Loans ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pawn_loans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id               uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  location_id            uuid REFERENCES public.store_locations(id) ON DELETE SET NULL,
  loan_number            text NOT NULL,
  customer_id            uuid REFERENCES public.store_customers(id) ON DELETE SET NULL,
  borrower               jsonb NOT NULL DEFAULT '{}'::jsonb,   -- identification captured (only the fields the configuration requires)
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'active', 'redeemed', 'forfeiture_review', 'forfeited', 'cancelled')),
  is_test                boolean NOT NULL DEFAULT false,
  config_id              uuid REFERENCES public.pawn_configs(id) ON DELETE SET NULL,
  terms                  jsonb,                                 -- snapshot fixed at approval
  principal              numeric(12,2) NOT NULL DEFAULT 0,
  term_days              integer,
  interest_monthly_pct   numeric(6,3),
  issue_date             date,
  due_date               date,
  principal_outstanding  numeric(12,2) NOT NULL DEFAULT 0,
  charges_unpaid         numeric(12,2) NOT NULL DEFAULT 0,
  charges_assessed_total numeric(12,2) NOT NULL DEFAULT 0,
  charges_accrued_to     date,
  renewals               integer NOT NULL DEFAULT 0,
  legal_hold             boolean NOT NULL DEFAULT false,
  hold_reason            text,
  disbursement_method    text,
  disbursement_reference text,
  disbursed_at           timestamptz,
  created_by_employee    uuid,
  assigned_employee      uuid,
  approved_by_employee   uuid,
  approved_by_user       uuid,
  approved_at            timestamptz,
  closed_at              timestamptz,
  notes                  text,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pawn_loans_number_key UNIQUE (store_id, loan_number)
);
CREATE INDEX IF NOT EXISTS pawn_loans_store_status_idx ON public.pawn_loans (store_id, status, due_date);
CREATE INDEX IF NOT EXISTS pawn_loans_customer_idx ON public.pawn_loans (customer_id);

-- Each pledged item. Never part of store_inventory until lawfully acquired and transferred.
CREATE TABLE IF NOT EXISTS public.pawn_collateral (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id              uuid NOT NULL REFERENCES public.pawn_loans(id) ON DELETE CASCADE,
  store_id             uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  collateral_code      text NOT NULL,
  position             integer NOT NULL DEFAULT 1,
  catalog_item_id      uuid,
  name                 text NOT NULL,
  category             text,
  brand                text,
  model                text,
  serial_number        text,
  condition            text,
  description          text,
  quantity             integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  photos               text[] NOT NULL DEFAULT '{}',
  estimated_value      numeric(12,2),
  valuation_source     text,
  valuation_date       date,
  allocated_loan_value numeric(12,2) NOT NULL DEFAULT 0,
  storage              jsonb NOT NULL DEFAULT '{}'::jsonb,     -- room, cabinet, shelf, bin, container, seal
  status               text NOT NULL DEFAULT 'pending_intake' CHECK (status IN ('pending_intake', 'in_custody', 'reserved_for_redemption', 'released', 'forfeiture_review', 'lawfully_acquired', 'transferred_to_inventory')),
  inventory_id         uuid,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pawn_collateral_code_key UNIQUE (store_id, collateral_code)
);
CREATE INDEX IF NOT EXISTS pawn_collateral_loan_idx ON public.pawn_collateral (loan_id);

-- Executed agreements: written once, never changed (trigger below).
CREATE TABLE IF NOT EXISTS public.pawn_agreements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id          uuid NOT NULL REFERENCES public.pawn_loans(id) ON DELETE CASCADE,
  store_id         uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('original', 'renewal', 'amendment')),
  loan_version     integer NOT NULL,
  document_html    text NOT NULL,
  document_sha256  text NOT NULL,
  terms            jsonb NOT NULL,
  signature_method text NOT NULL CHECK (signature_method IN ('electronic', 'paper')),
  customer_signature text,                   -- typed name (electronic) or "signed on paper"
  employee_id      uuid,
  actor_user       uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pawn_agreements_loan_idx ON public.pawn_agreements (loan_id, created_at);

-- Financial ledger (append-only). Amounts from the store's point of view:
-- disbursement -principal, payments +, reversal +principal.
CREATE TABLE IF NOT EXISTS public.pawn_ledger (
  id              bigserial PRIMARY KEY,
  loan_id         uuid NOT NULL REFERENCES public.pawn_loans(id) ON DELETE CASCADE,
  store_id        uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  request_id      uuid UNIQUE,
  entry_type      text NOT NULL CHECK (entry_type IN ('disbursement', 'fee_assessed', 'charges_accrued', 'payment', 'renewal', 'reversal', 'forfeiture', 'correction')),
  amount          numeric(12,2) NOT NULL DEFAULT 0,      -- cash in (+) / out (-)
  principal_part  numeric(12,2) NOT NULL DEFAULT 0,      -- change to principal outstanding
  charges_part    numeric(12,2) NOT NULL DEFAULT 0,      -- change to charges unpaid
  method          text,
  reference       text,
  transaction_id  uuid REFERENCES public.store_transactions(id) ON DELETE SET NULL,
  principal_after numeric(12,2),
  charges_after   numeric(12,2),
  note            text,
  employee_id     uuid,
  actor_user      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pawn_ledger_loan_idx ON public.pawn_ledger (loan_id, created_at);
CREATE INDEX IF NOT EXISTS pawn_ledger_store_idx ON public.pawn_ledger (store_id, created_at);

CREATE TABLE IF NOT EXISTS public.pawn_events (
  id            bigserial PRIMARY KEY,
  loan_id       uuid NOT NULL REFERENCES public.pawn_loans(id) ON DELETE CASCADE,
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  collateral_id uuid,
  action        text NOT NULL,
  reason        text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  employee_id   uuid,
  actor_user    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pawn_events_loan_idx ON public.pawn_events (loan_id, created_at);

-- Notices (and their delivery attempts) recorded by staff.
CREATE TABLE IF NOT EXISTS public.pawn_notices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id       uuid NOT NULL REFERENCES public.pawn_loans(id) ON DELETE CASCADE,
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('due_reminder', 'overdue_notice', 'forfeiture_notice', 'other')),
  method        text NOT NULL,                  -- mail, email, phone, in_person, other
  sent_at       timestamptz NOT NULL,
  delivery      text NOT NULL DEFAULT 'sent' CHECK (delivery IN ('sent', 'delivered', 'failed', 'returned')),
  note          text,
  employee_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pawn_configs', 'pawn_store_settings', 'pawn_counters', 'pawn_loans', 'pawn_collateral', 'pawn_agreements', 'pawn_ledger', 'pawn_events', 'pawn_notices'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- Agreements, the ledger and events can't be edited or deleted (cascade from a deleted store excepted).
CREATE OR REPLACE FUNCTION public.pawn_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% records can''t be changed or deleted.', TG_TABLE_NAME;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pawn_agreements', 'pawn_ledger', 'pawn_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pawn_append_only()', t || '_append_only', t);
  END LOOP;
END $$;

-- Collateral photos (private bucket; folder = store id).
INSERT INTO storage.buckets (id, name, public) VALUES ('pawn-collateral', 'pawn-collateral', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'pawn_collateral_insert') THEN
    CREATE POLICY pawn_collateral_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'pawn-collateral' AND (NULLIF((storage.foldername(name))[1], ''))::uuid IN (SELECT public.user_store_ids()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'pawn_collateral_select') THEN
    CREATE POLICY pawn_collateral_select ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'pawn-collateral' AND (NULLIF((storage.foldername(name))[1], ''))::uuid IN (SELECT public.user_store_ids()));
  END IF;
END $$;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Shared with transactions.sql (same definitions), so this file also runs on its own.
CREATE OR REPLACE FUNCTION public.tx_store_tz(p_store_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT l.time_zone FROM public.store_locations l WHERE l.store_id = p_store_id AND NULLIF(l.time_zone, '') IS NOT NULL
                    AND EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = l.time_zone) ORDER BY l.created_at LIMIT 1), 'America/Halifax')
$$;
REVOKE ALL ON FUNCTION public.tx_store_tz(uuid) FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.tx_employee_name(p_employee uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username) FROM public.store_employees e WHERE e.id = p_employee
$$;
REVOKE ALL ON FUNCTION public.tx_employee_name(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pawn_is_boss(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND (s.owner_user_id = auth.uid() OR s.organization_id IN (SELECT public.user_org_ids())))
$$;
REVOKE ALL ON FUNCTION public.pawn_is_boss(uuid) FROM PUBLIC, anon, authenticated;

-- What a role gets unless the employee's own settings say otherwise.
CREATE OR REPLACE FUNCTION public.pawn_role_defaults(p_role text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_role, '')) IN ('owner', 'manager', 'store_manager') THEN
      '{"pawn_view":true,"pawn_create":true,"pawn_approve":true,"pawn_disburse":true,"pawn_payments":true,"pawn_renew":true,"pawn_release":true,"pawn_overdue":true,"pawn_forfeit":false,"pawn_transfer":false,"pawn_reports":true}'::jsonb
    WHEN lower(COALESCE(p_role, '')) IN ('assistant_manager', 'supervisor') THEN
      '{"pawn_view":true,"pawn_create":true,"pawn_approve":false,"pawn_disburse":false,"pawn_payments":true,"pawn_renew":true,"pawn_release":true,"pawn_overdue":true,"pawn_forfeit":false,"pawn_transfer":false,"pawn_reports":true}'::jsonb
    ELSE '{}'::jsonb END
$$;

-- An employee's effective permissions: role defaults, then their own true / false settings.
CREATE OR REPLACE FUNCTION public.pawn_effective(p_role text, p_perm jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; out jsonb := '{}'::jsonb; v_def jsonb := public.pawn_role_defaults(p_role);
BEGIN
  FOREACH k IN ARRAY ARRAY['pawn_view', 'pawn_create', 'pawn_approve', 'pawn_disburse', 'pawn_payments', 'pawn_renew', 'pawn_release', 'pawn_overdue', 'pawn_forfeit', 'pawn_transfer', 'pawn_reports'] LOOP
    out := out || jsonb_build_object(k, CASE WHEN COALESCE(p_perm, '{}'::jsonb) ? k THEN (p_perm ->> k) = 'true' ELSE COALESCE((v_def ->> k)::boolean, false) END);
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION public.pawn_perms(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_boss boolean := public.pawn_is_boss(p_store_id); v_perm jsonb; v_role text; out jsonb; k text;
BEGIN
  SELECT COALESCE(e.action_permissions, e.permissions, '{}'::jsonb), e.role INTO v_perm, v_role FROM public.store_employees e WHERE e.id = public.current_store_employee_id(p_store_id);
  out := public.pawn_effective(v_role, v_perm);
  IF v_boss THEN
    FOREACH k IN ARRAY ARRAY['pawn_view', 'pawn_create', 'pawn_approve', 'pawn_disburse', 'pawn_payments', 'pawn_renew', 'pawn_release', 'pawn_overdue', 'pawn_forfeit', 'pawn_transfer', 'pawn_reports'] LOOP
      out := out || jsonb_build_object(k, true);
    END LOOP;
  END IF;
  -- admin: may manage pawn settings and staff permissions.
  RETURN out || jsonb_build_object('boss', v_boss, 'admin', v_boss, 'role', v_role);
END $$;
REVOKE ALL ON FUNCTION public.pawn_perms(uuid) FROM PUBLIC, anon, authenticated;

-- Pawn settings: the organization that runs the store, or the store owner (from the org login).
CREATE OR REPLACE FUNCTION public.pawn_require_boss(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_store_id IS NULL OR NOT public.pawn_is_boss(p_store_id) THEN
    RAISE EXCEPTION 'Pawn settings are managed by the organization (Org portal → Stores → Pawn).';
  END IF;
  RETURN public.pawn_perms(p_store_id);
END $$;
REVOKE ALL ON FUNCTION public.pawn_require_boss(uuid) FROM PUBLIC, anon, authenticated;

-- Staff of the store, feature on, and (optionally) a permission. Returns the permissions.
CREATE OR REPLACE FUNCTION public.pawn_require(p_store_id uuid, p_perm text DEFAULT 'pawn_view')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_features f WHERE f.store_id = p_store_id AND f.feature = 'pawns_loans' AND f.enabled) THEN
    RAISE EXCEPTION 'Pawn & Loans isn''t turned on for this store.';
  END IF;
  v := public.pawn_perms(p_store_id);
  IF p_perm IS NOT NULL AND NOT COALESCE((v ->> p_perm)::boolean, false) THEN
    RAISE EXCEPTION 'You don''t have the "%" permission for Pawn & Loans.', replace(p_perm, 'pawn_', '');
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.pawn_require(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pawn_event(p_loan uuid, p_store uuid, p_action text, p_reason text DEFAULT NULL, p_detail jsonb DEFAULT '{}'::jsonb, p_collateral uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.pawn_events (loan_id, store_id, collateral_id, action, reason, detail, employee_id, actor_user)
  VALUES (p_loan, p_store, p_collateral, p_action, NULLIF(btrim(COALESCE(p_reason, '')), ''), COALESCE(p_detail, '{}'::jsonb), public.current_store_employee_id(p_store), auth.uid());
$$;
REVOKE ALL ON FUNCTION public.pawn_event(uuid, uuid, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pawn_today(p_store_id uuid)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (now() AT TIME ZONE public.tx_store_tz(p_store_id))::date
$$;
REVOKE ALL ON FUNCTION public.pawn_today(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pawn_html(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(replace(replace(COALESCE(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;
CREATE OR REPLACE FUNCTION public.pawn_money(p numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT to_char(COALESCE(p, 0), 'FM$999,999,990.00') $$;

-- Configuration fields that must be filled in before a configuration can be approved.
CREATE OR REPLACE FUNCTION public.pawn_config_missing(p_rules jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN NULLIF(p_rules ->> 'term_days_max', '') IS NULL THEN 'Maximum loan term' END,
    CASE WHEN NULLIF(p_rules ->> 'term_days_default', '') IS NULL THEN 'Standard loan term' END,
    CASE WHEN NULLIF(p_rules ->> 'interest_monthly_pct_max', '') IS NULL THEN 'Maximum interest rate' END,
    CASE WHEN NULLIF(p_rules ->> 'grace_days', '') IS NULL THEN 'Grace period' END,
    CASE WHEN NULLIF(p_rules ->> 'forfeiture_wait_days', '') IS NULL THEN 'Forfeiture waiting period' END,
    CASE WHEN p_rules ->> 'forfeiture_notice_required' IS NULL THEN 'Whether a forfeiture notice is required' END,
    CASE WHEN p_rules ->> 'partial_payments_allowed' IS NULL THEN 'Whether partial payments are allowed' END,
    CASE WHEN p_rules ->> 'renewals_allowed' IS NULL THEN 'Whether renewals are allowed' END,
    CASE WHEN jsonb_typeof(p_rules -> 'id_fields') IS DISTINCT FROM 'array' THEN 'Identification required' END,
    CASE WHEN NULLIF(btrim(p_rules ->> 'disclosures'), '') IS NULL THEN 'Required disclosures' END,
    CASE WHEN NULLIF(btrim(p_rules ->> 'agreement_template'), '') IS NULL THEN 'Approved agreement template' END
  ], NULL)
$$;

-- Can this store issue loans right now? test_mode = a test store (test loans only).
-- Canadian provinces and territories (pawn rules are set per province / territory).
CREATE OR REPLACE FUNCTION public.pawn_province_name(p_code text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT name FROM (VALUES ('NS', 'Nova Scotia'), ('PE', 'Prince Edward Island'), ('NB', 'New Brunswick'), ('NL', 'Newfoundland and Labrador'), ('QC', 'Quebec'),
                           ('ON', 'Ontario'), ('MB', 'Manitoba'), ('SK', 'Saskatchewan'), ('AB', 'Alberta'), ('BC', 'British Columbia'),
                           ('YT', 'Yukon'), ('NT', 'Northwest Territories'), ('NU', 'Nunavut')) p(code, name)
   WHERE code = upper(regexp_replace(COALESCE(p_code, ''), '^CA-', '', 'i'))
$$;

-- A province written as a code or a name -> its 2-letter code.
CREATE OR REPLACE FUNCTION public.pawn_province_code(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT code FROM (VALUES ('NS', 'NOVA SCOTIA'), ('PE', 'PRINCE EDWARD ISLAND'), ('NB', 'NEW BRUNSWICK'), ('NL', 'NEWFOUNDLAND AND LABRADOR'), ('QC', 'QUEBEC'),
                           ('ON', 'ONTARIO'), ('MB', 'MANITOBA'), ('SK', 'SASKATCHEWAN'), ('AB', 'ALBERTA'), ('BC', 'BRITISH COLUMBIA'),
                           ('YT', 'YUKON'), ('NT', 'NORTHWEST TERRITORIES'), ('NU', 'NUNAVUT')) p(code, name)
   WHERE code = upper(btrim(COALESCE(p_value, ''))) OR name = upper(btrim(COALESCE(p_value, ''))) OR (upper(btrim(COALESCE(p_value, ''))) = 'PEI' AND code = 'PE')
   LIMIT 1
$$;

-- The store's jurisdiction: the province of the Region chosen when the store was created
-- (stores.notification_region_id). "Northern Canada" spans three territories, so it (and a
-- store with no region) falls back to the province on the store's location address.
CREATE OR REPLACE FUNCTION public.pawn_store_jurisdiction(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_region text; v_code text; v_source text := 'region';
BEGIN
  SELECT lower(COALESCE(notification_region_id, '')) INTO v_region FROM public.stores WHERE id = p_store_id;
  v_code := CASE
    WHEN v_region = 'ca-ns' THEN 'NS' WHEN v_region = 'ca-pei' THEN 'PE' WHEN v_region = 'ca-nb' THEN 'NB'
    WHEN v_region LIKE 'ca-nl%' THEN 'NL' WHEN v_region LIKE 'ca-qc%' THEN 'QC' WHEN v_region LIKE 'ca-on%' THEN 'ON'
    WHEN v_region LIKE 'ca-bc%' OR v_region LIKE 'ca-vancouver%' THEN 'BC'
    WHEN v_region LIKE 'ca-ab%' OR v_region IN ('ca-calgary', 'ca-edmonton') THEN 'AB'
    WHEN v_region LIKE 'ca-sk%' THEN 'SK' WHEN v_region LIKE 'ca-mb%' OR v_region = 'ca-winnipeg' THEN 'MB' END;
  IF v_code IS NULL THEN
    v_source := 'address';
    SELECT public.pawn_province_code(l.province) INTO v_code FROM public.store_locations l
     WHERE l.store_id = p_store_id AND public.pawn_province_code(l.province) IS NOT NULL ORDER BY l.created_at LIMIT 1;
  END IF;
  IF v_code IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('code', 'CA-' || v_code, 'name', public.pawn_province_name(v_code), 'source', v_source, 'region', NULLIF(v_region, ''));
END $$;
REVOKE ALL ON FUNCTION public.pawn_store_jurisdiction(uuid) FROM PUBLIC, anon, authenticated;

-- The configuration a store uses: CollectorsHub's one for the store's jurisdiction
-- (approved first, then test, then draft). Stores and organizations don't make their own.
CREATE OR REPLACE FUNCTION public.pawn_store_config(p_store_id uuid)
RETURNS public.pawn_configs LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.* FROM public.pawn_configs c JOIN public.stores s ON s.id = p_store_id
   WHERE c.organization_id IS NULL AND c.store_id IS NULL AND s.id IS NOT NULL
     AND c.status <> 'retired' AND upper(c.jurisdiction) = public.pawn_store_jurisdiction(p_store_id) ->> 'code'
   ORDER BY CASE c.status WHEN 'approved' THEN 0 WHEN 'test' THEN 1 ELSE 2 END, c.updated_at DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.pawn_store_config(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pawn_readiness(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.pawn_store_settings; c public.pawn_configs; v_test boolean; v_reasons text[] := '{}'; v_j jsonb := public.pawn_store_jurisdiction(p_store_id);
BEGIN
  SELECT COALESCE(is_test_store, false) INTO v_test FROM public.stores WHERE id = p_store_id;
  SELECT * INTO s FROM public.pawn_store_settings WHERE store_id = p_store_id;
  c := public.pawn_store_config(p_store_id);
  IF NOT EXISTS (SELECT 1 FROM public.store_features f WHERE f.store_id = p_store_id AND f.feature = 'pawns_loans' AND f.enabled) THEN v_reasons := v_reasons || 'Pawns & Loans is turned off for this store (organization → Features).'::text; END IF;
  IF v_j IS NULL THEN v_reasons := v_reasons || 'The store''s region (province) isn''t set (Org portal → Stores).'::text;
  ELSIF c.id IS NULL THEN v_reasons := v_reasons || ('CollectorsHub hasn''t set pawn terms for ' || (v_j ->> 'name') || ' yet.'); END IF;
  IF v_test THEN
    IF c.id IS NOT NULL AND c.status = 'retired' THEN v_reasons := v_reasons || 'The configuration is retired.'::text; END IF;
  ELSE
    IF NOT COALESCE(s.lending_enabled, false) THEN v_reasons := v_reasons || 'Pawn lending is not enabled for this store.'::text; END IF;
    IF c.id IS NOT NULL AND c.status <> 'approved' THEN v_reasons := v_reasons || 'The configuration hasn''t been approved after legal review.'::text; END IF;
    IF c.id IS NOT NULL AND COALESCE((c.rules ->> 'licence_required')::boolean, true) AND NOT COALESCE(s.licence_verified, false) THEN v_reasons := v_reasons || 'The store''s lending licence hasn''t been verified.'::text; END IF;
  END IF;
  IF c.id IS NOT NULL AND array_length(public.pawn_config_missing(c.rules), 1) > 0 AND NOT v_test THEN
    v_reasons := v_reasons || ('The configuration is missing: ' || array_to_string(public.pawn_config_missing(c.rules), ', ') || '.');
  END IF;
  IF s.interest_monthly_pct IS NOT NULL AND c.id IS NOT NULL AND NULLIF(c.rules ->> 'interest_monthly_pct_max', '') IS NOT NULL
     AND s.interest_monthly_pct > (c.rules ->> 'interest_monthly_pct_max')::numeric THEN
    v_reasons := v_reasons || 'The store''s interest rate is above the configuration''s maximum.'::text;
  END IF;
  RETURN jsonb_build_object('ready', COALESCE(array_length(v_reasons, 1), 0) = 0, 'test_mode', v_test, 'reasons', to_jsonb(v_reasons), 'jurisdiction', v_j,
                            'config', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id', c.id, 'name', c.name, 'jurisdiction', c.jurisdiction, 'status', c.status, 'rules', c.rules) END,
                            'settings', CASE WHEN s.store_id IS NULL THEN NULL ELSE to_jsonb(s) END);
END $$;
REVOKE ALL ON FUNCTION public.pawn_readiness(uuid) FROM PUBLIC, anon, authenticated;

-- Terms for a principal / term / rate under the store's configuration (also used for quotes).
CREATE OR REPLACE FUNCTION public.pawn_compute_terms(p_store_id uuid, p_principal numeric, p_term_days integer, p_issue date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r jsonb := public.pawn_readiness(p_store_id); v_rules jsonb; v_rate numeric; v_max_rate numeric; v_term integer; v_fee jsonb; v_fee_amt numeric;
        v_fees jsonb := '[]'::jsonb; v_fee_total numeric := 0; v_interest numeric; v_cap numeric; v_due date;
BEGIN
  IF r -> 'config' IS NULL OR r -> 'config' = 'null'::jsonb THEN
    RAISE EXCEPTION '%', CASE WHEN r -> 'jurisdiction' IS NULL OR r -> 'jurisdiction' = 'null'::jsonb
      THEN 'This store has no Region (province) set, so no pawn configuration applies. Set the store''s Region in the Org portal (Stores).'
      ELSE 'CollectorsHub hasn''t set pawn terms for ' || (r -> 'jurisdiction' ->> 'name') || ' (' || (r -> 'jurisdiction' ->> 'code') || '), this store''s Region, yet.' END;
  END IF;
  v_rules := r -> 'config' -> 'rules';
  IF COALESCE(p_principal, 0) <= 0 THEN RAISE EXCEPTION 'Enter the loan amount.'; END IF;
  IF NULLIF(v_rules ->> 'min_principal', '') IS NOT NULL AND p_principal < (v_rules ->> 'min_principal')::numeric THEN RAISE EXCEPTION 'The loan is below the configured minimum of %.', public.pawn_money((v_rules ->> 'min_principal')::numeric); END IF;
  IF NULLIF(v_rules ->> 'max_principal', '') IS NOT NULL AND p_principal > (v_rules ->> 'max_principal')::numeric THEN RAISE EXCEPTION 'The loan is above the configured maximum of %.', public.pawn_money((v_rules ->> 'max_principal')::numeric); END IF;
  v_term := COALESCE(p_term_days, NULLIF(v_rules ->> 'term_days_default', '')::integer);
  IF v_term IS NULL OR v_term < 1 THEN RAISE EXCEPTION 'The configuration has no loan term.'; END IF;
  IF NULLIF(v_rules ->> 'term_days_max', '') IS NOT NULL AND v_term > (v_rules ->> 'term_days_max')::integer THEN RAISE EXCEPTION 'The term is longer than the configured maximum of % days.', v_rules ->> 'term_days_max'; END IF;
  v_max_rate := NULLIF(v_rules ->> 'interest_monthly_pct_max', '')::numeric;
  v_rate := COALESCE((r -> 'settings' ->> 'interest_monthly_pct')::numeric, v_max_rate, 0);
  IF v_max_rate IS NOT NULL AND v_rate > v_max_rate THEN v_rate := v_max_rate; END IF;
  v_due := p_issue + v_term;
  FOR v_fee IN SELECT * FROM jsonb_array_elements(COALESCE(v_rules -> 'fees', '[]'::jsonb)) LOOP
    v_fee_amt := CASE WHEN v_fee ->> 'basis' = 'percent' THEN round(p_principal * COALESCE((v_fee ->> 'amount')::numeric, 0) / 100, 2) ELSE COALESCE((v_fee ->> 'amount')::numeric, 0) END;
    IF NULLIF(v_fee ->> 'max', '') IS NOT NULL THEN v_fee_amt := LEAST(v_fee_amt, (v_fee ->> 'max')::numeric); END IF;
    v_fees := v_fees || jsonb_build_object('code', v_fee ->> 'code', 'label', COALESCE(v_fee ->> 'label', v_fee ->> 'code'), 'amount', v_fee_amt);
    v_fee_total := v_fee_total + v_fee_amt;
  END LOOP;
  -- Simple interest on the principal for the term: monthly rate / 30 per day.
  v_interest := round(p_principal * v_rate / 100 / 30 * v_term, 2);
  v_cap := NULLIF(v_rules ->> 'charges_cap_pct_of_principal', '')::numeric;
  IF v_cap IS NOT NULL AND v_interest + v_fee_total > round(p_principal * v_cap / 100, 2) THEN
    v_interest := GREATEST(round(p_principal * v_cap / 100, 2) - v_fee_total, 0);
  END IF;
  RETURN jsonb_build_object(
    'principal', round(p_principal, 2), 'term_days', v_term, 'issue_date', p_issue, 'due_date', v_due,
    'interest_monthly_pct', v_rate, 'interest_for_term', v_interest, 'fees', v_fees, 'fees_total', v_fee_total,
    'cost_of_borrowing', v_interest + v_fee_total, 'redemption_at_due', round(p_principal + v_interest + v_fee_total, 2),
    'grace_days', NULLIF(v_rules ->> 'grace_days', '')::integer, 'forfeiture_wait_days', NULLIF(v_rules ->> 'forfeiture_wait_days', '')::integer,
    'charges_after_due', COALESCE((v_rules ->> 'charges_after_due')::boolean, false), 'charges_cap_pct_of_principal', v_cap,
    'partial_payments_allowed', (v_rules ->> 'partial_payments_allowed')::boolean, 'renewals_allowed', (v_rules ->> 'renewals_allowed')::boolean,
    'max_renewals', NULLIF(v_rules ->> 'max_renewals', '')::integer, 'disclosures', v_rules ->> 'disclosures',
    'config_id', r -> 'config' ->> 'id', 'config_name', r -> 'config' ->> 'name', 'jurisdiction', r -> 'config' ->> 'jurisdiction', 'config_status', r -> 'config' ->> 'status');
END $$;
REVOKE ALL ON FUNCTION public.pawn_compute_terms(uuid, numeric, integer, date) FROM PUBLIC, anon, authenticated;

-- Charges accrued since the last accrual (not stored): simple daily interest on the
-- outstanding principal, stopping at the due date unless the configuration allows
-- charges after it, and never above the configured cap.
CREATE OR REPLACE FUNCTION public.pawn_accrual(l public.pawn_loans, p_as_of date)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_until date; v_days integer; v_amt numeric; v_cap numeric;
BEGIN
  IF l.status NOT IN ('active', 'forfeiture_review') OR l.charges_accrued_to IS NULL OR l.terms IS NULL THEN RETURN 0; END IF;
  v_until := CASE WHEN COALESCE((l.terms ->> 'charges_after_due')::boolean, false) THEN p_as_of ELSE LEAST(p_as_of, l.due_date) END;
  v_days := GREATEST(v_until - l.charges_accrued_to, 0);
  v_amt := round(l.principal_outstanding * COALESCE(l.interest_monthly_pct, 0) / 100 / 30 * v_days, 2);
  v_cap := NULLIF(l.terms ->> 'charges_cap_pct_of_principal', '')::numeric;
  IF v_cap IS NOT NULL THEN v_amt := LEAST(v_amt, GREATEST(round(l.principal * v_cap / 100, 2) - l.charges_assessed_total, 0)); END IF;
  RETURN GREATEST(v_amt, 0);
END $$;
REVOKE ALL ON FUNCTION public.pawn_accrual(public.pawn_loans, date) FROM PUBLIC, anon, authenticated;

-- Brings stored charges up to date (inside a locked operation).
CREATE OR REPLACE FUNCTION public.pawn_accrue(p_loan_id uuid)
RETURNS public.pawn_loans LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l public.pawn_loans; v_today date; v_amt numeric;
BEGIN
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id;
  v_today := public.pawn_today(l.store_id);
  v_amt := public.pawn_accrual(l, v_today);
  IF v_amt > 0 THEN
    UPDATE public.pawn_loans SET charges_unpaid = charges_unpaid + v_amt, charges_assessed_total = charges_assessed_total + v_amt, charges_accrued_to = v_today, updated_at = now()
     WHERE id = l.id RETURNING * INTO l;
    INSERT INTO public.pawn_ledger (loan_id, store_id, entry_type, amount, charges_part, principal_after, charges_after, note, employee_id, actor_user)
    VALUES (l.id, l.store_id, 'charges_accrued', 0, v_amt, l.principal_outstanding, l.charges_unpaid, 'Interest to ' || v_today, public.current_store_employee_id(l.store_id), auth.uid());
  ELSIF l.charges_accrued_to IS NOT NULL AND l.charges_accrued_to < v_today AND l.status IN ('active', 'forfeiture_review') THEN
    UPDATE public.pawn_loans SET charges_accrued_to = LEAST(v_today, CASE WHEN COALESCE((terms ->> 'charges_after_due')::boolean, false) THEN v_today ELSE GREATEST(due_date, charges_accrued_to) END) WHERE id = l.id RETURNING * INTO l;
  END IF;
  RETURN l;
END $$;
REVOKE ALL ON FUNCTION public.pawn_accrue(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pawn_balance(l public.pawn_loans)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_acc numeric := public.pawn_accrual(l, public.pawn_today(l.store_id));
BEGIN
  RETURN jsonb_build_object('principal_outstanding', l.principal_outstanding, 'charges_unpaid', l.charges_unpaid + v_acc, 'accrued_not_posted', v_acc,
                            'redemption_amount', l.principal_outstanding + l.charges_unpaid + v_acc);
END $$;
REVOKE ALL ON FUNCTION public.pawn_balance(public.pawn_loans) FROM PUBLIC, anon, authenticated;

-- Display state: draft | approved | active | due_soon | overdue | redeemed | forfeiture_review | forfeited | cancelled
CREATE OR REPLACE FUNCTION public.pawn_state(l public.pawn_loans, p_today date, p_soon integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN l.status <> 'active' THEN l.status
              WHEN l.due_date < p_today THEN 'overdue'
              WHEN l.due_date <= p_today + p_soon THEN 'due_soon'
              ELSE 'active' END
$$;

-- A pawn money movement in the store's transaction ledger (and so the cash drawer).
CREATE OR REPLACE FUNCTION public.pawn_record_transaction(l public.pawn_loans, p_type text, p_amount numeric, p_method text, p_reference text, p_principal_part numeric, p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_no text; v_loc uuid;
BEGIN
  v_loc := COALESCE(l.location_id, (SELECT id FROM public.store_locations WHERE store_id = l.store_id ORDER BY created_at LIMIT 1));
  v_no := 'TXN-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.store_transaction_number_seq')::text, 5, '0');
  INSERT INTO public.store_transactions (store_id, location_id, employee_id, customer_id, transaction_number, transaction_type, status, subtotal, total, notes, completed_at)
  VALUES (l.store_id, v_loc, public.current_store_employee_id(l.store_id), l.customer_id, v_no, p_type, 'completed', COALESCE(p_principal_part, 0), p_amount,
          concat_ws(' · ', CASE WHEN l.is_test THEN 'TEST' END, 'Pawn ' || l.loan_number, NULLIF(p_note, '')), now())
  RETURNING id INTO v_id;
  IF COALESCE(p_amount, 0) <> 0 THEN
    INSERT INTO public.store_transaction_payments (transaction_id, method, amount, reference) VALUES (v_id, p_method, p_amount, NULLIF(p_reference, ''));
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.pawn_record_transaction(public.pawn_loans, text, numeric, text, text, numeric, text) FROM PUBLIC, anon, authenticated;

-- Cash needs an open register at the location (so the drawer accounts for it).
CREATE OR REPLACE FUNCTION public.pawn_require_drawer(l public.pawn_loans, p_method text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_method = 'cash' AND NOT EXISTS (SELECT 1 FROM public.store_register_shifts sh WHERE sh.store_id = l.store_id AND sh.status = 'open'
                                        AND (l.location_id IS NULL OR sh.location_id = l.location_id)) THEN
    RAISE EXCEPTION 'Open the register first: cash for pawn loans goes through the cash drawer.';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.pawn_require_drawer(public.pawn_loans, text) FROM PUBLIC, anon, authenticated;

-- ── Settings, configurations and permissions (store owner / organization) ────
CREATE OR REPLACE FUNCTION public.pawn_settings(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require_boss(p_store_id); v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.stores WHERE id = p_store_id;
  RETURN jsonb_build_object(
    'feature_enabled', EXISTS (SELECT 1 FROM public.store_features f WHERE f.store_id = p_store_id AND f.feature = 'pawns_loans' AND f.enabled),
    'store_name', (SELECT store_name FROM public.stores WHERE id = p_store_id),
    'perms', v, 'readiness', public.pawn_readiness(p_store_id),
    'employees', CASE WHEN (v ->> 'admin')::boolean THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'name', public.tx_employee_name(e.id), 'role', e.role,
                   'permissions', public.pawn_effective(e.role, COALESCE(e.action_permissions, e.permissions, '{}'::jsonb)), 'defaults', public.pawn_role_defaults(e.role)) ORDER BY public.tx_employee_name(e.id))
                 FROM public.store_employees e WHERE e.store_id = p_store_id AND e.status IN ('active', 'invited')), '[]'::jsonb) END);
END $$;

-- ── Jurisdiction configurations: CollectorsHub (platform admin) only ─────────
-- One set for the whole platform, per province / territory. Stores and
-- organizations never create or change them; a store uses its Region's one.
CREATE OR REPLACE FUNCTION public.pawn_is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.subscription_tier = 'platform_admin')
$$;
REVOKE ALL ON FUNCTION public.pawn_is_platform_admin() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.pawn_config_save(uuid, jsonb);
DROP FUNCTION IF EXISTS public.pawn_config_approve(uuid, uuid, text, text, boolean);

CREATE OR REPLACE FUNCTION public.pawn_admin_configs()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.pawn_is_platform_admin() THEN RAISE EXCEPTION 'Only CollectorsHub administrators manage pawn jurisdictions.'; END IF;
  RETURN jsonb_build_object(
    'configs', COALESCE((SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object('missing', to_jsonb(public.pawn_config_missing(c.rules)), 'province', public.pawn_province_name(c.jurisdiction),
                           'stores', (SELECT count(*) FROM public.stores s WHERE public.pawn_store_jurisdiction(s.id) ->> 'code' = upper(c.jurisdiction))) ORDER BY c.jurisdiction, c.created_at)
                         FROM public.pawn_configs c WHERE c.organization_id IS NULL AND c.store_id IS NULL), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.pawn_admin_config_save(p_config jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := NULLIF(p_config ->> 'id', '')::uuid; c public.pawn_configs; v_status text := COALESCE(NULLIF(p_config ->> 'status', ''), 'draft'); v_j text;
BEGIN
  IF NOT public.pawn_is_platform_admin() THEN RAISE EXCEPTION 'Only CollectorsHub administrators manage pawn jurisdictions.'; END IF;
  IF public.pawn_province_name(p_config ->> 'jurisdiction') IS NULL THEN RAISE EXCEPTION 'Choose the province or territory.'; END IF;
  v_j := 'CA-' || upper(regexp_replace(p_config ->> 'jurisdiction', '^CA-', '', 'i'));
  IF v_status NOT IN ('draft', 'test', 'retired') THEN RAISE EXCEPTION 'Use "Approve after legal review" to approve a configuration.'; END IF;
  IF v_id IS NOT NULL THEN
    SELECT * INTO c FROM public.pawn_configs WHERE id = v_id AND organization_id IS NULL AND store_id IS NULL FOR UPDATE;
    IF c.id IS NULL THEN RAISE EXCEPTION 'Configuration not found.'; END IF;
    -- Changing an approved configuration's rules takes it back to draft until it's reviewed again.
    UPDATE public.pawn_configs SET name = COALESCE(NULLIF(btrim(p_config ->> 'name'), ''), name), jurisdiction = v_j, rules = COALESCE(p_config -> 'rules', rules),
           status = CASE WHEN c.status = 'approved' AND ((p_config -> 'rules') IS DISTINCT FROM c.rules OR v_j <> c.jurisdiction) THEN 'draft'
                         WHEN c.status = 'approved' AND v_status = 'draft' THEN 'approved' ELSE v_status END,
           reviewed_by = CASE WHEN c.status = 'approved' AND (p_config -> 'rules') IS DISTINCT FROM c.rules THEN NULL ELSE reviewed_by END,
           review_reference = CASE WHEN c.status = 'approved' AND (p_config -> 'rules') IS DISTINCT FROM c.rules THEN NULL ELSE review_reference END,
           reviewed_at = CASE WHEN c.status = 'approved' AND (p_config -> 'rules') IS DISTINCT FROM c.rules THEN NULL ELSE reviewed_at END,
           updated_at = now()
     WHERE id = v_id;
  ELSE
    INSERT INTO public.pawn_configs (organization_id, store_id, name, jurisdiction, status, rules, created_by)
    VALUES (NULL, NULL, COALESCE(NULLIF(btrim(p_config ->> 'name'), ''), public.pawn_province_name(v_j) || ' pawn terms'), v_j, v_status, COALESCE(p_config -> 'rules', '{}'::jsonb), auth.uid())
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.pawn_admin_config_approve(p_config_id uuid, p_reviewed_by text, p_reference text, p_confirm boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.pawn_configs;
BEGIN
  IF NOT public.pawn_is_platform_admin() THEN RAISE EXCEPTION 'Only CollectorsHub administrators approve pawn jurisdictions.'; END IF;
  IF NOT COALESCE(p_confirm, false) THEN RAISE EXCEPTION 'Confirm that the configuration and template were reviewed against the applicable law.'; END IF;
  IF NULLIF(btrim(COALESCE(p_reviewed_by, '')), '') IS NULL OR NULLIF(btrim(COALESCE(p_reference, '')), '') IS NULL THEN RAISE EXCEPTION 'Record who reviewed it and a reference (e.g. the legal opinion or file number).'; END IF;
  SELECT * INTO c FROM public.pawn_configs WHERE id = p_config_id AND organization_id IS NULL AND store_id IS NULL FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Configuration not found.'; END IF;
  IF array_length(public.pawn_config_missing(c.rules), 1) > 0 THEN RAISE EXCEPTION 'Fill in first: %.', array_to_string(public.pawn_config_missing(c.rules), ', '); END IF;
  -- One approved configuration per province: an earlier approved one is retired.
  UPDATE public.pawn_configs SET status = 'retired', updated_at = now() WHERE organization_id IS NULL AND store_id IS NULL AND jurisdiction = c.jurisdiction AND status = 'approved' AND id <> c.id;
  UPDATE public.pawn_configs SET status = 'approved', reviewed_by = btrim(p_reviewed_by), review_reference = btrim(p_reference), reviewed_at = now(), approved_by_user = auth.uid(), updated_at = now() WHERE id = c.id;
END $$;

GRANT EXECUTE ON FUNCTION public.pawn_admin_configs() TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_admin_config_save(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_admin_config_approve(uuid, text, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.pawn_settings_save(p_store_id uuid, p_settings jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require_boss(p_store_id); v_org uuid; v_config uuid := NULLIF(p_settings ->> 'config_id', '')::uuid; v_rate numeric := NULLIF(p_settings ->> 'interest_monthly_pct', '')::numeric;
        v_max numeric; s public.pawn_store_settings;
BEGIN
  SELECT organization_id INTO v_org FROM public.stores WHERE id = p_store_id;
  v_config := (public.pawn_store_config(p_store_id)).id;
  SELECT NULLIF(rules ->> 'interest_monthly_pct_max', '')::numeric INTO v_max FROM public.pawn_configs WHERE id = v_config;
  IF v_rate IS NOT NULL AND (v_rate < 0 OR (v_max IS NOT NULL AND v_rate > v_max)) THEN RAISE EXCEPTION 'The interest rate must be between 0 and the configuration''s maximum (% %% a month).', v_max; END IF;
  SELECT * INTO s FROM public.pawn_store_settings WHERE store_id = p_store_id;
  IF NOT (v ->> 'boss')::boolean THEN
    p_settings := p_settings || jsonb_build_object('lending_enabled', COALESCE(s.lending_enabled, false), 'licence_verified', COALESCE(s.licence_verified, false));
  END IF;
  INSERT INTO public.pawn_store_settings AS x (store_id, lending_enabled, config_id, interest_monthly_pct, licence_number, licence_verified, licence_verified_by, licence_verified_at, due_soon_days, updated_by, updated_at)
  VALUES (p_store_id, COALESCE((p_settings ->> 'lending_enabled')::boolean, false), v_config, v_rate, NULLIF(btrim(p_settings ->> 'licence_number'), ''),
          COALESCE((p_settings ->> 'licence_verified')::boolean, false),
          CASE WHEN COALESCE((p_settings ->> 'licence_verified')::boolean, false) THEN auth.uid() END, CASE WHEN COALESCE((p_settings ->> 'licence_verified')::boolean, false) THEN now() END,
          COALESCE(NULLIF(p_settings ->> 'due_soon_days', '')::integer, 7), auth.uid(), now())
  ON CONFLICT (store_id) DO UPDATE SET lending_enabled = EXCLUDED.lending_enabled, config_id = EXCLUDED.config_id, interest_monthly_pct = EXCLUDED.interest_monthly_pct,
    licence_number = EXCLUDED.licence_number, licence_verified = EXCLUDED.licence_verified,
    licence_verified_by = CASE WHEN EXCLUDED.licence_verified AND NOT x.licence_verified THEN auth.uid() WHEN EXCLUDED.licence_verified THEN x.licence_verified_by END,
    licence_verified_at = CASE WHEN EXCLUDED.licence_verified AND NOT x.licence_verified THEN now() WHEN EXCLUDED.licence_verified THEN x.licence_verified_at END,
    due_soon_days = EXCLUDED.due_soon_days, updated_by = auth.uid(), updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.pawn_set_employee_permissions(p_store_id uuid, p_employee_id uuid, p_permissions jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require_boss(p_store_id); v_clean jsonb := '{}'::jsonb; k text; v_old jsonb;
BEGIN
  FOREACH k IN ARRAY ARRAY['pawn_view', 'pawn_create', 'pawn_approve', 'pawn_disburse', 'pawn_payments', 'pawn_renew', 'pawn_release', 'pawn_overdue', 'pawn_forfeit', 'pawn_transfer', 'pawn_reports'] LOOP
    v_clean := v_clean || jsonb_build_object(k, COALESCE((p_permissions ->> k)::boolean, false));
  END LOOP;
  SELECT COALESCE(action_permissions, permissions, '{}'::jsonb) INTO v_old FROM public.store_employees WHERE id = p_employee_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found.'; END IF;
  UPDATE public.store_employees SET action_permissions = COALESCE(v_old, '{}'::jsonb) || v_clean WHERE id = p_employee_id;
END $$;

-- ── Dashboard, list, details ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pawn_summary(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_view'); v_today date := public.pawn_today(p_store_id); v_soon integer;
BEGIN
  SELECT COALESCE(due_soon_days, 7) INTO v_soon FROM public.pawn_store_settings WHERE store_id = p_store_id;
  v_soon := COALESCE(v_soon, 7);
  RETURN (SELECT jsonb_build_object(
      'active', count(*) FILTER (WHERE status = 'active'),
      'principal_outstanding', COALESCE(sum(principal_outstanding) FILTER (WHERE status IN ('active', 'forfeiture_review')), 0),
      'due_soon', count(*) FILTER (WHERE status = 'active' AND due_date >= v_today AND due_date <= v_today + v_soon),
      'overdue', count(*) FILTER (WHERE status = 'active' AND due_date < v_today),
      'forfeiture_review', count(*) FILTER (WHERE status = 'forfeiture_review'),
      'drafts', count(*) FILTER (WHERE status IN ('draft', 'approved')),
      'readiness', public.pawn_readiness(p_store_id), 'perms', v, 'due_soon_days', v_soon)
    FROM public.pawn_loans WHERE store_id = p_store_id);
END $$;

-- p_filter: all | active | due_soon | overdue | redeemed | forfeiture_review | forfeited | cancelled | drafts
CREATE OR REPLACE FUNCTION public.pawn_list(p_store_id uuid, p_filter text DEFAULT 'all', p_search text DEFAULT '', p_customer_id uuid DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_view'); v_today date := public.pawn_today(p_store_id); v_soon integer; v_q text := lower(btrim(COALESCE(p_search, '')));
BEGIN
  SELECT due_soon_days INTO v_soon FROM public.pawn_store_settings WHERE store_id = p_store_id;
  v_soon := COALESCE(v_soon, 7);
  RETURN (
    WITH base AS (
      SELECT l.*, public.pawn_state(l, v_today, v_soon) AS state
        FROM public.pawn_loans l
       WHERE l.store_id = p_store_id
         AND (p_customer_id IS NULL OR l.customer_id = p_customer_id)
         AND (v_q = '' OR lower(l.loan_number) LIKE '%' || v_q || '%'
              OR EXISTS (SELECT 1 FROM public.store_customers c LEFT JOIN public.profiles pr ON pr.id = c.collectorshub_user_id
                          WHERE c.id = l.customer_id AND (lower(concat_ws(' ', c.first_name, c.last_name, c.display_name)) LIKE '%' || v_q || '%'
                                OR lower(COALESCE(pr.username, '')) LIKE '%' || ltrim(v_q, '@') || '%' OR lower(COALESCE(c.customer_number, '')) = v_q))
              OR EXISTS (SELECT 1 FROM public.pawn_collateral k WHERE k.loan_id = l.id AND (lower(k.name) LIKE '%' || v_q || '%' OR lower(k.collateral_code) = v_q
                          OR lower(COALESCE(k.serial_number, '')) = v_q OR lower(COALESCE(k.catalog_item_id::text, '')) = v_q
                          OR lower(concat_ws(' ', k.storage ->> 'room', k.storage ->> 'cabinet', k.storage ->> 'shelf', k.storage ->> 'bin', k.storage ->> 'container', k.storage ->> 'seal')) LIKE '%' || v_q || '%')))
    ),
    filtered AS (
      SELECT * FROM base b WHERE CASE p_filter WHEN 'all' THEN true WHEN 'active' THEN b.status = 'active' WHEN 'drafts' THEN b.status IN ('draft', 'approved') ELSE b.state = p_filter END
    ),
    page AS (SELECT * FROM filtered ORDER BY CASE WHEN state = 'overdue' THEN 0 WHEN state = 'due_soon' THEN 1 ELSE 2 END, COALESCE(due_date, created_at::date) ASC, created_at DESC
             LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0))
    SELECT jsonb_build_object('total', (SELECT count(*) FROM filtered), 'perms', v, 'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'loan_number', p.loan_number, 'state', p.state, 'status', p.status, 'is_test', p.is_test, 'principal', p.principal,
        'balance', (SELECT public.pawn_balance(x) -> 'redemption_amount' FROM public.pawn_loans x WHERE x.id = p.id), 'principal_outstanding', p.principal_outstanding,
        'issue_date', p.issue_date, 'due_date', p.due_date, 'days_overdue', CASE WHEN p.status = 'active' AND p.due_date < v_today THEN v_today - p.due_date END,
        'legal_hold', p.legal_hold, 'employee', public.tx_employee_name(COALESCE(p.assigned_employee, p.created_by_employee)), 'created_at', p.created_at,
        'customer_id', p.customer_id,
        'customer', (SELECT COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), NULLIF(btrim(c.display_name), ''), pr.display_name, pr.username)
                       FROM public.store_customers c LEFT JOIN public.profiles pr ON pr.id = c.collectorshub_user_id WHERE c.id = p.customer_id),
        'username', (SELECT pr.username FROM public.store_customers c JOIN public.profiles pr ON pr.id = c.collectorshub_user_id WHERE c.id = p.customer_id),
        'collateral', (SELECT jsonb_build_object('count', count(*), 'first', min(k.name)) FROM public.pawn_collateral k WHERE k.loan_id = p.id))
      ) FROM page p), '[]'::jsonb))
  );
END $$;

CREATE OR REPLACE FUNCTION public.pawn_detail(p_store_id uuid, p_loan_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_view'); l public.pawn_loans; v_today date := public.pawn_today(p_store_id); v_soon integer; v_earliest date; v_rules jsonb;
BEGIN
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id;
  IF l.id IS NULL THEN RAISE EXCEPTION 'Loan not found.'; END IF;
  SELECT due_soon_days INTO v_soon FROM public.pawn_store_settings WHERE store_id = p_store_id;
  SELECT rules INTO v_rules FROM public.pawn_configs WHERE id = l.config_id;
  IF l.due_date IS NOT NULL AND NULLIF(l.terms ->> 'grace_days', '') IS NOT NULL AND NULLIF(l.terms ->> 'forfeiture_wait_days', '') IS NOT NULL THEN
    v_earliest := l.due_date + (l.terms ->> 'grace_days')::integer + (l.terms ->> 'forfeiture_wait_days')::integer;
  END IF;
  RETURN jsonb_build_object(
    'perms', v, 'readiness', public.pawn_readiness(p_store_id), 'today', v_today,
    'loan', to_jsonb(l) - 'borrower' || jsonb_build_object('state', public.pawn_state(l, v_today, COALESCE(v_soon, 7)), 'employee', public.tx_employee_name(COALESCE(l.assigned_employee, l.created_by_employee)),
              'approved_by', public.tx_employee_name(l.approved_by_employee), 'days_overdue', CASE WHEN l.status IN ('active', 'forfeiture_review') AND l.due_date < v_today THEN v_today - l.due_date END,
              'earliest_forfeiture', v_earliest),
    'borrower', l.borrower,
    'balance', public.pawn_balance(l),
    'config_rules', v_rules,
    'customer', (SELECT jsonb_build_object('id', c.id, 'customer_number', c.customer_number, 'is_member', c.collectorshub_user_id IS NOT NULL, 'profile_id', c.collectorshub_user_id,
                   'name', COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), NULLIF(btrim(c.display_name), ''), pr.display_name, pr.username),
                   'username', pr.username, 'email', c.email, 'phone', c.phone, 'address', c.address)
                   FROM public.store_customers c LEFT JOIN public.profiles pr ON pr.id = c.collectorshub_user_id WHERE c.id = l.customer_id),
    'collateral', COALESCE((SELECT jsonb_agg(to_jsonb(k) ORDER BY k.position) FROM public.pawn_collateral k WHERE k.loan_id = l.id), '[]'::jsonb),
    'ledger', COALESCE((SELECT jsonb_agg(to_jsonb(g) || jsonb_build_object('employee', public.tx_employee_name(g.employee_id), 'transaction_number', (SELECT t.transaction_number FROM public.store_transactions t WHERE t.id = g.transaction_id)) ORDER BY g.created_at, g.id)
                        FROM public.pawn_ledger g WHERE g.loan_id = l.id), '[]'::jsonb),
    'agreements', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'loan_version', a.loan_version, 'document_html', a.document_html, 'sha256', a.document_sha256,
                   'signature_method', a.signature_method, 'customer_signature', a.customer_signature, 'employee', public.tx_employee_name(a.employee_id), 'created_at', a.created_at) ORDER BY a.created_at)
                   FROM public.pawn_agreements a WHERE a.loan_id = l.id), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'reason', e.reason, 'detail', e.detail, 'employee', public.tx_employee_name(e.employee_id), 'created_at', e.created_at,
                   'collateral', (SELECT k.collateral_code FROM public.pawn_collateral k WHERE k.id = e.collateral_id)) ORDER BY e.created_at, e.id)
                   FROM public.pawn_events e WHERE e.loan_id = l.id), '[]'::jsonb),
    'notices', COALESCE((SELECT jsonb_agg(to_jsonb(n) || jsonb_build_object('employee', public.tx_employee_name(n.employee_id)) ORDER BY n.sent_at) FROM public.pawn_notices n WHERE n.loan_id = l.id), '[]'::jsonb)
  );
END $$;

-- ── Drafts ──────────────────────────────────────────────────────────────────
-- p_loan: { id?, version?, customer_id, borrower{}, principal, term_days, notes,
--           items: [{ id?, catalog_item_id, name, category, brand, model, serial_number, condition, description, quantity,
--                     photos[], estimated_value, valuation_source, valuation_date, allocated_loan_value, storage{}, notes }] }
CREATE OR REPLACE FUNCTION public.pawn_save_draft(p_store_id uuid, p_location_id uuid, p_loan jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_create'); l public.pawn_loans; v_id uuid := NULLIF(p_loan ->> 'id', '')::uuid; v_no integer; v_number text;
        v_item jsonb; v_pos integer := 0; v_keep uuid[] := '{}'; v_cid uuid; v_test boolean; v_fields jsonb; v_borrower jsonb := '{}'::jsonb; k text; v_customer uuid := NULLIF(p_loan ->> 'customer_id', '')::uuid;
BEGIN
  IF v_customer IS NULL OR NOT EXISTS (SELECT 1 FROM public.store_customers c WHERE c.id = v_customer AND c.store_id = p_store_id AND c.status <> 'merged') THEN RAISE EXCEPTION 'Choose the customer first.'; END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.store_locations WHERE id = p_location_id AND store_id = p_store_id) THEN p_location_id := NULL; END IF;
  SELECT COALESCE(is_test_store, false) INTO v_test FROM public.stores WHERE id = p_store_id;
  -- Keep only the identification fields the configuration asks for (plus how it was checked).
  SELECT c.rules -> 'id_fields' INTO v_fields FROM public.pawn_store_settings s JOIN public.pawn_configs c ON c.id = s.config_id WHERE s.store_id = p_store_id;
  FOR k IN SELECT jsonb_array_elements_text(COALESCE(v_fields, '["name","id_type"]'::jsonb)) UNION SELECT unnest(ARRAY['method', 'verified', 'checked_at']) LOOP
    IF p_loan -> 'borrower' ? k THEN v_borrower := v_borrower || jsonb_build_object(k, p_loan -> 'borrower' -> k); END IF;
  END LOOP;

  IF v_id IS NULL THEN
    INSERT INTO public.pawn_counters AS x (store_id, last) VALUES (p_store_id, 1) ON CONFLICT (store_id) DO UPDATE SET last = x.last + 1 RETURNING last INTO v_no;
    v_number := 'PL-' || to_char(now(), 'YYYY') || '-' || lpad(v_no::text, 6, '0');
    INSERT INTO public.pawn_loans (store_id, location_id, loan_number, customer_id, borrower, is_test, principal, term_days, notes, created_by_employee, assigned_employee)
    VALUES (p_store_id, p_location_id, v_number, v_customer, v_borrower, v_test, COALESCE(NULLIF(p_loan ->> 'principal', '')::numeric, 0), NULLIF(p_loan ->> 'term_days', '')::integer,
            NULLIF(btrim(p_loan ->> 'notes'), ''), public.current_store_employee_id(p_store_id), public.current_store_employee_id(p_store_id))
    RETURNING * INTO l;
    PERFORM public.pawn_event(l.id, p_store_id, 'draft_created', NULL, jsonb_build_object('test', v_test));
  ELSE
    SELECT * INTO l FROM public.pawn_loans WHERE id = v_id AND store_id = p_store_id FOR UPDATE;
    IF l.id IS NULL THEN RAISE EXCEPTION 'Loan not found.'; END IF;
    IF l.status NOT IN ('draft', 'approved') THEN RAISE EXCEPTION 'Only drafts can be changed.'; END IF;
    IF NULLIF(p_loan ->> 'version', '') IS NOT NULL AND (p_loan ->> 'version')::integer <> l.version THEN RAISE EXCEPTION 'This draft was changed by someone else. Reopen it and try again.'; END IF;
    UPDATE public.pawn_loans SET customer_id = v_customer, borrower = v_borrower, principal = COALESCE(NULLIF(p_loan ->> 'principal', '')::numeric, 0),
           term_days = NULLIF(p_loan ->> 'term_days', '')::integer, notes = NULLIF(btrim(p_loan ->> 'notes'), ''), location_id = COALESCE(p_location_id, location_id),
           -- Any change sends an approved draft back for approval.
           status = 'draft', terms = NULL, approved_at = NULL, approved_by_employee = NULL, approved_by_user = NULL, version = version + 1, updated_at = now()
     WHERE id = l.id RETURNING * INTO l;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_loan -> 'items', '[]'::jsonb)) LOOP
    v_pos := v_pos + 1;
    IF NULLIF(btrim(v_item ->> 'name'), '') IS NULL THEN RAISE EXCEPTION 'Every collateral item needs a name or description.'; END IF;
    v_cid := NULLIF(v_item ->> 'id', '')::uuid;
    IF v_cid IS NOT NULL AND EXISTS (SELECT 1 FROM public.pawn_collateral WHERE id = v_cid AND loan_id = l.id) THEN
      UPDATE public.pawn_collateral SET position = v_pos, catalog_item_id = NULLIF(v_item ->> 'catalog_item_id', '')::uuid, name = btrim(v_item ->> 'name'),
             category = NULLIF(v_item ->> 'category', ''), brand = NULLIF(v_item ->> 'brand', ''), model = NULLIF(v_item ->> 'model', ''), serial_number = NULLIF(btrim(v_item ->> 'serial_number'), ''),
             condition = NULLIF(v_item ->> 'condition', ''), description = NULLIF(v_item ->> 'description', ''), quantity = GREATEST(COALESCE(NULLIF(v_item ->> 'quantity', '')::integer, 1), 1),
             photos = COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item -> 'photos', '[]'::jsonb))), '{}'),
             estimated_value = NULLIF(v_item ->> 'estimated_value', '')::numeric, valuation_source = NULLIF(v_item ->> 'valuation_source', ''), valuation_date = NULLIF(v_item ->> 'valuation_date', '')::date,
             allocated_loan_value = COALESCE(NULLIF(v_item ->> 'allocated_loan_value', '')::numeric, 0), storage = COALESCE(v_item -> 'storage', '{}'::jsonb), notes = NULLIF(v_item ->> 'notes', ''), updated_at = now()
       WHERE id = v_cid;
    ELSE
      INSERT INTO public.pawn_collateral (loan_id, store_id, collateral_code, position, catalog_item_id, name, category, brand, model, serial_number, condition, description, quantity, photos,
                                          estimated_value, valuation_source, valuation_date, allocated_loan_value, storage, notes)
      VALUES (l.id, p_store_id, l.loan_number || '-' || lpad((SELECT COALESCE(max(substring(collateral_code FROM '-([0-9]+)$')::integer), 0) + 1 FROM public.pawn_collateral WHERE loan_id = l.id)::text, 2, '0'), v_pos,
              NULLIF(v_item ->> 'catalog_item_id', '')::uuid, btrim(v_item ->> 'name'), NULLIF(v_item ->> 'category', ''), NULLIF(v_item ->> 'brand', ''), NULLIF(v_item ->> 'model', ''),
              NULLIF(btrim(v_item ->> 'serial_number'), ''), NULLIF(v_item ->> 'condition', ''), NULLIF(v_item ->> 'description', ''), GREATEST(COALESCE(NULLIF(v_item ->> 'quantity', '')::integer, 1), 1),
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item -> 'photos', '[]'::jsonb))), '{}'),
              NULLIF(v_item ->> 'estimated_value', '')::numeric, NULLIF(v_item ->> 'valuation_source', ''), NULLIF(v_item ->> 'valuation_date', '')::date,
              COALESCE(NULLIF(v_item ->> 'allocated_loan_value', '')::numeric, 0), COALESCE(v_item -> 'storage', '{}'::jsonb), NULLIF(v_item ->> 'notes', ''))
      RETURNING id INTO v_cid;
    END IF;
    v_keep := v_keep || v_cid;
  END LOOP;
  DELETE FROM public.pawn_collateral WHERE loan_id = l.id AND NOT (id = ANY (v_keep));
  RETURN jsonb_build_object('id', l.id, 'loan_number', l.loan_number, 'version', l.version);
END $$;

CREATE OR REPLACE FUNCTION public.pawn_quote(p_store_id uuid, p_principal numeric, p_term_days integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pawn_require(p_store_id, 'pawn_create');
  RETURN public.pawn_compute_terms(p_store_id, p_principal, p_term_days, public.pawn_today(p_store_id));
END $$;

-- ── Agreement (rendered on the server from the configuration's template) ─────
CREATE OR REPLACE FUNCTION public.pawn_render_agreement(l public.pawn_loans, p_kind text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tpl text; v_rules jsonb; v_store record; v_customer text; v_items text; v_fees text; t jsonb := l.terms; v_html text;
BEGIN
  SELECT c.rules INTO v_rules FROM public.pawn_configs c WHERE c.id = l.config_id;
  SELECT s.store_name, concat_ws(', ', loc.street_address, loc.city, loc.province, loc.postal_code) AS address, ps.licence_number INTO v_store
    FROM public.stores s LEFT JOIN public.store_locations loc ON loc.id = l.location_id LEFT JOIN public.pawn_store_settings ps ON ps.store_id = s.id WHERE s.id = l.store_id;
  SELECT COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.display_name, 'Customer') || COALESCE(' (' || c.customer_number || ')', '') INTO v_customer
    FROM public.store_customers c WHERE c.id = l.customer_id;
  SELECT '<table class="pa-items"><thead><tr><th>Ref.</th><th>Item</th><th>Serial</th><th>Condition</th><th>Qty</th><th>Loan value</th></tr></thead><tbody>'
         || string_agg('<tr><td>' || public.pawn_html(k.collateral_code) || '</td><td>' || public.pawn_html(concat_ws(' · ', k.name, NULLIF(concat_ws(' ', k.brand, k.model), ''), k.description))
                       || '</td><td>' || public.pawn_html(COALESCE(k.serial_number, '—')) || '</td><td>' || public.pawn_html(COALESCE(k.condition, '—')) || '</td><td>' || k.quantity
                       || '</td><td>' || public.pawn_money(k.allocated_loan_value) || '</td></tr>', '' ORDER BY k.position) || '</tbody></table>'
    INTO v_items FROM public.pawn_collateral k WHERE k.loan_id = l.id;
  SELECT COALESCE(string_agg(public.pawn_html(f ->> 'label') || ': ' || public.pawn_money((f ->> 'amount')::numeric), '<br>'), 'None')
    INTO v_fees FROM jsonb_array_elements(COALESCE(t -> 'fees', '[]'::jsonb)) f;
  v_tpl := COALESCE(NULLIF(btrim(v_rules ->> 'agreement_template'), ''),
    '<h1>Pawn Agreement {{loan_number}}</h1><p class="pa-warning">No approved agreement template is configured. This layout is a placeholder and is not a legal agreement.</p>'
    || '<p><b>Lender:</b> {{store_name}}, {{store_address}} (licence {{licence_number}})<br><b>Borrower:</b> {{customer_name}}<br><b>Date:</b> {{issue_date}}</p>'
    || '<h2>Collateral</h2>{{collateral_table}}<h2>Loan</h2><p>Amount: {{principal}}<br>Term: {{term_days}} days, due {{due_date}}<br>Interest: {{interest_rate}} a month ({{interest_for_term}} for the term)<br>Charges: {{fees}}<br>Total cost of borrowing: {{cost_of_borrowing}}<br>To redeem on the due date: {{redemption_at_due}}</p>'
    || '<h2>Disclosures</h2><div>{{disclosures}}</div><h2>Acknowledgement</h2><p>{{signature_block}}</p>');
  v_html := v_tpl;
  v_html := replace(v_html, '{{loan_number}}', public.pawn_html(l.loan_number));
  v_html := replace(v_html, '{{store_name}}', public.pawn_html(v_store.store_name));
  v_html := replace(v_html, '{{store_address}}', public.pawn_html(v_store.address));
  v_html := replace(v_html, '{{licence_number}}', public.pawn_html(COALESCE(v_store.licence_number, '—')));
  v_html := replace(v_html, '{{customer_name}}', public.pawn_html(v_customer));
  v_html := replace(v_html, '{{issue_date}}', public.pawn_html(t ->> 'issue_date'));
  v_html := replace(v_html, '{{due_date}}', public.pawn_html(t ->> 'due_date'));
  v_html := replace(v_html, '{{term_days}}', public.pawn_html(t ->> 'term_days'));
  v_html := replace(v_html, '{{principal}}', public.pawn_money((t ->> 'principal')::numeric));
  v_html := replace(v_html, '{{interest_rate}}', public.pawn_html((t ->> 'interest_monthly_pct') || '%'));
  v_html := replace(v_html, '{{interest_for_term}}', public.pawn_money((t ->> 'interest_for_term')::numeric));
  v_html := replace(v_html, '{{fees}}', v_fees);
  v_html := replace(v_html, '{{cost_of_borrowing}}', public.pawn_money((t ->> 'cost_of_borrowing')::numeric));
  v_html := replace(v_html, '{{redemption_at_due}}', public.pawn_money((t ->> 'redemption_at_due')::numeric));
  v_html := replace(v_html, '{{grace_days}}', public.pawn_html(COALESCE(t ->> 'grace_days', '—')));
  v_html := replace(v_html, '{{collateral_table}}', COALESCE(v_items, ''));
  v_html := replace(v_html, '{{disclosures}}', replace(public.pawn_html(COALESCE(t ->> 'disclosures', v_rules ->> 'disclosures', 'No disclosures are configured.')), E'\n', '<br>'));
  v_html := replace(v_html, '{{signature_block}}', 'Borrower: ____________________ &nbsp; Employee: ____________________');
  IF p_kind <> 'original' THEN v_html := '<p class="pa-kind">' || initcap(p_kind) || ' of agreement ' || public.pawn_html(l.loan_number) || ' · version ' || l.version || '</p>' || v_html; END IF;
  IF l.is_test THEN v_html := '<p class="pa-test">TEST LOAN: not a legal agreement. Created at a test store for trying out the system.</p>' || v_html; END IF;
  RETURN v_html;
END $$;
REVOKE ALL ON FUNCTION public.pawn_render_agreement(public.pawn_loans, text) FROM PUBLIC, anon, authenticated;

-- Approve a draft: fixes the terms from the configuration (no overrides above its limits).
CREATE OR REPLACE FUNCTION public.pawn_approve(p_store_id uuid, p_loan_id uuid, p_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_approve'); l public.pawn_loans; r jsonb := public.pawn_readiness(p_store_id); t jsonb; v_alloc numeric;
BEGIN
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  IF l.id IS NULL THEN RAISE EXCEPTION 'Loan not found.'; END IF;
  IF l.status <> 'draft' THEN RAISE EXCEPTION 'Only drafts can be approved.'; END IF;
  IF p_version IS NOT NULL AND p_version <> l.version THEN RAISE EXCEPTION 'The draft changed since you opened it. Reload and check it again.'; END IF;
  IF NOT (r ->> 'ready')::boolean THEN RAISE EXCEPTION 'Pawn lending isn''t ready: %', (SELECT string_agg(x, ' ') FROM jsonb_array_elements_text(r -> 'reasons') x); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pawn_collateral WHERE loan_id = l.id) THEN RAISE EXCEPTION 'Add the collateral first.'; END IF;
  SELECT COALESCE(sum(allocated_loan_value), 0) INTO v_alloc FROM public.pawn_collateral WHERE loan_id = l.id;
  IF abs(v_alloc - l.principal) > 0.005 THEN RAISE EXCEPTION 'The collateral''s loan values (%) must add up to the loan amount (%).', public.pawn_money(v_alloc), public.pawn_money(l.principal); END IF;
  t := public.pawn_compute_terms(p_store_id, l.principal, l.term_days, public.pawn_today(p_store_id));
  UPDATE public.pawn_loans SET status = 'approved', terms = t, config_id = (t ->> 'config_id')::uuid, term_days = (t ->> 'term_days')::integer, interest_monthly_pct = (t ->> 'interest_monthly_pct')::numeric,
         approved_by_employee = public.current_store_employee_id(p_store_id), approved_by_user = auth.uid(), approved_at = now(), updated_at = now()
   WHERE id = l.id RETURNING * INTO l;
  PERFORM public.pawn_event(l.id, p_store_id, 'approved', NULL, jsonb_build_object('terms', t));
  RETURN jsonb_build_object('terms', t, 'agreement_html', public.pawn_render_agreement(l, 'original'));
END $$;

CREATE OR REPLACE FUNCTION public.pawn_agreement_preview(p_store_id uuid, p_loan_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE l public.pawn_loans;
BEGIN
  PERFORM public.pawn_require(p_store_id, 'pawn_view');
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id;
  IF l.terms IS NULL THEN RAISE EXCEPTION 'Approve the loan terms first.'; END IF;
  RETURN public.pawn_render_agreement(l, 'original');
END $$;

-- Execute the agreement: the server renders it again and stores that exact text with its SHA-256.
CREATE OR REPLACE FUNCTION public.pawn_sign_agreement(p_store_id uuid, p_loan_id uuid, p_method text, p_customer_signature text, p_employee_confirms boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_create'); l public.pawn_loans; v_html text; v_id uuid; v_rules jsonb;
BEGIN
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  IF l.status <> 'approved' THEN RAISE EXCEPTION 'The loan must be approved before the agreement is signed.'; END IF;
  IF NOT COALESCE(p_employee_confirms, false) THEN RAISE EXCEPTION 'Confirm the customer reviewed the agreement.'; END IF;
  SELECT rules INTO v_rules FROM public.pawn_configs WHERE id = l.config_id;
  IF p_method = 'electronic' THEN
    IF NOT COALESCE((v_rules ->> 'electronic_signature_allowed')::boolean, false) THEN RAISE EXCEPTION 'Electronic signatures aren''t enabled in the configuration. Print the agreement for signing.'; END IF;
    IF NULLIF(btrim(COALESCE(p_customer_signature, '')), '') IS NULL THEN RAISE EXCEPTION 'The customer types their full name to sign.'; END IF;
  ELSIF p_method <> 'paper' THEN RAISE EXCEPTION 'Choose electronic or paper signing.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pawn_agreements WHERE loan_id = l.id AND kind = 'original' AND loan_version = l.version) THEN RAISE EXCEPTION 'The agreement is already signed.'; END IF;
  v_html := public.pawn_render_agreement(l, 'original');
  INSERT INTO public.pawn_agreements (loan_id, store_id, kind, loan_version, document_html, document_sha256, terms, signature_method, customer_signature, employee_id, actor_user)
  VALUES (l.id, p_store_id, 'original', l.version, v_html, encode(extensions.digest(v_html, 'sha256'), 'hex'), l.terms, p_method,
          CASE WHEN p_method = 'paper' THEN 'Signed on paper' ELSE btrim(p_customer_signature) END, public.current_store_employee_id(p_store_id), auth.uid())
  RETURNING id INTO v_id;
  PERFORM public.pawn_event(l.id, p_store_id, 'agreement_signed', NULL, jsonb_build_object('method', p_method, 'agreement_id', v_id));
  RETURN v_id;
END $$;

-- Issue: disburse and activate. p_confirm: { id_verified, collateral_received, funds_handed_over }.
CREATE OR REPLACE FUNCTION public.pawn_issue(p_store_id uuid, p_loan_id uuid, p_request_id uuid, p_method text, p_reference text, p_confirm jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_disburse'); l public.pawn_loans; r jsonb := public.pawn_readiness(p_store_id); v_prev record; v_tx uuid; v_fees numeric; v_today date := public.pawn_today(p_store_id);
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Missing request id.'; END IF;
  SELECT g.loan_id, g.transaction_id INTO v_prev FROM public.pawn_ledger g WHERE g.request_id = p_request_id;
  IF FOUND THEN RETURN jsonb_build_object('loan_id', v_prev.loan_id, 'transaction_id', v_prev.transaction_id, 'repeated', true); END IF;
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  IF l.id IS NULL THEN RAISE EXCEPTION 'Loan not found.'; END IF;
  IF l.status = 'active' THEN RAISE EXCEPTION 'This loan has already been issued.'; END IF;
  IF l.status <> 'approved' THEN RAISE EXCEPTION 'Approve the loan before issuing it.'; END IF;
  IF NOT (r ->> 'ready')::boolean THEN RAISE EXCEPTION 'Pawn lending isn''t ready: %', (SELECT string_agg(x, ' ') FROM jsonb_array_elements_text(r -> 'reasons') x); END IF;
  IF l.is_test IS DISTINCT FROM (r ->> 'test_mode')::boolean THEN RAISE EXCEPTION 'This loan''s test status doesn''t match the store.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pawn_agreements WHERE loan_id = l.id AND kind = 'original' AND loan_version = l.version) THEN RAISE EXCEPTION 'Sign the agreement first.'; END IF;
  IF NOT COALESCE((p_confirm ->> 'id_verified')::boolean, false) THEN RAISE EXCEPTION 'Confirm the customer''s identification was checked.'; END IF;
  IF NOT COALESCE((p_confirm ->> 'collateral_received')::boolean, false) THEN RAISE EXCEPTION 'Confirm all the collateral was received.'; END IF;
  IF NOT COALESCE((p_confirm ->> 'funds_handed_over')::boolean, false) THEN RAISE EXCEPTION 'Confirm the money was handed over (only then is the loan funded).'; END IF;
  IF p_method NOT IN ('cash', 'cheque', 'e_transfer', 'other') THEN RAISE EXCEPTION 'Choose how the money was paid out.'; END IF;
  IF p_method <> 'cash' AND NULLIF(btrim(COALESCE(p_reference, '')), '') IS NULL THEN RAISE EXCEPTION 'Enter the cheque or transfer reference.'; END IF;
  PERFORM public.pawn_require_drawer(l, p_method);
  -- Terms are fixed at approval; the loan runs from today.
  IF (l.terms ->> 'issue_date')::date <> v_today THEN
    l.terms := l.terms || jsonb_build_object('issue_date', v_today, 'due_date', v_today + (l.terms ->> 'term_days')::integer);
  END IF;
  v_fees := COALESCE((l.terms ->> 'fees_total')::numeric, 0);
  UPDATE public.pawn_loans SET status = 'active', terms = l.terms, issue_date = v_today, due_date = (l.terms ->> 'due_date')::date, principal_outstanding = principal,
         charges_unpaid = v_fees, charges_assessed_total = v_fees, charges_accrued_to = v_today, disbursement_method = p_method, disbursement_reference = NULLIF(btrim(p_reference), ''),
         disbursed_at = now(), updated_at = now(), version = version
   WHERE id = l.id RETURNING * INTO l;
  v_tx := public.pawn_record_transaction(l, 'pawn_loan', -l.principal, p_method, p_reference, -l.principal, 'Loan issued');
  INSERT INTO public.pawn_ledger (loan_id, store_id, request_id, entry_type, amount, principal_part, method, reference, transaction_id, principal_after, charges_after, employee_id, actor_user)
  VALUES (l.id, p_store_id, p_request_id, 'disbursement', -l.principal, l.principal, p_method, NULLIF(btrim(p_reference), ''), v_tx, l.principal, 0, public.current_store_employee_id(p_store_id), auth.uid());
  IF v_fees > 0 THEN
    INSERT INTO public.pawn_ledger (loan_id, store_id, entry_type, amount, charges_part, principal_after, charges_after, note, employee_id, actor_user)
    VALUES (l.id, p_store_id, 'fee_assessed', 0, v_fees, l.principal, v_fees, (SELECT string_agg(f ->> 'label', ', ') FROM jsonb_array_elements(l.terms -> 'fees') f), public.current_store_employee_id(p_store_id), auth.uid());
  END IF;
  UPDATE public.pawn_collateral SET status = 'in_custody', updated_at = now() WHERE loan_id = l.id;
  PERFORM public.pawn_event(l.id, p_store_id, 'issued', NULL, jsonb_build_object('method', p_method, 'transaction_id', v_tx, 'principal', l.principal, 'due_date', l.due_date));
  RETURN jsonb_build_object('loan_id', l.id, 'transaction_id', v_tx, 'due_date', l.due_date);
END $$;

-- ── Payments / redemption ───────────────────────────────────────────────────
-- Charges are paid first, then principal. p_amount NULL = pay off (redeem).
CREATE OR REPLACE FUNCTION public.pawn_pay(p_store_id uuid, p_loan_id uuid, p_request_id uuid, p_amount numeric, p_method text, p_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_payments'); l public.pawn_loans; v_prev record; v_due numeric; v_amt numeric; v_charges numeric; v_principal numeric; v_tx uuid; v_type text;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Missing request id.'; END IF;
  SELECT g.loan_id, g.transaction_id, g.amount INTO v_prev FROM public.pawn_ledger g WHERE g.request_id = p_request_id;
  IF FOUND THEN RETURN jsonb_build_object('loan_id', v_prev.loan_id, 'transaction_id', v_prev.transaction_id, 'amount', v_prev.amount, 'repeated', true); END IF;
  IF p_method NOT IN ('cash', 'debit', 'credit', 'e_transfer', 'other') THEN RAISE EXCEPTION 'Choose how the customer paid.'; END IF;
  PERFORM 1 FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  l := public.pawn_accrue(p_loan_id);
  IF l.id IS NULL OR l.store_id <> p_store_id THEN RAISE EXCEPTION 'Loan not found.'; END IF;
  IF l.status NOT IN ('active', 'forfeiture_review') THEN RAISE EXCEPTION 'Payments can only be taken on active loans.'; END IF;
  PERFORM public.pawn_require_drawer(l, p_method);
  v_due := l.principal_outstanding + l.charges_unpaid;
  v_amt := round(COALESCE(p_amount, v_due), 2);
  IF v_amt <= 0 THEN RAISE EXCEPTION 'Enter the payment amount.'; END IF;
  IF v_amt > v_due + 0.005 THEN RAISE EXCEPTION 'That''s more than the % needed to redeem the loan.', public.pawn_money(v_due); END IF;
  -- Partial principal payments only when the configuration allows them.
  IF v_amt < v_due - 0.005 AND v_amt > l.charges_unpaid + 0.005 AND NOT COALESCE((l.terms ->> 'partial_payments_allowed')::boolean, false) THEN
    RAISE EXCEPTION 'Partial payments aren''t allowed under this agreement. Pay the charges (%) or redeem in full (%).', public.pawn_money(l.charges_unpaid), public.pawn_money(v_due);
  END IF;
  v_charges := LEAST(v_amt, l.charges_unpaid);
  v_principal := v_amt - v_charges;
  v_type := CASE WHEN v_amt >= v_due - 0.005 THEN 'pawn_redemption' ELSE 'pawn_payment' END;
  UPDATE public.pawn_loans SET charges_unpaid = charges_unpaid - v_charges, principal_outstanding = principal_outstanding - v_principal,
         status = CASE WHEN v_type = 'pawn_redemption' THEN 'redeemed' ELSE status END, closed_at = CASE WHEN v_type = 'pawn_redemption' THEN now() END, updated_at = now(), version = version + 1
   WHERE id = l.id RETURNING * INTO l;
  v_tx := public.pawn_record_transaction(l, v_type, v_amt, p_method, p_reference, v_principal, concat('Principal ', public.pawn_money(v_principal), ', charges ', public.pawn_money(v_charges)));
  INSERT INTO public.pawn_ledger (loan_id, store_id, request_id, entry_type, amount, principal_part, charges_part, method, reference, transaction_id, principal_after, charges_after, employee_id, actor_user)
  VALUES (l.id, p_store_id, p_request_id, 'payment', v_amt, -v_principal, -v_charges, p_method, NULLIF(btrim(p_reference), ''), v_tx, l.principal_outstanding, l.charges_unpaid, public.current_store_employee_id(p_store_id), auth.uid());
  IF v_type = 'pawn_redemption' THEN
    UPDATE public.pawn_collateral SET status = 'reserved_for_redemption', updated_at = now() WHERE loan_id = l.id AND status IN ('in_custody', 'forfeiture_review');
  END IF;
  PERFORM public.pawn_event(l.id, p_store_id, CASE WHEN v_type = 'pawn_redemption' THEN 'redeemed' ELSE 'payment' END, NULL,
                            jsonb_build_object('amount', v_amt, 'principal', v_principal, 'charges', v_charges, 'method', p_method, 'transaction_id', v_tx));
  RETURN jsonb_build_object('loan_id', l.id, 'transaction_id', v_tx, 'amount', v_amt, 'principal', v_principal, 'charges', v_charges, 'redeemed', v_type = 'pawn_redemption',
                            'principal_outstanding', l.principal_outstanding, 'charges_unpaid', l.charges_unpaid);
END $$;

-- ── Renewal: charges paid, new term, a renewal agreement; history kept ───────
CREATE OR REPLACE FUNCTION public.pawn_renew(p_store_id uuid, p_loan_id uuid, p_request_id uuid, p_term_days integer, p_method text, p_reference text, p_signature_method text, p_customer_signature text, p_employee_confirms boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_renew'); l public.pawn_loans; v_prev record; v_rules jsonb; v_term integer; v_charges numeric; v_tx uuid; v_base date; v_new_due date; v_html text; t jsonb;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Missing request id.'; END IF;
  SELECT g.loan_id INTO v_prev FROM public.pawn_ledger g WHERE g.request_id = p_request_id;
  IF FOUND THEN RETURN jsonb_build_object('loan_id', v_prev.loan_id, 'repeated', true); END IF;
  PERFORM 1 FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  l := public.pawn_accrue(p_loan_id);
  IF l.id IS NULL OR l.store_id <> p_store_id THEN RAISE EXCEPTION 'Loan not found.'; END IF;
  IF l.status <> 'active' THEN RAISE EXCEPTION 'Only active loans can be renewed.'; END IF;
  IF l.legal_hold THEN RAISE EXCEPTION 'This loan is on hold: %', COALESCE(l.hold_reason, 'see notes'); END IF;
  SELECT rules INTO v_rules FROM public.pawn_configs WHERE id = l.config_id;
  IF NOT COALESCE((v_rules ->> 'renewals_allowed')::boolean, false) THEN RAISE EXCEPTION 'Renewals aren''t allowed under this configuration.'; END IF;
  IF NULLIF(v_rules ->> 'max_renewals', '') IS NOT NULL AND l.renewals >= (v_rules ->> 'max_renewals')::integer THEN RAISE EXCEPTION 'This loan has had the most renewals allowed (%).', v_rules ->> 'max_renewals'; END IF;
  v_term := COALESCE(p_term_days, NULLIF(v_rules ->> 'term_days_default', '')::integer);
  IF v_term IS NULL OR (NULLIF(v_rules ->> 'term_days_max', '') IS NOT NULL AND v_term > (v_rules ->> 'term_days_max')::integer) THEN RAISE EXCEPTION 'Choose a term within the configured maximum.'; END IF;
  IF NOT COALESCE(p_employee_confirms, false) THEN RAISE EXCEPTION 'Confirm the customer reviewed and accepted the renewal.'; END IF;
  IF p_signature_method = 'electronic' AND (NOT COALESCE((v_rules ->> 'electronic_signature_allowed')::boolean, false) OR NULLIF(btrim(COALESCE(p_customer_signature, '')), '') IS NULL) THEN
    RAISE EXCEPTION 'Electronic signing needs to be allowed by the configuration and the customer''s typed name.';
  END IF;
  -- The accrued charges are paid to renew.
  v_charges := l.charges_unpaid;
  IF v_charges > 0 THEN
    IF p_method NOT IN ('cash', 'debit', 'credit', 'e_transfer', 'other') THEN RAISE EXCEPTION 'Choose how the customer paid the charges.'; END IF;
    PERFORM public.pawn_require_drawer(l, p_method);
  END IF;
  v_base := GREATEST(l.due_date, public.pawn_today(p_store_id));
  v_new_due := v_base + v_term;
  t := l.terms || jsonb_build_object('due_date', v_new_due, 'term_days', v_term, 'renewed_from_due_date', l.due_date, 'renewal', l.renewals + 1,
                                     'interest_for_term', round(l.principal_outstanding * COALESCE(l.interest_monthly_pct, 0) / 100 / 30 * v_term, 2), 'fees', '[]'::jsonb, 'fees_total', 0,
                                     'cost_of_borrowing', round(l.principal_outstanding * COALESCE(l.interest_monthly_pct, 0) / 100 / 30 * v_term, 2),
                                     'redemption_at_due', round(l.principal_outstanding + l.principal_outstanding * COALESCE(l.interest_monthly_pct, 0) / 100 / 30 * v_term, 2), 'principal', l.principal_outstanding);
  UPDATE public.pawn_loans SET charges_unpaid = 0, due_date = v_new_due, term_days = v_term, terms = t, renewals = renewals + 1, charges_accrued_to = public.pawn_today(p_store_id),
         version = version + 1, updated_at = now()
   WHERE id = l.id RETURNING * INTO l;
  IF v_charges > 0 THEN v_tx := public.pawn_record_transaction(l, 'pawn_renewal', v_charges, p_method, p_reference, 0, 'Renewal charges'); END IF;
  INSERT INTO public.pawn_ledger (loan_id, store_id, request_id, entry_type, amount, charges_part, method, reference, transaction_id, principal_after, charges_after, note, employee_id, actor_user)
  VALUES (l.id, p_store_id, p_request_id, 'renewal', v_charges, -v_charges, CASE WHEN v_charges > 0 THEN p_method END, NULLIF(btrim(p_reference), ''), v_tx, l.principal_outstanding, 0,
          'Renewed to ' || v_new_due, public.current_store_employee_id(p_store_id), auth.uid());
  v_html := public.pawn_render_agreement(l, 'renewal');
  INSERT INTO public.pawn_agreements (loan_id, store_id, kind, loan_version, document_html, document_sha256, terms, signature_method, customer_signature, employee_id, actor_user)
  VALUES (l.id, p_store_id, 'renewal', l.version, v_html, encode(extensions.digest(v_html, 'sha256'), 'hex'), t, CASE WHEN p_signature_method = 'electronic' THEN 'electronic' ELSE 'paper' END,
          CASE WHEN p_signature_method = 'electronic' THEN btrim(p_customer_signature) ELSE 'Signed on paper' END, public.current_store_employee_id(p_store_id), auth.uid());
  PERFORM public.pawn_event(l.id, p_store_id, 'renewed', NULL, jsonb_build_object('new_due_date', v_new_due, 'charges_paid', v_charges, 'transaction_id', v_tx));
  RETURN jsonb_build_object('loan_id', l.id, 'due_date', v_new_due, 'charges_paid', v_charges, 'transaction_id', v_tx);
END $$;

-- ── Corrections ─────────────────────────────────────────────────────────────
-- Reverse a disbursement made in error (same day, nothing paid yet): money back, loan cancelled, items returned.
CREATE OR REPLACE FUNCTION public.pawn_reverse_disbursement(p_store_id uuid, p_loan_id uuid, p_request_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_disburse'); l public.pawn_loans; v_tx uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'A reason is required.'; END IF;
  IF EXISTS (SELECT 1 FROM public.pawn_ledger WHERE request_id = p_request_id) THEN RETURN jsonb_build_object('repeated', true); END IF;
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  IF l.status <> 'active' THEN RAISE EXCEPTION 'Only an active loan''s disbursement can be reversed.'; END IF;
  IF EXISTS (SELECT 1 FROM public.pawn_ledger WHERE loan_id = l.id AND entry_type IN ('payment', 'renewal')) THEN RAISE EXCEPTION 'Payments were taken on this loan; it can''t be reversed. Take a redemption payment instead.'; END IF;
  IF l.issue_date <> public.pawn_today(p_store_id) THEN RAISE EXCEPTION 'A disbursement can only be reversed on the day it was made.'; END IF;
  PERFORM public.pawn_require_drawer(l, l.disbursement_method);
  v_tx := public.pawn_record_transaction(l, 'pawn_reversal', l.principal, l.disbursement_method, l.disbursement_reference, l.principal, 'Disbursement reversed: ' || btrim(p_reason));
  UPDATE public.pawn_loans SET status = 'cancelled', principal_outstanding = 0, charges_unpaid = 0, closed_at = now(), version = version + 1, updated_at = now() WHERE id = l.id;
  INSERT INTO public.pawn_ledger (loan_id, store_id, request_id, entry_type, amount, principal_part, charges_part, method, transaction_id, principal_after, charges_after, note, employee_id, actor_user)
  VALUES (l.id, p_store_id, p_request_id, 'reversal', l.principal, -l.principal_outstanding, -l.charges_unpaid, l.disbursement_method, v_tx, 0, 0, btrim(p_reason), public.current_store_employee_id(p_store_id), auth.uid());
  UPDATE public.pawn_collateral SET status = 'reserved_for_redemption', updated_at = now() WHERE loan_id = l.id;
  PERFORM public.pawn_event(l.id, p_store_id, 'disbursement_reversed', p_reason, jsonb_build_object('transaction_id', v_tx));
  RETURN jsonb_build_object('transaction_id', v_tx);
END $$;

CREATE OR REPLACE FUNCTION public.pawn_cancel_draft(p_store_id uuid, p_loan_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_create'); l public.pawn_loans;
BEGIN
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  IF l.status NOT IN ('draft', 'approved') THEN RAISE EXCEPTION 'Only loans that weren''t issued can be cancelled this way.'; END IF;
  UPDATE public.pawn_loans SET status = 'cancelled', closed_at = now(), updated_at = now() WHERE id = l.id;
  UPDATE public.pawn_collateral SET status = 'released', updated_at = now() WHERE loan_id = l.id AND status = 'pending_intake';
  PERFORM public.pawn_event(l.id, p_store_id, 'cancelled', COALESCE(NULLIF(btrim(p_reason), ''), 'Draft cancelled'));
END $$;

-- ── Collateral custody ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pawn_update_storage(p_store_id uuid, p_collateral_id uuid, p_storage jsonb, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_create'); k public.pawn_collateral;
BEGIN
  SELECT * INTO k FROM public.pawn_collateral WHERE id = p_collateral_id AND store_id = p_store_id FOR UPDATE;
  IF k.id IS NULL THEN RAISE EXCEPTION 'Collateral not found.'; END IF;
  IF k.status IN ('released', 'transferred_to_inventory') THEN RAISE EXCEPTION 'This item is no longer held as collateral.'; END IF;
  UPDATE public.pawn_collateral SET storage = COALESCE(p_storage, '{}'::jsonb), updated_at = now() WHERE id = k.id;
  PERFORM public.pawn_event(k.loan_id, p_store_id, 'storage_changed', COALESCE(NULLIF(btrim(p_reason), ''), 'Moved'), jsonb_build_object('from', k.storage, 'to', p_storage), k.id);
END $$;

-- Hand redeemed (or cancelled) collateral back to the customer.
CREATE OR REPLACE FUNCTION public.pawn_release(p_store_id uuid, p_loan_id uuid, p_recipient text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_release'); l public.pawn_loans; v_n integer;
BEGIN
  IF NULLIF(btrim(COALESCE(p_recipient, '')), '') IS NULL THEN RAISE EXCEPTION 'Enter who collected the items.'; END IF;
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  IF l.status NOT IN ('redeemed', 'cancelled') THEN RAISE EXCEPTION 'Collateral is released only after the loan is redeemed (or a disbursement was reversed).'; END IF;
  IF l.legal_hold THEN RAISE EXCEPTION 'This loan is on hold: %', COALESCE(l.hold_reason, 'see notes'); END IF;
  UPDATE public.pawn_collateral SET status = 'released', updated_at = now() WHERE loan_id = l.id AND status = 'reserved_for_redemption';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Nothing is waiting to be released.'; END IF;
  PERFORM public.pawn_event(l.id, p_store_id, 'collateral_released', p_reason, jsonb_build_object('recipient', btrim(p_recipient), 'items', v_n));
END $$;

-- ── Overdue, holds, notices, forfeiture ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pawn_set_hold(p_store_id uuid, p_loan_id uuid, p_hold boolean, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_overdue');
BEGIN
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'A reason is required.'; END IF;
  UPDATE public.pawn_loans SET legal_hold = p_hold, hold_reason = CASE WHEN p_hold THEN btrim(p_reason) END, updated_at = now() WHERE id = p_loan_id AND store_id = p_store_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found.'; END IF;
  PERFORM public.pawn_event(p_loan_id, p_store_id, CASE WHEN p_hold THEN 'hold_placed' ELSE 'hold_removed' END, p_reason);
END $$;

CREATE OR REPLACE FUNCTION public.pawn_record_notice(p_store_id uuid, p_loan_id uuid, p_kind text, p_method text, p_sent_at timestamptz, p_delivery text, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_overdue');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id) THEN RAISE EXCEPTION 'Loan not found.'; END IF;
  INSERT INTO public.pawn_notices (loan_id, store_id, kind, method, sent_at, delivery, note, employee_id)
  VALUES (p_loan_id, p_store_id, p_kind, p_method, COALESCE(p_sent_at, now()), COALESCE(p_delivery, 'sent'), NULLIF(btrim(p_note), ''), public.current_store_employee_id(p_store_id));
  PERFORM public.pawn_event(p_loan_id, p_store_id, 'notice_recorded', p_note, jsonb_build_object('kind', p_kind, 'method', p_method, 'delivery', p_delivery));
END $$;

CREATE OR REPLACE FUNCTION public.pawn_start_forfeiture_review(p_store_id uuid, p_loan_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_overdue'); l public.pawn_loans;
BEGIN
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  IF l.status <> 'active' THEN RAISE EXCEPTION 'Only active loans go to forfeiture review.'; END IF;
  IF l.due_date >= public.pawn_today(p_store_id) THEN RAISE EXCEPTION 'The loan isn''t past its due date.'; END IF;
  IF l.legal_hold THEN RAISE EXCEPTION 'This loan is on hold: %', COALESCE(l.hold_reason, 'see notes'); END IF;
  UPDATE public.pawn_loans SET status = 'forfeiture_review', updated_at = now(), version = version + 1 WHERE id = l.id;
  UPDATE public.pawn_collateral SET status = 'forfeiture_review', updated_at = now() WHERE loan_id = l.id AND status = 'in_custody';
  PERFORM public.pawn_event(l.id, p_store_id, 'forfeiture_review_started', p_reason);
END $$;

CREATE OR REPLACE FUNCTION public.pawn_end_forfeiture_review(p_store_id uuid, p_loan_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_overdue'); l public.pawn_loans;
BEGIN
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'A reason is required.'; END IF;
  SELECT * INTO l FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  IF l.status <> 'forfeiture_review' THEN RAISE EXCEPTION 'This loan isn''t in forfeiture review.'; END IF;
  UPDATE public.pawn_loans SET status = 'active', updated_at = now(), version = version + 1 WHERE id = l.id;
  UPDATE public.pawn_collateral SET status = 'in_custody', updated_at = now() WHERE loan_id = l.id AND status = 'forfeiture_review';
  PERFORM public.pawn_event(l.id, p_store_id, 'forfeiture_review_ended', p_reason);
END $$;

-- Authorise forfeiture: only after review, never automatically, with every check passed.
CREATE OR REPLACE FUNCTION public.pawn_forfeit(p_store_id uuid, p_loan_id uuid, p_reason text, p_legal_basis text, p_documentation text, p_confirm boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_forfeit'); l public.pawn_loans; c public.pawn_configs; v_today date := public.pawn_today(p_store_id); v_earliest date; v_notice_days integer;
BEGIN
  IF NOT COALESCE(p_confirm, false) THEN RAISE EXCEPTION 'Confirm you checked the legal requirements and the customer''s redemption rights.'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL OR NULLIF(btrim(COALESCE(p_legal_basis, '')), '') IS NULL THEN RAISE EXCEPTION 'Record the reason and the legal basis.'; END IF;
  PERFORM 1 FROM public.pawn_loans WHERE id = p_loan_id AND store_id = p_store_id FOR UPDATE;
  l := public.pawn_accrue(p_loan_id);
  IF l.status <> 'forfeiture_review' THEN RAISE EXCEPTION 'Start a forfeiture review first.'; END IF;
  IF l.legal_hold THEN RAISE EXCEPTION 'This loan is on hold: %', COALESCE(l.hold_reason, 'see notes'); END IF;
  SELECT * INTO c FROM public.pawn_configs WHERE id = l.config_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'The loan''s configuration is missing; forfeiture needs an authorised review.'; END IF;
  IF NOT l.is_test AND c.status <> 'approved' THEN RAISE EXCEPTION 'The configuration isn''t approved; forfeiture can''t be verified.'; END IF;
  IF NULLIF(l.terms ->> 'grace_days', '') IS NULL OR NULLIF(l.terms ->> 'forfeiture_wait_days', '') IS NULL THEN
    RAISE EXCEPTION 'The grace and forfeiture waiting periods aren''t configured, so the earliest forfeiture date can''t be verified.';
  END IF;
  v_earliest := l.due_date + (l.terms ->> 'grace_days')::integer + (l.terms ->> 'forfeiture_wait_days')::integer;
  IF v_today < v_earliest THEN RAISE EXCEPTION 'Too early: under the configuration the earliest forfeiture date is %.', v_earliest; END IF;
  IF COALESCE((c.rules ->> 'forfeiture_notice_required')::boolean, true) THEN
    v_notice_days := COALESCE(NULLIF(c.rules ->> 'forfeiture_notice_days', '')::integer, 0);
    IF NOT EXISTS (SELECT 1 FROM public.pawn_notices n WHERE n.loan_id = l.id AND n.kind = 'forfeiture_notice' AND n.delivery IN ('sent', 'delivered')
                   AND n.sent_at::date <= v_today - v_notice_days) THEN
      RAISE EXCEPTION 'A forfeiture notice must be recorded at least % day(s) before forfeiture.', v_notice_days;
    END IF;
  END IF;
  UPDATE public.pawn_loans SET status = 'forfeited', closed_at = now(), version = version + 1, updated_at = now() WHERE id = l.id;
  INSERT INTO public.pawn_ledger (loan_id, store_id, entry_type, amount, principal_part, charges_part, principal_after, charges_after, note, employee_id, actor_user)
  VALUES (l.id, p_store_id, 'forfeiture', 0, -l.principal_outstanding, -l.charges_unpaid, 0, 0, 'Loan closed by forfeiture: ' || btrim(p_legal_basis), public.current_store_employee_id(p_store_id), auth.uid());
  UPDATE public.pawn_collateral SET status = 'lawfully_acquired', updated_at = now() WHERE loan_id = l.id AND status = 'forfeiture_review';
  PERFORM public.pawn_event(l.id, p_store_id, 'forfeited', p_reason, jsonb_build_object('legal_basis', btrim(p_legal_basis), 'documentation', NULLIF(btrim(p_documentation), ''),
                            'earliest_date', v_earliest, 'principal_written_off', l.principal_outstanding, 'charges_written_off', l.charges_unpaid));
END $$;

-- Lawfully acquired collateral → the store's inventory (not listed online).
CREATE OR REPLACE FUNCTION public.pawn_transfer_to_inventory(p_store_id uuid, p_collateral_id uuid, p_location_id uuid, p_sell_price numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_transfer'); k public.pawn_collateral; l public.pawn_loans; v_inv uuid; v_loc uuid;
BEGIN
  SELECT * INTO k FROM public.pawn_collateral WHERE id = p_collateral_id AND store_id = p_store_id FOR UPDATE;
  IF k.id IS NULL THEN RAISE EXCEPTION 'Collateral not found.'; END IF;
  IF k.status <> 'lawfully_acquired' THEN RAISE EXCEPTION 'Only lawfully acquired items can go into inventory.'; END IF;
  SELECT * INTO l FROM public.pawn_loans WHERE id = k.loan_id;
  IF l.is_test THEN RAISE EXCEPTION 'Test loan items can''t go into real inventory.'; END IF;
  IF l.legal_hold THEN RAISE EXCEPTION 'This loan is on hold.'; END IF;
  IF COALESCE(p_sell_price, 0) <= 0 THEN RAISE EXCEPTION 'Set a retail price.'; END IF;
  v_loc := COALESCE((SELECT id FROM public.store_locations WHERE id = p_location_id AND store_id = p_store_id), l.location_id);
  INSERT INTO public.store_inventory (store_id, catalog_item_id, sku, condition, cost_basis, buy_price, sell_price, name_snapshot, status, is_used, is_trade_in, listed_for_sale)
  VALUES (p_store_id, k.catalog_item_id, 'PWN-' || k.collateral_code, k.condition, k.allocated_loan_value, k.allocated_loan_value, p_sell_price,
          concat_ws(' ', k.name, NULLIF(concat_ws(' ', k.brand, k.model), '')), 'active', true, false, false)
  RETURNING id INTO v_inv;
  INSERT INTO public.store_inventory_quantities (store_id, inventory_id, location_id, quantity) VALUES (p_store_id, v_inv, v_loc, k.quantity)
  ON CONFLICT (inventory_id, location_id) DO UPDATE SET quantity = public.store_inventory_quantities.quantity + k.quantity, updated_at = now();
  INSERT INTO public.store_inventory_movements (store_id, inventory_id, location_id, quantity_change, movement_type, employee_id, reason)
  VALUES (p_store_id, v_inv, v_loc, k.quantity, 'adjustment', public.current_store_employee_id(p_store_id), 'Forfeited pawn collateral ' || k.collateral_code || ' (loan ' || l.loan_number || ')');
  UPDATE public.pawn_collateral SET status = 'transferred_to_inventory', inventory_id = v_inv, updated_at = now() WHERE id = k.id;
  PERFORM public.pawn_event(l.id, p_store_id, 'transferred_to_inventory', NULL, jsonb_build_object('inventory_id', v_inv, 'sell_price', p_sell_price, 'sku', 'PWN-' || k.collateral_code), k.id);
  RETURN v_inv;
END $$;

-- ── Reports ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pawn_report(p_store_id uuid, p_from date, p_to date, p_employee_id uuid DEFAULT NULL, p_location_id uuid DEFAULT NULL, p_category text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.pawn_require(p_store_id, 'pawn_reports'); v_tz text := public.tx_store_tz(p_store_id);
        v_from timestamptz := (COALESCE(p_from, public.pawn_today(p_store_id) - 29)::timestamp AT TIME ZONE v_tz);
        v_to timestamptz := ((COALESCE(p_to, public.pawn_today(p_store_id)) + 1)::timestamp AT TIME ZONE v_tz);
BEGIN
  RETURN (
    WITH loans AS (
      SELECT l.* FROM public.pawn_loans l WHERE l.store_id = p_store_id AND NOT l.is_test
         AND (p_location_id IS NULL OR l.location_id = p_location_id)
         AND (p_employee_id IS NULL OR COALESCE(l.assigned_employee, l.created_by_employee) = p_employee_id)
         AND (p_category IS NULL OR p_category = '' OR EXISTS (SELECT 1 FROM public.pawn_collateral k WHERE k.loan_id = l.id AND k.category = p_category))
    ),
    led AS (SELECT g.* FROM public.pawn_ledger g JOIN loans l ON l.id = g.loan_id WHERE g.created_at >= v_from AND g.created_at < v_to)
    SELECT jsonb_build_object(
      'from', COALESCE(p_from, public.pawn_today(p_store_id) - 29), 'to', COALESCE(p_to, public.pawn_today(p_store_id)),
      'active_loans', (SELECT count(*) FROM loans WHERE status = 'active'),
      'principal_outstanding', (SELECT COALESCE(sum(principal_outstanding), 0) FROM loans WHERE status IN ('active', 'forfeiture_review')),
      'overdue', (SELECT count(*) FROM loans WHERE status = 'active' AND due_date < public.pawn_today(p_store_id)),
      'forfeiture_reviews', (SELECT count(*) FROM loans WHERE status = 'forfeiture_review'),
      'originations', (SELECT count(*) FROM led WHERE entry_type = 'disbursement'),
      'disbursed', (SELECT COALESCE(-sum(amount), 0) FROM led WHERE entry_type = 'disbursement'),
      'cash_disbursed', (SELECT COALESCE(-sum(amount), 0) FROM led WHERE entry_type = 'disbursement' AND method = 'cash'),
      'repayments', (SELECT COALESCE(sum(amount), 0) FROM led WHERE entry_type IN ('payment', 'renewal')),
      'principal_repaid', (SELECT COALESCE(-sum(principal_part), 0) FROM led WHERE entry_type = 'payment'),
      'charges_income', (SELECT COALESCE(-sum(charges_part), 0) FROM led WHERE entry_type IN ('payment', 'renewal')),
      'redeemed', (SELECT count(*) FROM loans l WHERE l.status = 'redeemed' AND l.closed_at >= v_from AND l.closed_at < v_to),
      'reversals', (SELECT COALESCE(sum(amount), 0) FROM led WHERE entry_type = 'reversal'),
      'forfeited', (SELECT count(*) FROM loans l WHERE l.status = 'forfeited' AND l.closed_at >= v_from AND l.closed_at < v_to),
      'lawfully_acquired_items', (SELECT count(*) FROM public.pawn_collateral k JOIN loans l ON l.id = k.loan_id WHERE k.status = 'lawfully_acquired'),
      'transferred_items', (SELECT count(*) FROM public.pawn_events e JOIN loans l ON l.id = e.loan_id WHERE e.action = 'transferred_to_inventory' AND e.created_at >= v_from AND e.created_at < v_to),
      'collateral_estimated_value', (SELECT COALESCE(sum(k.estimated_value * k.quantity), 0) FROM public.pawn_collateral k JOIN loans l ON l.id = k.loan_id WHERE k.status IN ('in_custody', 'forfeiture_review')),
      'collateral_loan_value', (SELECT COALESCE(sum(k.allocated_loan_value), 0) FROM public.pawn_collateral k JOIN loans l ON l.id = k.loan_id WHERE k.status IN ('in_custody', 'forfeiture_review')),
      -- Reconciliation: pawn transactions in the store ledger for the same period.
      'transactions_total', (SELECT COALESCE(sum(t.total), 0) FROM public.store_transactions t WHERE t.store_id = p_store_id AND t.transaction_type LIKE 'pawn\_%' AND t.status = 'completed'
                               AND t.created_at >= v_from AND t.created_at < v_to AND t.id IN (SELECT transaction_id FROM led WHERE transaction_id IS NOT NULL)),
      'ledger_cash_total', (SELECT COALESCE(sum(amount), 0) FROM led WHERE transaction_id IS NOT NULL),
      'categories', COALESCE((SELECT jsonb_agg(DISTINCT k.category) FROM public.pawn_collateral k WHERE k.store_id = p_store_id AND k.category IS NOT NULL), '[]'::jsonb))
  );
END $$;

GRANT EXECUTE ON FUNCTION public.pawn_settings(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_settings_save(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_set_employee_permissions(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_list(uuid, text, text, uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_detail(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_save_draft(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_quote(uuid, numeric, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_approve(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_agreement_preview(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_sign_agreement(uuid, uuid, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_issue(uuid, uuid, uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_pay(uuid, uuid, uuid, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_renew(uuid, uuid, uuid, integer, text, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_reverse_disbursement(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_cancel_draft(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_update_storage(uuid, uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_release(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_set_hold(uuid, uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_record_notice(uuid, uuid, text, text, timestamptz, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_start_forfeiture_review(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_end_forfeiture_review(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_forfeit(uuid, uuid, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_transfer_to_inventory(uuid, uuid, uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pawn_report(uuid, date, date, uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
