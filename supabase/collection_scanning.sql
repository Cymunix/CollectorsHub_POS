-- Collector scanning: stores scan items into collectors' own CollectorsHub
-- collections (Scan Centre -> Collector Collection).
--
--   Express Scan          the collector is at the counter; a 60-minute session
--   Collection Drop-Off   the collector leaves a collection; scanned over days
--
-- Both use an intake job (collection_intake_jobs). Scans are saved as DRAFT
-- entries on the job (collection_intake_items) and only reach the collector's
-- collection at Finalise Import, as new owned_copies (acquisition_type
-- 'store_scan'). Nothing here reads or writes store stock, costs or prices.
--
-- Authorisation (collection_scan_authorisations):
--   * Finding a collector or scanning their membership QR grants nothing.
--   * The collector approves while signed in to their own account
--     (cs_decide_authorisation checks auth.uid()), on collectorshub.ca.
--   * Scope: add new items to their collection through this one job. Existing
--     collection items can't be changed or removed through it.
--   * Valid until the earliest of: job completion, revocation, expiry (Express
--     60 minutes, Drop-Off 30 days by default; the collector can extend),
--     or cancellation. Expired / revoked stops further saves and imports;
--     completed work and the audit trail are kept.
--
-- Physical custody (custody_status) is tracked separately from scanning, so a
-- finished import never closes a job: the collection has to be handed back.
--
-- Idempotency: each scanned card is saved once per job (client_key); an import
-- batch runs once per idempotency key; imported entries are never imported again.
--
-- Run after the website's owned_copies / collections migrations and store_features.sql. Rerunnable.

-- New acquisition type for copies scanned in by a store.
ALTER TABLE public.owned_copies DROP CONSTRAINT IF EXISTS owned_copies_acquisition_type_check;
ALTER TABLE public.owned_copies ADD CONSTRAINT owned_copies_acquisition_type_check
  CHECK (acquisition_type IN ('direct', 'store', 'user', 'gift', 'box_set', 'bulk', 'store_scan'));

-- ── Tables ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.collection_intake_reference_counters (
  year  integer PRIMARY KEY,
  last  integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.collection_intake_jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              text NOT NULL UNIQUE,            -- CH-2026-00142
  kind                   text NOT NULL CHECK (kind IN ('express', 'dropoff')),
  store_id               uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  location_id            uuid REFERENCES public.store_locations(id) ON DELETE SET NULL,
  collector_user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status                 text NOT NULL DEFAULT 'pending_authorisation' CHECK (status IN (
                           'pending_authorisation', 'awaiting_intake', 'received', 'scanning', 'paused', 'needs_review',
                           'ready_to_finalise', 'importing', 'ready_for_collection', 'completed', 'cancelled')),
  custody_status         text NOT NULL DEFAULT 'not_received' CHECK (custody_status IN ('not_received', 'in_store', 'partially_returned', 'returned', 'not_applicable')),
  categories             text[] NOT NULL DEFAULT '{}',
  estimated_items        integer CHECK (estimated_items IS NULL OR estimated_items >= 0), -- an estimate, never a verified count
  handling_instructions  text,
  customer_notes         text,
  contact                jsonb NOT NULL DEFAULT '{}'::jsonb, -- only what the collector allowed for this job
  terms                  text,
  expected_completion    date,
  created_by_user        uuid,
  created_by_employee    uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  assigned_employee      uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  received_at            timestamptz,
  received_by_employee   uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  received_acknowledged_by text,                          -- name the collector typed at handover
  returned_at            timestamptz,
  last_activity_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_reason       text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz
);
CREATE INDEX IF NOT EXISTS collection_intake_jobs_store_idx ON public.collection_intake_jobs (store_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS collection_intake_jobs_collector_idx ON public.collection_intake_jobs (collector_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.collection_scan_authorisations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES public.collection_intake_jobs(id) ON DELETE CASCADE,
  collector_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  store_id          uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  scope             text NOT NULL DEFAULT 'add_items_to_collection',
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'revoked', 'expired', 'completed', 'cancelled')),
  duration_minutes  integer NOT NULL,                     -- granted on approval
  requested_by_user uuid,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  request_expires_at timestamptz NOT NULL DEFAULT now() + interval '2 days', -- an unanswered request lapses
  decided_at        timestamptz,
  expires_at        timestamptz,                          -- the approval's expiry
  revoked_at        timestamptz,
  extended_count    integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS collection_scan_authorisations_job_idx ON public.collection_scan_authorisations (job_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS collection_scan_authorisations_collector_idx ON public.collection_scan_authorisations (collector_user_id, status);

CREATE TABLE IF NOT EXISTS public.collection_intake_containers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES public.collection_intake_jobs(id) ON DELETE CASCADE,
  code             text NOT NULL UNIQUE,                  -- CH-2026-00142-B01
  kind             text NOT NULL CHECK (kind IN ('box', 'binder', 'case', 'bag', 'other')),
  description      text,
  condition_notes  text,
  estimated_items  integer CHECK (estimated_items IS NULL OR estimated_items >= 0),
  returned_at      timestamptz,
  returned_by_employee uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collection_intake_containers_job_idx ON public.collection_intake_containers (job_id);

CREATE TABLE IF NOT EXISTS public.collection_import_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES public.collection_intake_jobs(id) ON DELETE CASCADE,
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  entries_imported integer NOT NULL DEFAULT 0,
  copies_created   integer NOT NULL DEFAULT 0,
  started_by_user  uuid,
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

CREATE TABLE IF NOT EXISTS public.collection_intake_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid NOT NULL REFERENCES public.collection_intake_jobs(id) ON DELETE CASCADE,
  container_id       uuid REFERENCES public.collection_intake_containers(id) ON DELETE SET NULL,
  client_key         text NOT NULL,                       -- the scanned card's id: saved once per job
  catalog_item_id    uuid,
  name_snapshot      text,
  category           text,
  condition          text,
  quantity           integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'needs_review', 'excluded', 'imported')),
  identification     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- AI result summary and match score
  image_ref          text,                                -- reference to the scan kept at the store (not uploaded)
  scanned_by_user    uuid,
  scanned_by_employee uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  import_batch_id    uuid REFERENCES public.collection_import_batches(id) ON DELETE SET NULL,
  imported_copy_ids  uuid[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, client_key)
);
CREATE INDEX IF NOT EXISTS collection_intake_items_job_idx ON public.collection_intake_items (job_id, status);

-- Append-only history (employees, authorisations, sessions, imports, handovers).
CREATE TABLE IF NOT EXISTS public.collection_intake_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES public.collection_intake_jobs(id) ON DELETE CASCADE,
  actor_user  uuid,
  actor_type  text NOT NULL,     -- employee | collector | system
  employee_id uuid,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collection_intake_events_job_idx ON public.collection_intake_events (job_id, id);

CREATE OR REPLACE FUNCTION public.cs_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'The collection intake history is append-only.'; END $$;
DROP TRIGGER IF EXISTS cs_events_append_only ON public.collection_intake_events;
CREATE TRIGGER cs_events_append_only BEFORE UPDATE OR DELETE ON public.collection_intake_events
  FOR EACH ROW EXECUTE FUNCTION public.cs_events_append_only();

-- Everything goes through the functions below.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['collection_intake_reference_counters', 'collection_intake_jobs', 'collection_scan_authorisations', 'collection_intake_containers',
                           'collection_import_batches', 'collection_intake_items', 'collection_intake_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- ── Helpers ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cs_log(p_job uuid, p_actor_type text, p_action text, p_detail jsonb DEFAULT '{}'::jsonb, p_employee uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.collection_intake_events (job_id, actor_user, actor_type, employee_id, action, detail)
  VALUES (p_job, auth.uid(), p_actor_type, p_employee, p_action, COALESCE(p_detail, '{}'::jsonb));
  UPDATE public.collection_intake_jobs SET last_activity_at = now() WHERE id = p_job;
$$;
REVOKE ALL ON FUNCTION public.cs_log(uuid, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;

-- The job, if the signed-in user is staff of its store (else an error).
CREATE OR REPLACE FUNCTION public.cs_staff_job(p_job_id uuid)
RETURNS public.collection_intake_jobs LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs;
BEGIN
  SELECT * INTO j FROM public.collection_intake_jobs WHERE id = p_job_id;
  IF j.id IS NULL OR j.store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'Intake job not found.'; END IF;
  RETURN j;
END $$;
REVOKE ALL ON FUNCTION public.cs_staff_job(uuid) FROM PUBLIC, anon, authenticated;

-- The job's current authorisation, with expiry applied.
CREATE OR REPLACE FUNCTION public.cs_current_authorisation(p_job_id uuid)
RETURNS public.collection_scan_authorisations LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.collection_scan_authorisations;
BEGIN
  SELECT * INTO a FROM public.collection_scan_authorisations WHERE job_id = p_job_id ORDER BY requested_at DESC LIMIT 1;
  IF a.id IS NOT NULL AND a.status = 'approved' AND a.expires_at < now() THEN
    UPDATE public.collection_scan_authorisations SET status = 'expired' WHERE id = a.id RETURNING * INTO a;
  ELSIF a.id IS NOT NULL AND a.status = 'pending' AND a.request_expires_at < now() THEN
    UPDATE public.collection_scan_authorisations SET status = 'expired' WHERE id = a.id RETURNING * INTO a;
  END IF;
  RETURN a;
END $$;
REVOKE ALL ON FUNCTION public.cs_current_authorisation(uuid) FROM PUBLIC, anon, authenticated;

-- Raises unless the job has an approved, unexpired, unrevoked authorisation.
CREATE OR REPLACE FUNCTION public.cs_require_authorisation(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.collection_scan_authorisations;
BEGIN
  a := public.cs_current_authorisation(p_job_id);
  IF a.id IS NULL OR a.status <> 'approved' THEN
    RAISE EXCEPTION 'The collector''s authorisation for this job is %. Ask them to approve it again.', COALESCE(a.status, 'missing')
      USING HINT = 'collection_authorisation_required';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.cs_require_authorisation(uuid) FROM PUBLIC, anon, authenticated;

-- Collector scanning is a per-store feature the organization turns on
-- (store_features.sql, feature 'collector_scanning'). New jobs need it on;
-- jobs already started can still be finished and their collections returned.
CREATE OR REPLACE FUNCTION public.cs_feature_enabled(p_store_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF to_regclass('public.store_features') IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM public.store_features WHERE store_id = p_store_id AND feature = 'collector_scanning' AND enabled);
END $$;
REVOKE ALL ON FUNCTION public.cs_feature_enabled(uuid) FROM PUBLIC, anon, authenticated;

-- ── Staff (POS) ─────────────────────────────────────────────────────────────
-- Create a job and ask the collector to authorise it. Returns the job.
CREATE OR REPLACE FUNCTION public.cs_create_job(p_store_id uuid, p_location_id uuid, p_collector_user_id uuid, p_kind text, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_year integer := extract(year FROM now())::int;
  v_seq integer;
  v_ref text;
  v_job uuid;
  v_auth uuid;
  v_employee uuid := public.myhr_employee_id(p_store_id);
  v_container jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_kind text;
  v_n integer;
BEGIN
  IF p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  IF p_kind NOT IN ('express', 'dropoff') THEN RAISE EXCEPTION 'Unknown scanning type.'; END IF;
  IF NOT public.cs_feature_enabled(p_store_id) THEN RAISE EXCEPTION 'Collector scanning isn''t turned on for this store. Head office can turn it on under Stores > Features.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_collector_user_id) THEN RAISE EXCEPTION 'CollectorsHub account not found.'; END IF;
  PERFORM public.ensure_store_customer_for_profile(p_store_id, p_collector_user_id);

  INSERT INTO public.collection_intake_reference_counters (year, last) VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE SET last = public.collection_intake_reference_counters.last + 1
  RETURNING last INTO v_seq;
  v_ref := format('CH-%s-%s', v_year, lpad(v_seq::text, 5, '0'));

  INSERT INTO public.collection_intake_jobs (reference, kind, store_id, location_id, collector_user_id, custody_status, categories, estimated_items,
         handling_instructions, customer_notes, contact, terms, expected_completion, created_by_user, created_by_employee, assigned_employee)
  VALUES (v_ref, p_kind, p_store_id, p_location_id, p_collector_user_id, CASE WHEN p_kind = 'express' THEN 'not_applicable' ELSE 'not_received' END,
          COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_details->'categories')), '{}'),
          NULLIF(p_details->>'estimated_items', '')::int,
          NULLIF(btrim(p_details->>'handling_instructions'), ''), NULLIF(btrim(p_details->>'customer_notes'), ''),
          COALESCE(p_details->'contact', '{}'::jsonb), NULLIF(btrim(p_details->>'terms'), ''),
          NULLIF(p_details->>'expected_completion', '')::date, auth.uid(), v_employee, v_employee)
  RETURNING id INTO v_job;

  -- Containers: B01.. boxes, C01.. binders/cases, X01.. others.
  FOR v_container IN SELECT * FROM jsonb_array_elements(COALESCE(p_details->'containers', '[]'::jsonb)) LOOP
    v_kind := COALESCE(NULLIF(v_container->>'kind', ''), 'box');
    IF v_kind NOT IN ('box', 'binder', 'case', 'bag', 'other') THEN v_kind := 'other'; END IF;
    v_n := COALESCE((v_counts->>v_kind)::int, 0) + 1;
    v_counts := v_counts || jsonb_build_object(v_kind, v_n);
    INSERT INTO public.collection_intake_containers (job_id, code, kind, description, condition_notes, estimated_items)
    VALUES (v_job, format('%s-%s%s', v_ref, CASE v_kind WHEN 'box' THEN 'B' WHEN 'binder' THEN 'C' WHEN 'case' THEN 'K' WHEN 'bag' THEN 'G' ELSE 'X' END, lpad(v_n::text, 2, '0')),
            v_kind, NULLIF(btrim(v_container->>'description'), ''), NULLIF(btrim(v_container->>'condition_notes'), ''),
            NULLIF(v_container->>'estimated_items', '')::int);
  END LOOP;

  INSERT INTO public.collection_scan_authorisations (job_id, collector_user_id, store_id, duration_minutes, requested_by_user)
  VALUES (v_job, p_collector_user_id, p_store_id, CASE WHEN p_kind = 'express' THEN 60 ELSE COALESCE(NULLIF(p_details->>'authorisation_days', '')::int, 30) * 1440 END, auth.uid())
  RETURNING id INTO v_auth;

  PERFORM public.cs_log(v_job, 'employee', 'job_created', jsonb_build_object('kind', p_kind, 'reference', v_ref), v_employee);
  PERFORM public.cs_log(v_job, 'employee', 'authorisation_requested', jsonb_build_object('authorisation_id', v_auth), v_employee);
  RETURN jsonb_build_object('job_id', v_job, 'reference', v_ref, 'authorisation_id', v_auth);
END $$;

-- Ask again (after a decline, expiry or revocation).
CREATE OR REPLACE FUNCTION public.cs_request_authorisation(p_job_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs; a public.collection_scan_authorisations; v_id uuid;
BEGIN
  j := public.cs_staff_job(p_job_id);
  IF j.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This job is closed.'; END IF;
  a := public.cs_current_authorisation(p_job_id);
  IF a.status IN ('pending', 'approved') THEN RETURN a.id; END IF;
  INSERT INTO public.collection_scan_authorisations (job_id, collector_user_id, store_id, duration_minutes, requested_by_user)
  VALUES (j.id, j.collector_user_id, j.store_id, CASE WHEN j.kind = 'express' THEN 60 ELSE 30 * 1440 END, auth.uid())
  RETURNING id INTO v_id;
  PERFORM public.cs_log(j.id, 'employee', 'authorisation_requested', jsonb_build_object('authorisation_id', v_id), public.myhr_employee_id(j.store_id));
  RETURN v_id;
END $$;

-- Job list with progress (search and status filter).
DROP FUNCTION IF EXISTS public.cs_jobs(uuid, text, text, text);
CREATE OR REPLACE FUNCTION public.cs_jobs(p_store_id uuid, p_kind text DEFAULT 'dropoff', p_filter text DEFAULT 'active', p_search text DEFAULT '')
RETURNS TABLE (id uuid, reference text, kind text, status text, custody_status text, collector_name text, collector_username text,
               location_name text, received_at timestamptz, container_count integer, estimated_items integer, scanned integer, needs_review integer, imported integer,
               authorisation_status text, authorisation_expires_at timestamptz, assigned_employee_name text, last_activity_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  RETURN QUERY
  SELECT j.id, j.reference, j.kind, j.status, j.custody_status,
         COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.display_name), ''), p.username), p.username,
         l.location_name, j.received_at,
         (SELECT count(*)::int FROM public.collection_intake_containers c WHERE c.job_id = j.id),
         j.estimated_items,
         COALESCE((SELECT sum(i.quantity)::int FROM public.collection_intake_items i WHERE i.job_id = j.id AND i.status <> 'excluded'), 0),
         COALESCE((SELECT count(*)::int FROM public.collection_intake_items i WHERE i.job_id = j.id AND i.status = 'needs_review'), 0),
         COALESCE((SELECT sum(i.quantity)::int FROM public.collection_intake_items i WHERE i.job_id = j.id AND i.status = 'imported'), 0),
         (public.cs_current_authorisation(j.id)).status, (public.cs_current_authorisation(j.id)).expires_at,
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username),
         j.last_activity_at, j.created_at
    FROM public.collection_intake_jobs j
    JOIN public.profiles p ON p.id = j.collector_user_id
    LEFT JOIN public.store_locations l ON l.id = j.location_id
    LEFT JOIN public.store_employees e ON e.id = j.assigned_employee
   WHERE j.store_id = p_store_id
     AND (p_kind IS NULL OR p_kind = '' OR j.kind = p_kind)
     AND CASE p_filter
           WHEN 'active' THEN j.status NOT IN ('pending_authorisation', 'completed', 'cancelled')
           WHEN 'pending' THEN j.status = 'pending_authorisation'
           WHEN 'completed' THEN j.status = 'completed'
           WHEN 'cancelled' THEN j.status = 'cancelled'
           ELSE true END
     AND (COALESCE(btrim(p_search), '') = '' OR j.reference ILIKE '%' || btrim(p_search) || '%' OR p.username ILIKE '%' || btrim(p_search) || '%'
          OR COALESCE(p.full_name, p.display_name, '') ILIKE '%' || btrim(p_search) || '%')
   ORDER BY j.last_activity_at DESC
   LIMIT 500;
END $$;

-- One job: header, authorisation, containers, item counts and recent history.
CREATE OR REPLACE FUNCTION public.cs_job(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs; a public.collection_scan_authorisations;
BEGIN
  j := public.cs_staff_job(p_job_id);
  a := public.cs_current_authorisation(p_job_id);
  RETURN jsonb_build_object(
    'job', to_jsonb(j) - 'contact' || jsonb_build_object('contact', j.contact),
    'collector', (SELECT jsonb_build_object('id', p.id, 'username', p.username, 'name', COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.display_name), ''), p.username), 'avatar_url', p.avatar_url)
                    FROM public.profiles p WHERE p.id = j.collector_user_id),
    'store', (SELECT jsonb_build_object('name', s.store_name) FROM public.stores s WHERE s.id = j.store_id),
    'location', (SELECT jsonb_build_object('name', l.location_name, 'address', concat_ws(', ', l.street_address, l.city, l.province)) FROM public.store_locations l WHERE l.id = j.location_id),
    'authorisation', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id', a.id, 'status', a.status, 'expires_at', a.expires_at, 'requested_at', a.requested_at, 'decided_at', a.decided_at, 'duration_minutes', a.duration_minutes) END,
    'containers', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.code) FROM public.collection_intake_containers c WHERE c.job_id = j.id), '[]'::jsonb),
    'counts', (SELECT jsonb_build_object(
                 'scanned', COALESCE(sum(quantity) FILTER (WHERE status <> 'excluded'), 0),
                 'recognised', COALESCE(sum(quantity) FILTER (WHERE status IN ('draft', 'imported')), 0),
                 'needs_review', COUNT(*) FILTER (WHERE status = 'needs_review'),
                 'imported', COALESCE(sum(quantity) FILTER (WHERE status = 'imported'), 0),
                 'ready', COALESCE(sum(quantity) FILTER (WHERE status = 'draft' AND catalog_item_id IS NOT NULL), 0),
                 'excluded', COUNT(*) FILTER (WHERE status = 'excluded'))
               FROM public.collection_intake_items WHERE job_id = j.id),
    'events', COALESCE((SELECT jsonb_agg(x ORDER BY x.id DESC) FROM (
                 SELECT ev.id, ev.created_at, ev.actor_type, ev.action, ev.detail,
                        COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username) AS employee_name
                   FROM public.collection_intake_events ev LEFT JOIN public.store_employees e ON e.id = ev.employee_id
                  WHERE ev.job_id = j.id ORDER BY ev.id DESC LIMIT 200) x), '[]'::jsonb)
  );
END $$;

-- Draft entries (paged).
CREATE OR REPLACE FUNCTION public.cs_job_items(p_job_id uuid, p_status text DEFAULT NULL, p_container_id uuid DEFAULT NULL, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
RETURNS SETOF public.collection_intake_items LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.cs_staff_job(p_job_id);
  RETURN QUERY SELECT * FROM public.collection_intake_items i
   WHERE i.job_id = p_job_id AND (p_status IS NULL OR i.status = p_status) AND (p_container_id IS NULL OR i.container_id = p_container_id)
   ORDER BY i.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 1000) OFFSET GREATEST(p_offset, 0);
END $$;

-- Add containers to an existing job.
CREATE OR REPLACE FUNCTION public.cs_add_container(p_job_id uuid, p_kind text, p_description text, p_condition_notes text, p_estimated_items integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs; v_kind text := COALESCE(NULLIF(p_kind, ''), 'box'); v_n integer; v_row public.collection_intake_containers;
BEGIN
  j := public.cs_staff_job(p_job_id);
  IF j.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This job is closed.'; END IF;
  IF v_kind NOT IN ('box', 'binder', 'case', 'bag', 'other') THEN v_kind := 'other'; END IF;
  SELECT count(*) + 1 INTO v_n FROM public.collection_intake_containers WHERE job_id = j.id AND kind = v_kind;
  INSERT INTO public.collection_intake_containers (job_id, code, kind, description, condition_notes, estimated_items)
  VALUES (j.id, format('%s-%s%s', j.reference, CASE v_kind WHEN 'box' THEN 'B' WHEN 'binder' THEN 'C' WHEN 'case' THEN 'K' WHEN 'bag' THEN 'G' ELSE 'X' END, lpad(v_n::text, 2, '0')),
          v_kind, NULLIF(btrim(p_description), ''), NULLIF(btrim(p_condition_notes), ''), p_estimated_items)
  RETURNING * INTO v_row;
  PERFORM public.cs_log(j.id, 'employee', 'container_added', jsonb_build_object('code', v_row.code), public.myhr_employee_id(j.store_id));
  RETURN to_jsonb(v_row);
END $$;

-- The collector hands over the collection (they type their name to acknowledge).
CREATE OR REPLACE FUNCTION public.cs_record_receipt(p_job_id uuid, p_acknowledged_by text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs; v_employee uuid;
BEGIN
  j := public.cs_staff_job(p_job_id);
  IF j.kind <> 'dropoff' THEN RAISE EXCEPTION 'Only drop-offs are handed over.'; END IF;
  IF j.custody_status <> 'not_received' THEN RAISE EXCEPTION 'This collection was already received.'; END IF;
  IF length(btrim(COALESCE(p_acknowledged_by, ''))) < 2 THEN RAISE EXCEPTION 'The collector types their name to acknowledge the handover.'; END IF;
  v_employee := public.myhr_employee_id(j.store_id);
  UPDATE public.collection_intake_jobs SET custody_status = 'in_store', received_at = now(), received_by_employee = v_employee,
         received_acknowledged_by = btrim(p_acknowledged_by),
         status = CASE WHEN status IN ('pending_authorisation') THEN status ELSE 'received' END
   WHERE id = j.id;
  PERFORM public.cs_log(j.id, 'employee', 'collection_received', jsonb_build_object('acknowledged_by', btrim(p_acknowledged_by),
          'containers', (SELECT count(*) FROM public.collection_intake_containers WHERE job_id = j.id)), v_employee);
END $$;

-- Save one scanned card as a draft entry (once per client_key).
CREATE OR REPLACE FUNCTION public.cs_save_item(p_job_id uuid, p_container_id uuid, p_client_key text, p_catalog_item_id uuid, p_name text,
                                               p_category text, p_condition text, p_quantity integer, p_identification jsonb, p_image_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs; v_row public.collection_intake_items; v_employee uuid;
BEGIN
  j := public.cs_staff_job(p_job_id);
  IF j.status IN ('importing', 'ready_for_collection', 'completed', 'cancelled') THEN RAISE EXCEPTION 'This job is no longer taking scans (%).', j.status; END IF;
  PERFORM public.cs_require_authorisation(j.id);
  IF NULLIF(btrim(p_client_key), '') IS NULL THEN RAISE EXCEPTION 'Missing scan key.'; END IF;
  IF p_container_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.collection_intake_containers WHERE id = p_container_id AND job_id = j.id) THEN
    RAISE EXCEPTION 'That container isn''t part of this job.';
  END IF;
  v_employee := public.myhr_employee_id(j.store_id);
  INSERT INTO public.collection_intake_items (job_id, container_id, client_key, catalog_item_id, name_snapshot, category, condition, quantity, status,
         identification, image_ref, scanned_by_user, scanned_by_employee)
  VALUES (j.id, p_container_id, btrim(p_client_key), p_catalog_item_id, NULLIF(btrim(p_name), ''), NULLIF(btrim(p_category), ''), NULLIF(btrim(p_condition), ''),
          GREATEST(1, LEAST(COALESCE(p_quantity, 1), 999)), CASE WHEN p_catalog_item_id IS NULL THEN 'needs_review' ELSE 'draft' END,
          COALESCE(p_identification, '{}'::jsonb), NULLIF(btrim(p_image_ref), ''), auth.uid(), v_employee)
  ON CONFLICT (job_id, client_key) DO UPDATE SET
    catalog_item_id = EXCLUDED.catalog_item_id, name_snapshot = EXCLUDED.name_snapshot, condition = EXCLUDED.condition, quantity = EXCLUDED.quantity,
    status = EXCLUDED.status, identification = EXCLUDED.identification, container_id = EXCLUDED.container_id, updated_at = now()
    WHERE public.collection_intake_items.status <> 'imported'
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN SELECT * INTO v_row FROM public.collection_intake_items WHERE job_id = j.id AND client_key = btrim(p_client_key); END IF;
  IF j.status IN ('awaiting_intake', 'received', 'paused', 'needs_review', 'ready_to_finalise') THEN
    UPDATE public.collection_intake_jobs SET status = 'scanning' WHERE id = j.id;
  END IF;
  UPDATE public.collection_intake_jobs SET last_activity_at = now() WHERE id = j.id;
  RETURN to_jsonb(v_row);
END $$;

-- Correct a draft (catalogue match, condition, quantity, container, or exclude / back to review).
CREATE OR REPLACE FUNCTION public.cs_update_item(p_item_id uuid, p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.collection_intake_items; j public.collection_intake_jobs; v_status text;
BEGIN
  SELECT * INTO i FROM public.collection_intake_items WHERE id = p_item_id;
  IF i.id IS NULL THEN RAISE EXCEPTION 'Entry not found.'; END IF;
  j := public.cs_staff_job(i.job_id);
  IF i.status = 'imported' THEN RAISE EXCEPTION 'This entry is already in the collector''s collection.'; END IF;
  IF j.status IN ('importing', 'completed', 'cancelled') THEN RAISE EXCEPTION 'This job is no longer editable.'; END IF;
  v_status := CASE
    WHEN p_patch->>'status' = 'excluded' THEN 'excluded'
    WHEN p_patch ? 'catalog_item_id' AND NULLIF(p_patch->>'catalog_item_id', '') IS NOT NULL THEN 'draft'
    WHEN p_patch->>'status' IN ('draft', 'needs_review') THEN p_patch->>'status'
    ELSE i.status END;
  IF v_status = 'draft' AND COALESCE(NULLIF(p_patch->>'catalog_item_id', '')::uuid, i.catalog_item_id) IS NULL THEN v_status := 'needs_review'; END IF;
  UPDATE public.collection_intake_items SET
    catalog_item_id = CASE WHEN p_patch ? 'catalog_item_id' THEN NULLIF(p_patch->>'catalog_item_id', '')::uuid ELSE catalog_item_id END,
    name_snapshot = COALESCE(NULLIF(btrim(p_patch->>'name'), ''), name_snapshot),
    condition = COALESCE(NULLIF(btrim(p_patch->>'condition'), ''), condition),
    quantity = COALESCE(GREATEST(1, LEAST((p_patch->>'quantity')::int, 999)), quantity),
    container_id = CASE WHEN p_patch ? 'container_id' THEN NULLIF(p_patch->>'container_id', '')::uuid ELSE container_id END,
    status = v_status, updated_at = now()
   WHERE id = i.id RETURNING * INTO i;
  PERFORM public.cs_log(j.id, 'employee', 'entry_corrected', jsonb_build_object('item_id', i.id, 'changes', p_patch), public.myhr_employee_id(j.store_id));
  RETURN to_jsonb(i);
END $$;

-- Pause / resume / mark ready / mark ready for collection.
CREATE OR REPLACE FUNCTION public.cs_set_status(p_job_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs;
BEGIN
  j := public.cs_staff_job(p_job_id);
  IF p_status NOT IN ('scanning', 'paused', 'needs_review', 'ready_to_finalise') THEN RAISE EXCEPTION 'That status is set automatically.'; END IF;
  IF j.status IN ('pending_authorisation', 'importing', 'ready_for_collection', 'completed', 'cancelled') THEN RAISE EXCEPTION 'This job is %.', replace(j.status, '_', ' '); END IF;
  UPDATE public.collection_intake_jobs SET status = p_status WHERE id = j.id;
  PERFORM public.cs_log(j.id, 'employee', 'status_' || p_status, '{}'::jsonb, public.myhr_employee_id(j.store_id));
END $$;

-- Finalise Import: draft entries with a catalogue match become new copies in
-- the collector's collection. Safe to retry with the same key.
CREATE OR REPLACE FUNCTION public.cs_finalise_import(p_job_id uuid, p_idempotency_key text, p_exclude_unresolved boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j public.collection_intake_jobs;
  b public.collection_import_batches;
  i public.collection_intake_items;
  v_collection uuid;
  v_copy uuid;
  v_copies uuid[];
  v_entries integer := 0;
  v_total integer := 0;
  v_n integer;
  v_employee uuid;
BEGIN
  j := public.cs_staff_job(p_job_id);
  IF NULLIF(btrim(p_idempotency_key), '') IS NULL THEN RAISE EXCEPTION 'Missing import key.'; END IF;
  SELECT * INTO b FROM public.collection_import_batches WHERE idempotency_key = btrim(p_idempotency_key);
  IF b.id IS NOT NULL AND b.status = 'completed' THEN
    RETURN jsonb_build_object('batch_id', b.id, 'entries_imported', b.entries_imported, 'copies_created', b.copies_created, 'repeated', true);
  END IF;
  IF j.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This job is closed.'; END IF;
  PERFORM public.cs_require_authorisation(j.id);
  -- Lock the job so two imports can't run at once.
  PERFORM 1 FROM public.collection_intake_jobs WHERE id = j.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.collection_intake_items WHERE job_id = j.id AND status = 'needs_review') THEN
    IF NOT p_exclude_unresolved THEN RAISE EXCEPTION 'Some entries still need review. Resolve them, or choose to leave them out.' USING HINT = 'needs_review'; END IF;
    UPDATE public.collection_intake_items SET status = 'excluded', updated_at = now() WHERE job_id = j.id AND status = 'needs_review';
  END IF;
  v_employee := public.myhr_employee_id(j.store_id);

  IF b.id IS NULL THEN
    INSERT INTO public.collection_import_batches (job_id, idempotency_key, started_by_user) VALUES (j.id, btrim(p_idempotency_key), auth.uid()) RETURNING * INTO b;
  END IF;
  UPDATE public.collection_intake_jobs SET status = 'importing' WHERE id = j.id;
  v_collection := public.ensure_default_collection_for_user(j.collector_user_id);

  FOR i IN SELECT * FROM public.collection_intake_items WHERE job_id = j.id AND status = 'draft' AND catalog_item_id IS NOT NULL ORDER BY created_at FOR UPDATE LOOP
    IF NOT EXISTS (SELECT 1 FROM public.items it WHERE it.item_id = i.catalog_item_id) THEN
      UPDATE public.collection_intake_items SET status = 'needs_review', updated_at = now(),
             identification = identification || jsonb_build_object('import_note', 'Catalogue item not found at import') WHERE id = i.id;
      CONTINUE;
    END IF;
    v_copies := '{}';
    FOR v_n IN 1..i.quantity LOOP
      INSERT INTO public.owned_copies (user_id, catalog_item_id, condition, collection_id, acquisition_type, metadata)
      VALUES (j.collector_user_id, i.catalog_item_id, i.condition, v_collection, 'store_scan',
              jsonb_build_object('source', 'store_scan', 'intake_job_id', j.id, 'intake_reference', j.reference, 'intake_item_id', i.id,
                                 'store_id', j.store_id, 'batch_id', b.id, 'name_snapshot', i.name_snapshot))
      RETURNING id INTO v_copy;
      v_copies := v_copies || v_copy;
    END LOOP;
    UPDATE public.collection_intake_items SET status = 'imported', import_batch_id = b.id, imported_copy_ids = v_copies, updated_at = now() WHERE id = i.id;
    -- Like store purchases: an item now owned leaves the wishlist.
    DELETE FROM public.wishlist_items WHERE user_id = j.collector_user_id AND catalog_item_id = i.catalog_item_id;
    v_entries := v_entries + 1;
    v_total := v_total + i.quantity;
  END LOOP;

  UPDATE public.collection_import_batches SET status = 'completed', entries_imported = v_entries, copies_created = v_total, completed_at = now() WHERE id = b.id;
  -- Express: done. Drop-off: wait for the collection to go back.
  UPDATE public.collection_intake_jobs SET
    status = CASE WHEN EXISTS (SELECT 1 FROM public.collection_intake_items WHERE job_id = j.id AND status = 'needs_review') THEN 'needs_review'
                  WHEN kind = 'express' OR custody_status IN ('returned', 'not_applicable') THEN 'completed'
                  ELSE 'ready_for_collection' END,
    completed_at = CASE WHEN kind = 'express' OR custody_status = 'returned' THEN now() ELSE completed_at END
   WHERE id = j.id;
  IF j.kind = 'express' THEN
    UPDATE public.collection_scan_authorisations SET status = 'completed' WHERE job_id = j.id AND status = 'approved';
  END IF;
  PERFORM public.cs_log(j.id, 'employee', 'import_completed', jsonb_build_object('batch_id', b.id, 'entries', v_entries, 'copies', v_total), v_employee);
  RETURN jsonb_build_object('batch_id', b.id, 'entries_imported', v_entries, 'copies_created', v_total, 'repeated', false);
END $$;

-- The collection goes back to the collector (all or some containers).
CREATE OR REPLACE FUNCTION public.cs_record_return(p_job_id uuid, p_container_ids uuid[], p_recipient_name text, p_discrepancies text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs; v_employee uuid; v_left integer;
BEGIN
  j := public.cs_staff_job(p_job_id);
  IF j.custody_status NOT IN ('in_store', 'partially_returned') THEN RAISE EXCEPTION 'The store doesn''t hold this collection.'; END IF;
  IF length(btrim(COALESCE(p_recipient_name, ''))) < 2 THEN RAISE EXCEPTION 'The person collecting types their name to acknowledge it.'; END IF;
  v_employee := public.myhr_employee_id(j.store_id);
  UPDATE public.collection_intake_containers SET returned_at = now(), returned_by_employee = v_employee
   WHERE job_id = j.id AND returned_at IS NULL AND (p_container_ids IS NULL OR id = ANY (p_container_ids));
  SELECT count(*) INTO v_left FROM public.collection_intake_containers WHERE job_id = j.id AND returned_at IS NULL;
  UPDATE public.collection_intake_jobs SET
    custody_status = CASE WHEN v_left = 0 THEN 'returned' ELSE 'partially_returned' END,
    returned_at = CASE WHEN v_left = 0 THEN now() ELSE returned_at END,
    status = CASE WHEN v_left = 0 AND status = 'ready_for_collection' THEN 'completed' ELSE status END,
    completed_at = CASE WHEN v_left = 0 AND status = 'ready_for_collection' THEN now() ELSE completed_at END
   WHERE id = j.id;
  PERFORM public.cs_log(j.id, 'employee', CASE WHEN v_left = 0 THEN 'collection_returned' ELSE 'collection_partly_returned' END,
          jsonb_build_object('recipient', btrim(p_recipient_name), 'containers', p_container_ids, 'discrepancies', NULLIF(btrim(p_discrepancies), ''), 'still_held', v_left), v_employee);
  IF v_left = 0 AND j.status = 'ready_for_collection' THEN
    UPDATE public.collection_scan_authorisations SET status = 'completed' WHERE job_id = j.id AND status = 'approved';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.cs_cancel_job(p_job_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs;
BEGIN
  j := public.cs_staff_job(p_job_id);
  IF j.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This job is already closed.'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Give a reason for cancelling.'; END IF;
  IF j.custody_status IN ('in_store', 'partially_returned') THEN RAISE EXCEPTION 'Return the collection to the collector before cancelling.'; END IF;
  UPDATE public.collection_intake_jobs SET status = 'cancelled', cancelled_reason = btrim(p_reason), completed_at = now() WHERE id = j.id;
  UPDATE public.collection_scan_authorisations SET status = 'cancelled' WHERE job_id = j.id AND status IN ('pending', 'approved');
  PERFORM public.cs_log(j.id, 'employee', 'job_cancelled', jsonb_build_object('reason', btrim(p_reason)), public.myhr_employee_id(j.store_id));
END $$;

-- ── Collector (signed in to their own CollectorsHub account) ────────────────
CREATE OR REPLACE FUNCTION public.cs_my_scanning()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Sign in to see your scanning requests.'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY x.requested_at DESC) FROM (
    SELECT a.id AS authorisation_id, a.status AS authorisation_status, a.requested_at, a.expires_at, a.request_expires_at, a.duration_minutes,
           j.id AS job_id, j.reference, j.kind, j.status AS job_status, j.custody_status, j.received_at, j.returned_at, j.estimated_items,
           j.received_acknowledged_by, j.expected_completion, j.terms,
           s.store_name, l.location_name, concat_ws(', ', l.street_address, l.city, l.province) AS location_address,
           (SELECT COALESCE(sum(i.quantity) FILTER (WHERE i.status <> 'excluded'), 0) FROM public.collection_intake_items i WHERE i.job_id = j.id) AS scanned,
           (SELECT COALESCE(sum(i.quantity) FILTER (WHERE i.status = 'imported'), 0) FROM public.collection_intake_items i WHERE i.job_id = j.id) AS imported,
           (SELECT jsonb_agg(jsonb_build_object('code', c.code, 'kind', c.kind, 'description', c.description, 'returned_at', c.returned_at) ORDER BY c.code)
              FROM public.collection_intake_containers c WHERE c.job_id = j.id) AS containers
      FROM public.collection_scan_authorisations a
      JOIN public.collection_intake_jobs j ON j.id = a.job_id
      JOIN public.stores s ON s.id = j.store_id
      LEFT JOIN public.store_locations l ON l.id = j.location_id
     WHERE a.collector_user_id = v_user
       AND a.id = (SELECT a2.id FROM public.collection_scan_authorisations a2 WHERE a2.job_id = j.id ORDER BY a2.requested_at DESC LIMIT 1)
     LIMIT 200) x), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.cs_decide_authorisation(p_authorisation_id uuid, p_approve boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.collection_scan_authorisations; j public.collection_intake_jobs;
BEGIN
  SELECT * INTO a FROM public.collection_scan_authorisations WHERE id = p_authorisation_id FOR UPDATE;
  IF a.id IS NULL OR a.collector_user_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Request not found.'; END IF;
  IF a.status <> 'pending' THEN RAISE EXCEPTION 'This request is already %.', a.status; END IF;
  IF a.request_expires_at < now() THEN
    UPDATE public.collection_scan_authorisations SET status = 'expired' WHERE id = a.id;
    RAISE EXCEPTION 'This request has expired. Ask the store to send a new one.';
  END IF;
  SELECT * INTO j FROM public.collection_intake_jobs WHERE id = a.job_id;
  IF p_approve THEN
    UPDATE public.collection_scan_authorisations SET status = 'approved', decided_at = now(), expires_at = now() + make_interval(mins => a.duration_minutes) WHERE id = a.id;
    UPDATE public.collection_intake_jobs SET status = CASE
             WHEN status <> 'pending_authorisation' THEN status
             WHEN custody_status IN ('in_store', 'not_applicable') THEN 'received'
             ELSE 'awaiting_intake' END
     WHERE id = j.id;
    PERFORM public.cs_log(j.id, 'collector', 'authorisation_approved', jsonb_build_object('authorisation_id', a.id, 'minutes', a.duration_minutes));
    RETURN 'approved';
  END IF;
  UPDATE public.collection_scan_authorisations SET status = 'declined', decided_at = now() WHERE id = a.id;
  PERFORM public.cs_log(j.id, 'collector', 'authorisation_declined', jsonb_build_object('authorisation_id', a.id));
  RETURN 'declined';
END $$;

CREATE OR REPLACE FUNCTION public.cs_revoke_authorisation(p_authorisation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.collection_scan_authorisations;
BEGIN
  SELECT * INTO a FROM public.collection_scan_authorisations WHERE id = p_authorisation_id FOR UPDATE;
  IF a.id IS NULL OR a.collector_user_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Request not found.'; END IF;
  IF a.status NOT IN ('pending', 'approved') THEN RAISE EXCEPTION 'This authorisation is already %.', a.status; END IF;
  UPDATE public.collection_scan_authorisations SET status = 'revoked', revoked_at = now() WHERE id = a.id;
  PERFORM public.cs_log(a.job_id, 'collector', 'authorisation_revoked', jsonb_build_object('authorisation_id', a.id));
END $$;

CREATE OR REPLACE FUNCTION public.cs_extend_authorisation(p_authorisation_id uuid, p_days integer)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.collection_scan_authorisations; j public.collection_intake_jobs; v_until timestamptz;
BEGIN
  SELECT * INTO a FROM public.collection_scan_authorisations WHERE id = p_authorisation_id FOR UPDATE;
  IF a.id IS NULL OR a.collector_user_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Request not found.'; END IF;
  SELECT * INTO j FROM public.collection_intake_jobs WHERE id = a.job_id;
  IF j.kind <> 'dropoff' THEN RAISE EXCEPTION 'Only drop-off authorisations can be extended.'; END IF;
  IF a.status NOT IN ('approved', 'expired') OR j.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This authorisation can''t be extended.'; END IF;
  IF p_days NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'Extend by 1 to 90 days.'; END IF;
  v_until := GREATEST(COALESCE(a.expires_at, now()), now()) + make_interval(days => p_days);
  UPDATE public.collection_scan_authorisations SET status = 'approved', expires_at = v_until, extended_count = extended_count + 1 WHERE id = a.id;
  PERFORM public.cs_log(j.id, 'collector', 'authorisation_extended', jsonb_build_object('authorisation_id', a.id, 'until', v_until));
  RETURN v_until;
END $$;

GRANT EXECUTE ON FUNCTION public.cs_create_job(uuid, uuid, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_request_authorisation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_jobs(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_job(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_job_items(uuid, text, uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_add_container(uuid, text, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_record_receipt(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_save_item(uuid, uuid, text, uuid, text, text, text, integer, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_update_item(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_set_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_finalise_import(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_record_return(uuid, uuid[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_cancel_job(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_my_scanning() TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_decide_authorisation(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_revoke_authorisation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cs_extend_authorisation(uuid, integer) TO authenticated;

-- ── Import check (before Add to Collection / Finalise Import) ───────────────
-- What would be imported, what still needs review, intentional duplicates
-- (several copies of one catalogue item), and whether the authorisation is
-- still valid. Nothing about the collector's existing collection is shown.
CREATE OR REPLACE FUNCTION public.cs_import_preview(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs; a public.collection_scan_authorisations;
BEGIN
  j := public.cs_staff_job(p_job_id);
  a := public.cs_current_authorisation(p_job_id);
  RETURN jsonb_build_object(
    'authorisation', jsonb_build_object('status', COALESCE(a.status, 'missing'), 'expires_at', a.expires_at, 'valid', a.status = 'approved'),
    'ready_entries', (SELECT count(*) FROM public.collection_intake_items WHERE job_id = j.id AND status = 'draft' AND catalog_item_id IS NOT NULL),
    'ready_items', (SELECT COALESCE(sum(quantity), 0) FROM public.collection_intake_items WHERE job_id = j.id AND status = 'draft' AND catalog_item_id IS NOT NULL),
    'needs_review', (SELECT count(*) FROM public.collection_intake_items WHERE job_id = j.id AND status = 'needs_review'),
    'missing_condition', (SELECT count(*) FROM public.collection_intake_items WHERE job_id = j.id AND status = 'draft' AND condition IS NULL),
    'already_imported', (SELECT COALESCE(sum(quantity), 0) FROM public.collection_intake_items WHERE job_id = j.id AND status = 'imported'),
    'duplicates', COALESCE((SELECT jsonb_agg(d ORDER BY d.copies DESC) FROM (
        SELECT catalog_item_id, max(name_snapshot) AS name, sum(quantity)::int AS copies,
               array_agg(DISTINCT condition) FILTER (WHERE condition IS NOT NULL) AS conditions
          FROM public.collection_intake_items
         WHERE job_id = j.id AND status = 'draft' AND catalog_item_id IS NOT NULL
         GROUP BY catalog_item_id HAVING sum(quantity) > 1
         ORDER BY sum(quantity) DESC LIMIT 50) d), '[]'::jsonb),
    'by_condition', COALESCE((SELECT jsonb_object_agg(COALESCE(condition, 'Not set'), n) FROM (
        SELECT condition, sum(quantity)::int AS n FROM public.collection_intake_items
         WHERE job_id = j.id AND status = 'draft' AND catalog_item_id IS NOT NULL GROUP BY condition) c), '{}'::jsonb)
  );
END $$;
GRANT EXECUTE ON FUNCTION public.cs_import_preview(uuid) TO authenticated;

-- ── Intake photographs (optional, taken at drop-off) ────────────────────────
-- Private bucket; files live under <store_id>/<job_id>/ and only that store's
-- staff can upload or view them. They belong to the store's intake record,
-- not to the collector's collection.
ALTER TABLE public.collection_intake_jobs ADD COLUMN IF NOT EXISTS photo_paths text[] NOT NULL DEFAULT '{}';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('collection-intake-photos', 'collection-intake-photos', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 10485760, allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

DROP POLICY IF EXISTS collection_intake_photos_insert ON storage.objects;
CREATE POLICY collection_intake_photos_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'collection-intake-photos' AND (storage.foldername(name))[1] IN (SELECT public.user_store_ids()::text));
DROP POLICY IF EXISTS collection_intake_photos_select ON storage.objects;
CREATE POLICY collection_intake_photos_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'collection-intake-photos' AND (storage.foldername(name))[1] IN (SELECT public.user_store_ids()::text));

-- Attach uploaded photos to a job (paths must be under that job's folder).
CREATE OR REPLACE FUNCTION public.cs_add_photos(p_job_id uuid, p_paths text[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.collection_intake_jobs; v_prefix text; v_paths text[];
BEGIN
  j := public.cs_staff_job(p_job_id);
  v_prefix := j.store_id::text || '/' || j.id::text || '/';
  SELECT array_agg(p) INTO v_paths FROM unnest(COALESCE(p_paths, '{}')) p WHERE p LIKE v_prefix || '%';
  IF COALESCE(array_length(v_paths, 1), 0) = 0 THEN RETURN 0; END IF;
  UPDATE public.collection_intake_jobs SET photo_paths = (SELECT array_agg(DISTINCT x) FROM unnest(photo_paths || v_paths) x) WHERE id = j.id;
  PERFORM public.cs_log(j.id, 'employee', 'photos_added', jsonb_build_object('count', array_length(v_paths, 1)), public.myhr_employee_id(j.store_id));
  RETURN array_length(v_paths, 1);
END $$;
GRANT EXECUTE ON FUNCTION public.cs_add_photos(uuid, text[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
