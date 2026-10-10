-- Buyback identification: how the store identified the person it bought from.
-- Run after nordvik_identity.sql (this replaces its buyback trigger). Rerunnable.
--
-- Three methods, kept distinct (never one "verified" flag):
--   nordvik_identity       the customer's account is NORDVIK Identity verified
--                          (account-level; recorded automatically at checkout)
--   manual_id_check        a registered but unverified customer whose ID an
--                          employee examined for this transaction only
--   guest_manual_id_check  a guest (no account): their details are recorded and
--                          their ID examined, for this transaction only
-- A manual check never changes anyone's NORDVIK Identity status.
--
-- Rules per store location (store_buyback_id_rules) say what must be recorded
-- (date of birth, address, contact, ID number, minimum age, accepted ID types).
-- Collecting a name and ticking a box doesn't satisfy every jurisdiction:
-- each store sets the rules its second-hand dealer requirements need.
--
-- Records (store_buyback_identifications):
--   * The employee is always the signed-in user (set here, never sent by the app).
--   * Append-only: the only change allowed is linking it to its transaction.
--     Corrections are new records that point to the original (corrects_id).
--   * Visible to store managers and the organization (buyback_id_log).
--   * The store_transactions trigger only lets a trade_in or exchange through
--     when the customer is NORDVIK verified or a matching, unused identification
--     from the last 30 minutes exists; it then links it to the transaction and
--     fills the transaction's id_verified / id_type / id_verified_by columns.

-- ── Rules per location ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_buyback_id_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id               uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  location_id            uuid REFERENCES public.store_locations(id) ON DELETE CASCADE, -- null = the store's default
  accepted_id_types      text[] NOT NULL DEFAULT ARRAY['drivers_licence', 'passport', 'provincial_id'],
  require_date_of_birth  boolean NOT NULL DEFAULT true,
  require_address        boolean NOT NULL DEFAULT false,
  require_contact        boolean NOT NULL DEFAULT false,
  require_id_number      boolean NOT NULL DEFAULT false,  -- only where the law requires recording it
  minimum_age            integer NOT NULL DEFAULT 18 CHECK (minimum_age BETWEEN 0 AND 99),
  allow_manual_check     boolean NOT NULL DEFAULT true,   -- registered, unverified customers
  allow_guest_buyback    boolean NOT NULL DEFAULT true,
  policy_note            text,                             -- the requirement / policy these rules follow
  updated_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS store_buyback_id_rules_scope ON public.store_buyback_id_rules (store_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE public.store_buyback_id_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_buyback_id_rules FROM anon, authenticated;

-- ── Identification records ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_buyback_identifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id              uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  location_id           uuid REFERENCES public.store_locations(id) ON DELETE SET NULL,
  method                text NOT NULL CHECK (method IN ('nordvik_identity', 'demo_identity', 'manual_id_check', 'guest_manual_id_check')),
  account_id            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  customer_id           uuid REFERENCES public.store_customers(id) ON DELETE SET NULL,
  employee_id           uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  actor_user_id         uuid,           -- the signed-in user who confirmed (server-set)
  id_type               text,
  confirmation_version  text,           -- the wording the employee confirmed
  guest_details         jsonb,          -- guests: name, and DOB / address / contact / ID number where the rules require
  transaction_id        uuid,
  consumed_at           timestamptz,
  corrects_id           uuid REFERENCES public.store_buyback_identifications(id) ON DELETE SET NULL,
  correction_reason     text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- demo_identity: demo verification at a test store (never in production).
ALTER TABLE public.store_buyback_identifications DROP CONSTRAINT IF EXISTS store_buyback_identifications_method_check;
ALTER TABLE public.store_buyback_identifications ADD CONSTRAINT store_buyback_identifications_method_check
  CHECK (method IN ('nordvik_identity', 'demo_identity', 'manual_id_check', 'guest_manual_id_check'));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_buyback_identifications_txn_fk') THEN
    ALTER TABLE public.store_buyback_identifications ADD CONSTRAINT store_buyback_identifications_txn_fk
      FOREIGN KEY (transaction_id) REFERENCES public.store_transactions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS store_buyback_identifications_open_idx ON public.store_buyback_identifications (store_id, customer_id, created_at DESC) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS store_buyback_identifications_txn_idx ON public.store_buyback_identifications (transaction_id);
ALTER TABLE public.store_buyback_identifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_buyback_identifications FROM anon, authenticated;

-- Append-only: only linking an unused record to its transaction is allowed.
CREATE OR REPLACE FUNCTION public.buyback_id_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Buyback identification records cannot be deleted.'; END IF;
  IF OLD.transaction_id IS NULL AND NEW.transaction_id IS NOT NULL
     AND (to_jsonb(NEW) - 'transaction_id' - 'consumed_at') = (to_jsonb(OLD) - 'transaction_id' - 'consumed_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Buyback identification records cannot be changed; record a correction instead.';
END $$;
DROP TRIGGER IF EXISTS buyback_id_guard ON public.store_buyback_identifications;
CREATE TRIGGER buyback_id_guard BEFORE UPDATE OR DELETE ON public.store_buyback_identifications
  FOR EACH ROW EXECUTE FUNCTION public.buyback_id_guard();

-- The rules for a location (location rules, else the store default, else built-in defaults).
CREATE OR REPLACE FUNCTION public.buyback_id_rules_for(p_store_id uuid, p_location_id uuid)
RETURNS public.store_buyback_id_rules LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.store_buyback_id_rules;
BEGIN
  SELECT * INTO r FROM public.store_buyback_id_rules WHERE store_id = p_store_id AND location_id = p_location_id;
  IF r.id IS NULL THEN SELECT * INTO r FROM public.store_buyback_id_rules WHERE store_id = p_store_id AND location_id IS NULL; END IF;
  IF r.id IS NULL THEN
    r.store_id := p_store_id; r.location_id := p_location_id;
    r.accepted_id_types := ARRAY['drivers_licence', 'passport', 'provincial_id'];
    r.require_date_of_birth := true; r.require_address := false; r.require_contact := false; r.require_id_number := false;
    r.minimum_age := 18; r.allow_manual_check := true; r.allow_guest_buyback := true;
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.buyback_id_rules_for(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- POS: the rules that apply at this register.
CREATE OR REPLACE FUNCTION public.buyback_id_rules(p_store_id uuid, p_location_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.store_buyback_id_rules;
BEGIN
  IF p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  r := public.buyback_id_rules_for(p_store_id, p_location_id);
  RETURN to_jsonb(r) - 'updated_by';
END $$;

-- Record a manual or guest identification (the employee is the signed-in user).
CREATE OR REPLACE FUNCTION public.buyback_id_record(
  p_store_id uuid, p_location_id uuid, p_method text, p_account_id uuid, p_id_type text,
  p_guest jsonb, p_confirmed boolean, p_confirmation_version text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.store_buyback_id_rules;
  v_customer uuid;
  v_id uuid;
  v_guest jsonb := '{}'::jsonb;
  v_dob date;
BEGIN
  IF p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  IF p_method NOT IN ('manual_id_check', 'guest_manual_id_check') THEN RAISE EXCEPTION 'Unknown identification method.'; END IF;
  IF p_confirmed IS NOT TRUE OR NULLIF(btrim(p_confirmation_version), '') IS NULL THEN
    RAISE EXCEPTION 'Confirm that you examined the customer''s government-issued identification.';
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.store_locations l WHERE l.id = p_location_id AND l.store_id = p_store_id) THEN
    RAISE EXCEPTION 'That location isn''t part of this store.';
  END IF;
  r := public.buyback_id_rules_for(p_store_id, p_location_id);
  IF p_id_type IS NULL OR NOT (p_id_type = ANY (r.accepted_id_types)) THEN RAISE EXCEPTION 'That type of ID isn''t accepted at this location.'; END IF;

  IF p_method = 'manual_id_check' THEN
    IF NOT r.allow_manual_check THEN RAISE EXCEPTION 'This location requires NORDVIK Identity verification for registered customers.'; END IF;
    IF p_account_id IS NULL THEN RAISE EXCEPTION 'No customer account.'; END IF;
    v_customer := (public.ensure_store_customer_for_profile(p_store_id, p_account_id)->>'customer_id')::uuid;
  ELSE
    IF NOT r.allow_guest_buyback THEN RAISE EXCEPTION 'This location doesn''t buy from guests. Create a customer instead.'; END IF;
    v_guest := jsonb_build_object('full_name', regexp_replace(btrim(COALESCE(p_guest->>'full_name', '')), '\s+', ' ', 'g'));
    IF length(v_guest->>'full_name') < 2 THEN RAISE EXCEPTION 'Enter the guest''s full legal name.'; END IF;
  END IF;

  -- Extra details only where this location's rules require them (guests record
  -- them here; for registered customers they're recorded only when required).
  IF r.require_date_of_birth OR r.minimum_age > 0 THEN
    BEGIN v_dob := NULLIF(p_guest->>'date_of_birth', '')::date; EXCEPTION WHEN others THEN v_dob := NULL; END;
    IF r.require_date_of_birth AND v_dob IS NULL THEN RAISE EXCEPTION 'Enter the date of birth from the ID.'; END IF;
    IF v_dob IS NOT NULL AND v_dob > current_date - make_interval(years => r.minimum_age) THEN
      RAISE EXCEPTION 'This location can''t buy from anyone under %.', r.minimum_age;
    END IF;
    IF r.require_date_of_birth THEN v_guest := v_guest || jsonb_build_object('date_of_birth', v_dob); END IF;
  END IF;
  IF r.require_address THEN
    IF length(btrim(COALESCE(p_guest->>'address', ''))) < 5 THEN RAISE EXCEPTION 'Enter the residential address.'; END IF;
    v_guest := v_guest || jsonb_build_object('address', btrim(p_guest->>'address'));
  END IF;
  IF r.require_contact THEN
    IF length(btrim(COALESCE(p_guest->>'contact', ''))) < 5 THEN RAISE EXCEPTION 'Enter a phone number or email.'; END IF;
    v_guest := v_guest || jsonb_build_object('contact', btrim(p_guest->>'contact'));
  END IF;
  IF r.require_id_number THEN
    IF length(btrim(COALESCE(p_guest->>'id_number', ''))) < 4 THEN RAISE EXCEPTION 'Enter the ID number.'; END IF;
    v_guest := v_guest || jsonb_build_object('id_number', btrim(p_guest->>'id_number'), 'jurisdiction', NULLIF(btrim(p_guest->>'jurisdiction'), ''));
  END IF;

  INSERT INTO public.store_buyback_identifications (store_id, location_id, method, account_id, customer_id, employee_id, actor_user_id, id_type, confirmation_version, guest_details)
  VALUES (p_store_id, p_location_id, p_method, CASE WHEN p_method = 'manual_id_check' THEN p_account_id END, v_customer,
          public.myhr_employee_id(p_store_id), auth.uid(), p_id_type, btrim(p_confirmation_version),
          CASE WHEN v_guest = '{}'::jsonb THEN NULL ELSE v_guest END)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Managers / head office: the identification log for a period.
CREATE OR REPLACE FUNCTION public.buyback_id_can_manage(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.myhr_is_manager(p_store_id)
      OR EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND s.organization_id IN (SELECT public.user_org_ids()))
$$;
REVOKE ALL ON FUNCTION public.buyback_id_can_manage(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.buyback_id_log(p_store_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (id uuid, created_at timestamptz, method text, id_type text, customer_name text, username text, guest_details jsonb,
               employee_name text, transaction_id uuid, transaction_number text, corrects_id uuid, correction_reason text, location_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.buyback_id_can_manage(p_store_id) THEN RAISE EXCEPTION 'Only managers can see the identification log.'; END IF;
  RETURN QUERY
  SELECT b.id, b.created_at, b.method, b.id_type,
         COALESCE(b.guest_details->>'full_name', c.display_name, pr.full_name, pr.display_name), pr.username, b.guest_details,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Store owner'),
         b.transaction_id, t.transaction_number, b.corrects_id, b.correction_reason, l.location_name
    FROM public.store_buyback_identifications b
    LEFT JOIN public.store_customers c ON c.id = b.customer_id
    LEFT JOIN public.profiles pr ON pr.id = b.account_id
    LEFT JOIN public.store_employees e ON e.id = b.employee_id
    LEFT JOIN public.store_transactions t ON t.id = b.transaction_id
    LEFT JOIN public.store_locations l ON l.id = b.location_id
   WHERE b.store_id = p_store_id AND b.created_at >= p_from AND b.created_at < p_to
   ORDER BY b.created_at DESC;
END $$;

-- Corrections: a new record pointing at the original (which stays as it was).
CREATE OR REPLACE FUNCTION public.buyback_id_correct(p_identification_id uuid, p_reason text, p_id_type text, p_guest jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.store_buyback_identifications; v_id uuid;
BEGIN
  SELECT * INTO o FROM public.store_buyback_identifications WHERE id = p_identification_id;
  IF o.id IS NULL THEN RAISE EXCEPTION 'Identification not found.'; END IF;
  IF NOT public.buyback_id_can_manage(o.store_id) THEN RAISE EXCEPTION 'Only managers can correct identification records.'; END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Give a reason for the correction.'; END IF;
  INSERT INTO public.store_buyback_identifications (store_id, location_id, method, account_id, customer_id, employee_id, actor_user_id, id_type,
         confirmation_version, guest_details, transaction_id, consumed_at, corrects_id, correction_reason)
  VALUES (o.store_id, o.location_id, o.method, o.account_id, o.customer_id, public.myhr_employee_id(o.store_id), auth.uid(),
          COALESCE(NULLIF(p_id_type, ''), o.id_type), 'correction', COALESCE(p_guest, o.guest_details), o.transaction_id, now(), o.id, btrim(p_reason))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Head office: read and set a location's rules (location null = the store default).
CREATE OR REPLACE FUNCTION public.org_buyback_id_rules(p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN RAISE EXCEPTION 'not authorised for this organization'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(r) - 'updated_by') FROM public.store_buyback_id_rules r
                    JOIN public.stores s ON s.id = r.store_id WHERE s.organization_id = p_org_id), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.org_set_buyback_id_rules(p_org_id uuid, p_store_id uuid, p_location_id uuid, p_rules jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_types text[];
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN RAISE EXCEPTION 'not authorised for this organization'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND s.organization_id = p_org_id) THEN RAISE EXCEPTION 'That store isn''t in this organization.'; END IF;
  SELECT array_agg(t) INTO v_types FROM jsonb_array_elements_text(COALESCE(p_rules->'accepted_id_types', '[]'::jsonb)) t
   WHERE t IN ('drivers_licence', 'passport', 'provincial_id');
  IF COALESCE(array_length(v_types, 1), 0) = 0 THEN RAISE EXCEPTION 'Accept at least one type of ID.'; END IF;
  INSERT INTO public.store_buyback_id_rules (store_id, location_id, accepted_id_types, require_date_of_birth, require_address, require_contact,
         require_id_number, minimum_age, allow_manual_check, allow_guest_buyback, policy_note, updated_by, updated_at)
  VALUES (p_store_id, p_location_id, v_types, COALESCE((p_rules->>'require_date_of_birth')::boolean, true), COALESCE((p_rules->>'require_address')::boolean, false),
          COALESCE((p_rules->>'require_contact')::boolean, false), COALESCE((p_rules->>'require_id_number')::boolean, false),
          COALESCE((p_rules->>'minimum_age')::int, 18), COALESCE((p_rules->>'allow_manual_check')::boolean, true),
          COALESCE((p_rules->>'allow_guest_buyback')::boolean, true), NULLIF(btrim(p_rules->>'policy_note'), ''), auth.uid(), now())
  ON CONFLICT (store_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET
    accepted_id_types = EXCLUDED.accepted_id_types, require_date_of_birth = EXCLUDED.require_date_of_birth, require_address = EXCLUDED.require_address,
    require_contact = EXCLUDED.require_contact, require_id_number = EXCLUDED.require_id_number, minimum_age = EXCLUDED.minimum_age,
    allow_manual_check = EXCLUDED.allow_manual_check, allow_guest_buyback = EXCLUDED.allow_guest_buyback, policy_note = EXCLUDED.policy_note,
    updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;

-- ── Server-side enforcement (replaces nordvik_identity.sql's trigger) ───────
-- A trade_in / exchange is recorded only when the seller was identified:
-- NORDVIK verified (recorded now as nordvik_identity), or a matching unused
-- manual / guest identification from the last 30 minutes (registered: same
-- customer; guest: recorded by the same employee at this store).
CREATE OR REPLACE FUNCTION public.identity_enforce_buyback()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account uuid;
  v_ident public.store_buyback_identifications;
BEGIN
  IF NEW.transaction_type NOT IN ('trade_in', 'exchange') THEN RETURN NEW; END IF;
  IF NEW.customer_id IS NOT NULL THEN
    SELECT c.collectorshub_user_id INTO v_account FROM public.store_customers c WHERE c.id = NEW.customer_id;
  END IF;

  -- Real NORDVIK verification anywhere; demo verification only at test stores.
  IF v_account IS NOT NULL AND public.identity_buyback_allowed_at(v_account, NEW.store_id) THEN
    INSERT INTO public.store_buyback_identifications (store_id, location_id, method, account_id, customer_id, employee_id, actor_user_id, transaction_id, consumed_at)
    VALUES (NEW.store_id, NEW.location_id,
            CASE WHEN public.identity_buyback_allowed(v_account) THEN 'nordvik_identity' ELSE 'demo_identity' END,
            v_account, NEW.customer_id, NEW.employee_id, auth.uid(), NEW.id, now())
    RETURNING * INTO v_ident;
  ELSE
    SELECT * INTO v_ident FROM public.store_buyback_identifications b
     WHERE b.store_id = NEW.store_id AND b.consumed_at IS NULL AND b.corrects_id IS NULL AND b.created_at > now() - interval '30 minutes'
       AND ((NEW.customer_id IS NOT NULL AND b.method = 'manual_id_check' AND b.customer_id = NEW.customer_id)
         OR (NEW.customer_id IS NULL AND b.method = 'guest_manual_id_check' AND b.actor_user_id = auth.uid()))
     ORDER BY b.created_at DESC LIMIT 1
     FOR UPDATE SKIP LOCKED;
    IF v_ident.id IS NULL THEN
      RAISE EXCEPTION 'Identify the customer before buying from them: NORDVIK Identity verification, a manual ID check, or guest buyback details.'
        USING ERRCODE = 'P0001', HINT = 'buyback_identification_required';
    END IF;
    UPDATE public.store_buyback_identifications SET transaction_id = NEW.id, consumed_at = now() WHERE id = v_ident.id;
  END IF;

  -- Keep the transaction's own ID columns meaningful for existing reports.
  NEW.id_verified := true;
  NEW.id_type := COALESCE(v_ident.id_type, v_ident.method);
  NEW.id_verified_at := now();
  NEW.id_verified_by_employee_id := COALESCE(v_ident.employee_id, NEW.employee_id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS identity_enforce_buyback ON public.store_transactions;
CREATE TRIGGER identity_enforce_buyback BEFORE INSERT ON public.store_transactions
  FOR EACH ROW EXECUTE FUNCTION public.identity_enforce_buyback();

GRANT EXECUTE ON FUNCTION public.buyback_id_rules(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyback_id_record(uuid, uuid, text, uuid, text, jsonb, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyback_id_log(uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyback_id_correct(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_buyback_id_rules(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_set_buyback_id_rules(uuid, uuid, uuid, jsonb) TO authenticated;
