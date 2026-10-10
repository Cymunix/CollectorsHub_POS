-- NORDVIK Identity: identity verification for the NORDVIK ecosystem
-- (CollectorsHub POS is the first connected application).
--
-- Replaces the first version of this file. If you ran it, run this one too:
-- it keeps the old profiles.identity_* columns (unused from now on) and moves
-- any status they held into identity_profiles.
--
-- Boundaries
--   NORDVIK Identity (this file + the nordvik-identity Edge Function) owns
--   identity profiles, verification sessions and attempts, consent records,
--   evidence, decisions, portraits and the audit trail. Apps never touch these
--   tables: they're locked (RLS on, no policies, no grants) and every change
--   goes through the Edge Function using the service role.
--   CollectorsHub POS creates customers, starts verifications, shows the
--   status, and is blocked from recording buybacks for unverified customers
--   (enforced here, in the database, for every client).
--
-- Account mapping: identity_profiles.account_id -> profiles.id (the
-- CollectorsHub / NORDVIK account). Existing customer ids are untouched;
-- store_customers.collectorshub_user_id links store customers to accounts.
--
-- Statuses (identity_profiles.verification_status, the person's overall status):
--   unverified, pending, processing, manual_review, verified, failed, expired, revoked
-- A verification session / attempt has its own status; a failed new attempt
-- does not erase an earlier valid verification (see identity_decide()).
-- Only NORDVIK Identity (service role) can set "verified".
--
-- Evidence (ID images, live photos) lives in the private storage bucket
-- "identity-evidence"; identity_evidence only holds references and hashes.
-- No biometric templates or full ID numbers are stored. Evidence is deleted
-- after the decision (identity_evidence_due_for_deletion() + the Edge
-- Function's purge), details after 90 days. Schedule the purge (pg_cron).
--
-- Rerunnable.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Identity profiles (one per person / account) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.identity_profiles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  legal_name               text,
  verification_status      text NOT NULL DEFAULT 'unverified'
                           CHECK (verification_status IN ('unverified', 'pending', 'processing', 'manual_review', 'verified', 'failed', 'expired', 'revoked')),
  verified_at              timestamptz,
  verification_expires_at  timestamptz,   -- re-verification needed after this (the ID used expires)
  verified_document_type   text,
  verified_method          text,          -- 'automated' or 'manual_review'
  verified_session_id      uuid,
  revoked_at               timestamptz,
  revoked_reason           text,
  portrait_path            text,          -- white-background headshot in identity-evidence/portraits/
  portrait_status          text NOT NULL DEFAULT 'none' CHECK (portrait_status IN ('none', 'pending', 'ready', 'failed')),
  portrait_display_consent boolean NOT NULL DEFAULT false, -- covered by the verification consent: stores where they sell see it
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
-- The identity photo is NOT the CollectorsHub profile picture (profiles.avatar_url):
-- separate field, separate private storage, separate endpoint; one never replaces the other.
ALTER TABLE public.identity_profiles ADD COLUMN IF NOT EXISTS verified_date_of_birth date;
ALTER TABLE public.identity_profiles ADD COLUMN IF NOT EXISTS portrait_source text; -- 'provider_processed' (white background) or 'live_photo_unprocessed' (awaiting background removal)

CREATE TABLE IF NOT EXISTS public.identity_verification_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id       uuid NOT NULL REFERENCES public.identity_profiles(id) ON DELETE CASCADE,
  application_id            text NOT NULL DEFAULT 'collectorshub_pos',
  store_id                  uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  initiated_by_employee_id  uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  initiated_by_user         uuid,
  document_type             text CHECK (document_type IN ('drivers_licence', 'passport', 'provincial_id')),
  capture_method            text CHECK (capture_method IN ('webcam', 'mobile', 'none')),
  biometric_consent         boolean,      -- null until asked; false = the non-biometric alternative
  status                    text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'awaiting_capture', 'processing', 'manual_review', 'verified', 'failed', 'cancelled', 'expired')),
  document_details          jsonb,        -- what was read from the ID (name, DOB, expiry, jurisdiction); purged after 90 days
  discrepancies             text[] NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  completed_at              timestamptz
);
CREATE INDEX IF NOT EXISTS identity_sessions_profile_idx ON public.identity_verification_sessions(identity_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS identity_sessions_review_idx ON public.identity_verification_sessions(status) WHERE status = 'manual_review';

CREATE TABLE IF NOT EXISTS public.identity_verification_attempts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id             uuid NOT NULL REFERENCES public.identity_verification_sessions(id) ON DELETE CASCADE,
  document_type          text,
  document_check_status  text NOT NULL DEFAULT 'not_checked',  -- not_checked | passed | failed | inconclusive | manual
  face_match_status      text NOT NULL DEFAULT 'not_checked',
  liveness_status        text NOT NULL DEFAULT 'not_checked',
  review_status          text NOT NULL DEFAULT 'none',         -- none | pending | approved | rejected
  verification_provider  text,                                 -- null = none configured
  provider_reference     text,
  failure_reason_code    text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_attempts_session_idx ON public.identity_verification_attempts(session_id);

CREATE TABLE IF NOT EXISTS public.identity_consent_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_profile_id uuid NOT NULL REFERENCES public.identity_profiles(id) ON DELETE CASCADE,
  session_id          uuid REFERENCES public.identity_verification_sessions(id) ON DELETE SET NULL,
  notice_version      text NOT NULL,
  consent_type        text NOT NULL CHECK (consent_type IN ('identity_check', 'biometric', 'portrait_display')),
  consent_status      text NOT NULL CHECK (consent_status IN ('given', 'declined', 'withdrawn')),
  consent_timestamp   timestamptz NOT NULL DEFAULT now(),
  consent_method      text NOT NULL CHECK (consent_method IN ('pos_customer_signature', 'customer_phone')),
  signed_name         text   -- the name the customer typed to confirm
);

-- Mobile capture links (QR). Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS public.identity_mobile_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES public.identity_verification_sessions(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  opened_at       timestamptz,
  completed_at    timestamptz,
  revoked_at      timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_mobile_links_session_idx ON public.identity_mobile_links(session_id);

-- Evidence references (images live in the private identity-evidence bucket).
CREATE TABLE IF NOT EXISTS public.identity_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES public.identity_verification_sessions(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('document_front', 'document_back', 'live_photo')),
  storage_path text NOT NULL,
  uploaded_at  timestamptz,
  sha256       text,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, kind)
);

CREATE TABLE IF NOT EXISTS public.identity_reviewers (
  user_id  uuid PRIMARY KEY,
  note     text,
  added_at timestamptz NOT NULL DEFAULT now()
);

-- Tamper-evident audit trail (append-only, hash-chained).
CREATE TABLE IF NOT EXISTS public.identity_verification_audit (
  id                  bigserial PRIMARY KEY,
  identity_profile_id uuid,
  session_id          uuid,
  actor_id            uuid,
  actor_type          text NOT NULL,   -- employee | customer_phone | reviewer | service | system
  action              text NOT NULL,
  timestamp           timestamptz NOT NULL DEFAULT clock_timestamp(),
  relevant_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash           text,
  hash                text
);

-- Lock everything: only the service role (the Edge Function) reads or writes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identity_profiles', 'identity_verification_sessions', 'identity_verification_attempts', 'identity_consent_records',
                           'identity_mobile_links', 'identity_evidence', 'identity_reviewers', 'identity_verification_audit'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- Private bucket for evidence and portraits (no storage policies = service role only).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('identity-evidence', 'identity-evidence', false, 8388608, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 8388608, allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- ── Audit chain ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.identity_audit_chain()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('identity_verification_audit'));
  SELECT a.hash INTO NEW.prev_hash FROM public.identity_verification_audit a ORDER BY a.id DESC LIMIT 1;
  NEW.hash := encode(digest(concat_ws('|', COALESCE(NEW.prev_hash, ''), NEW.id, NEW.identity_profile_id, NEW.session_id, NEW.actor_id,
                                      NEW.actor_type, NEW.action, NEW.timestamp, NEW.relevant_metadata::text), 'sha256'), 'hex');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS identity_audit_chain ON public.identity_verification_audit;
CREATE TRIGGER identity_audit_chain BEFORE INSERT ON public.identity_verification_audit
  FOR EACH ROW EXECUTE FUNCTION public.identity_audit_chain();

CREATE OR REPLACE FUNCTION public.identity_audit_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'The identity audit trail is append-only.'; END $$;
DROP TRIGGER IF EXISTS identity_audit_append_only ON public.identity_verification_audit;
CREATE TRIGGER identity_audit_append_only BEFORE UPDATE OR DELETE ON public.identity_verification_audit
  FOR EACH ROW EXECUTE FUNCTION public.identity_audit_append_only();

-- Recompute the chain: the first broken entry (null = intact).
CREATE OR REPLACE FUNCTION public.identity_audit_verify()
RETURNS TABLE (broken_at bigint, entries bigint)
LANGUAGE plpgsql STABLE SET search_path = public, extensions AS $$
DECLARE r record; v_prev text := NULL; v_count bigint := 0;
BEGIN
  FOR r IN SELECT * FROM public.identity_verification_audit ORDER BY id LOOP
    v_count := v_count + 1;
    IF r.prev_hash IS DISTINCT FROM v_prev OR r.hash IS DISTINCT FROM encode(digest(concat_ws('|', COALESCE(r.prev_hash, ''), r.id, r.identity_profile_id,
         r.session_id, r.actor_id, r.actor_type, r.action, r.timestamp, r.relevant_metadata::text), 'sha256'), 'hex') THEN
      broken_at := r.id; entries := v_count; RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
  END LOOP;
  broken_at := NULL; entries := v_count; RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION public.identity_audit(p_profile uuid, p_session uuid, p_actor uuid, p_actor_type text, p_action text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SET search_path = public AS $$
  INSERT INTO public.identity_verification_audit (identity_profile_id, session_id, actor_id, actor_type, action, relevant_metadata)
  VALUES (p_profile, p_session, p_actor, p_actor_type, p_action, COALESCE(p_meta, '{}'::jsonb));
$$;

-- ── Status ──────────────────────────────────────────────────────────────────
-- A person's effective status: verified turns into expired once the ID used
-- has expired, and revoked always wins.
CREATE OR REPLACE FUNCTION public.identity_effective_status(p public.identity_profiles)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p.revoked_at IS NOT NULL THEN 'revoked'
    WHEN p.verification_status = 'verified' AND p.verification_expires_at IS NOT NULL AND p.verification_expires_at < now() THEN 'expired'
    ELSE p.verification_status END
$$;

-- A store may see a person's status once they're that store's customer.
CREATE OR REPLACE FUNCTION public.identity_store_can_see(p_store_id uuid, p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.store_customers c WHERE c.store_id = p_store_id AND c.collectorshub_user_id = p_account_id)
$$;

-- Demo verification (development / testing only): is_demo profiles are shown
-- as "Demo Verified" only at test stores (stores.is_test_store); everywhere
-- else they count as unverified, and they never satisfy a production buyback.
-- A real verification clears is_demo (identity_decide).
ALTER TABLE public.identity_profiles ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.identity_is_test_store(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT s.is_test_store FROM public.stores s WHERE s.id = p_store_id), false)
$$;

-- Buyback eligibility. Without a store (production rule): real verification only.
CREATE OR REPLACE FUNCTION public.identity_buyback_allowed(p_account_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT public.identity_effective_status(p) = 'verified' AND NOT p.is_demo FROM public.identity_profiles p WHERE p.account_id = p_account_id), false)
$$;
REVOKE ALL ON FUNCTION public.identity_buyback_allowed(uuid) FROM PUBLIC, anon, authenticated;

-- At a store: demo verification counts only at test stores.
CREATE OR REPLACE FUNCTION public.identity_buyback_allowed_at(p_account_id uuid, p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT public.identity_effective_status(p) = 'verified' AND (NOT p.is_demo OR public.identity_is_test_store(p_store_id))
                     FROM public.identity_profiles p WHERE p.account_id = p_account_id), false)
$$;
REVOKE ALL ON FUNCTION public.identity_buyback_allowed_at(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- POS (signed-in staff): can this user act for the store? Used by the Edge Function.
CREATE OR REPLACE FUNCTION public.identity_staff_check(p_store_id uuid)
RETURNS TABLE (allowed boolean, employee_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_store_id IN (SELECT public.user_store_ids()), public.myhr_employee_id(p_store_id)
$$;
GRANT EXECUTE ON FUNCTION public.identity_staff_check(uuid) TO authenticated;

-- ── Server-side buyback enforcement ─────────────────────────────────────────
-- Any transaction where the store receives merchandise from a customer
-- (trade_in, exchange) needs a customer whose NORDVIK Identity is verified.
CREATE OR REPLACE FUNCTION public.identity_enforce_buyback()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_account uuid;
BEGIN
  IF NEW.transaction_type NOT IN ('trade_in', 'exchange') THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('nordvik.identity_bypass', true), '') = 'on' THEN RETURN NEW; END IF;
  SELECT c.collectorshub_user_id INTO v_account FROM public.store_customers c WHERE c.id = NEW.customer_id;
  IF v_account IS NULL OR NOT public.identity_buyback_allowed(v_account) THEN
    RAISE EXCEPTION 'Identity verification is required before this customer can sell items to the store.'
      USING ERRCODE = 'P0001', HINT = 'nordvik_identity_required';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS identity_enforce_buyback ON public.store_transactions;
CREATE TRIGGER identity_enforce_buyback BEFORE INSERT ON public.store_transactions
  FOR EACH ROW EXECUTE FUNCTION public.identity_enforce_buyback();

-- ── Carry over the first version's statuses ─────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'identity_status') THEN
    INSERT INTO public.identity_profiles (account_id, legal_name, verification_status)
    SELECT p.id, p.full_name, CASE WHEN p.identity_status IN ('manual_review', 'failed') THEN p.identity_status ELSE 'unverified' END
      FROM public.profiles p WHERE p.identity_status IS DISTINCT FROM 'unverified'
    ON CONFLICT (account_id) DO NOTHING;
  END IF;
END $$;
-- The first version's functions are replaced by the Edge Function API.
DROP FUNCTION IF EXISTS public.identity_customer_status(uuid, uuid);
DROP FUNCTION IF EXISTS public.identity_begin(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.identity_cancel(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.identity_submit_manual_review(uuid, uuid, jsonb, text[], text);
DROP FUNCTION IF EXISTS public.identity_review_queue();
DROP FUNCTION IF EXISTS public.identity_review_decide(uuid, text, text);
DROP FUNCTION IF EXISTS public.identity_record_automated_result(uuid, text, jsonb, text[]);
DROP FUNCTION IF EXISTS public.identity_am_reviewer();

-- ── Decisions (service role only; called by the Edge Function) ──────────────
-- Applies a decision to a session and the person's overall status.
-- A failed attempt never removes an existing valid verification; revocation
-- is a separate, explicit action (identity_revoke).
CREATE OR REPLACE FUNCTION public.identity_decide(p_session_id uuid, p_status text, p_method text, p_actor uuid, p_actor_type text, p_note text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s record; v_profile public.identity_profiles; v_expiry date; v_new text;
BEGIN
  IF p_status NOT IN ('verified', 'failed', 'manual_review', 'processing') THEN RAISE EXCEPTION 'Unknown decision %', p_status; END IF;
  SELECT * INTO s FROM public.identity_verification_sessions WHERE id = p_session_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Session not found'; END IF;
  SELECT * INTO v_profile FROM public.identity_profiles WHERE id = s.identity_profile_id FOR UPDATE;

  UPDATE public.identity_verification_sessions
     SET status = p_status, completed_at = CASE WHEN p_status IN ('verified', 'failed') THEN now() ELSE completed_at END
   WHERE id = s.id;

  IF p_status = 'verified' THEN
    BEGIN v_expiry := (s.document_details->>'expiry_date')::date; EXCEPTION WHEN others THEN v_expiry := NULL; END;
    UPDATE public.identity_profiles SET
      verification_status = 'verified', verified_at = now(), verification_expires_at = v_expiry::timestamptz + interval '1 day',
      verified_document_type = s.document_type, verified_method = p_method, verified_session_id = s.id,
      legal_name = COALESCE(NULLIF(btrim(s.document_details->>'full_name'), ''), legal_name),
      verified_date_of_birth = CASE WHEN COALESCE(s.document_details->>'date_of_birth', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (s.document_details->>'date_of_birth')::date ELSE verified_date_of_birth END,
      revoked_at = NULL, revoked_reason = NULL, is_demo = false, updated_at = now()
     WHERE id = v_profile.id;
    v_new := 'verified';
  ELSIF public.identity_effective_status(v_profile) = 'verified' THEN
    v_new := 'verified'; -- keep the earlier valid verification
  ELSE
    UPDATE public.identity_profiles SET verification_status = p_status, updated_at = now() WHERE id = v_profile.id;
    v_new := p_status;
  END IF;

  PERFORM public.identity_audit(v_profile.id, s.id, p_actor, p_actor_type, 'decision_' || p_status,
    jsonb_build_object('method', p_method, 'note', p_note, 'profile_status', v_new));
  RETURN v_new;
END $$;
REVOKE ALL ON FUNCTION public.identity_decide(uuid, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.identity_revoke(p_account_id uuid, p_reason text, p_actor uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NULLIF(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'A reason is required to revoke.'; END IF;
  UPDATE public.identity_profiles SET verification_status = 'revoked', revoked_at = now(), revoked_reason = btrim(p_reason),
         portrait_path = NULL, portrait_status = 'none', portrait_source = NULL, updated_at = now()
   WHERE account_id = p_account_id RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN PERFORM public.identity_audit(v_id, NULL, p_actor, 'reviewer', 'revoked', jsonb_build_object('reason', p_reason)); END IF;
END $$;
REVOKE ALL ON FUNCTION public.identity_revoke(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- ── Retention ───────────────────────────────────────────────────────────────
-- Evidence to delete: decided or abandoned sessions (the Edge Function's
-- purge removes the files and marks them deleted).
CREATE OR REPLACE FUNCTION public.identity_evidence_due_for_deletion(p_after interval DEFAULT interval '7 days')
RETURNS TABLE (id uuid, storage_path text)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT e.id, e.storage_path FROM public.identity_evidence e
    JOIN public.identity_verification_sessions s ON s.id = e.session_id
   WHERE e.deleted_at IS NULL
     AND ((s.status IN ('verified', 'failed', 'cancelled', 'expired') AND COALESCE(s.completed_at, s.expires_at) < now() - p_after)
       OR (s.status IN ('pending', 'awaiting_capture') AND s.expires_at < now()))
$$;
REVOKE ALL ON FUNCTION public.identity_evidence_due_for_deletion(interval) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.identity_purge_details(p_older_than interval DEFAULT interval '90 days')
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.identity_verification_sessions SET status = 'expired'
   WHERE status IN ('pending', 'awaiting_capture') AND expires_at < now();
  UPDATE public.identity_mobile_links SET revoked_at = now() WHERE revoked_at IS NULL AND completed_at IS NULL AND expires_at < now();
  UPDATE public.identity_verification_sessions SET document_details = NULL
   WHERE document_details IS NOT NULL AND completed_at IS NOT NULL AND completed_at < now() - p_older_than;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN PERFORM public.identity_audit(NULL, NULL, NULL, 'system', 'details_purged', jsonb_build_object('sessions', v_count)); END IF;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.identity_purge_details(interval) FROM PUBLIC, anon, authenticated;
