-- Retailer inventory onboarding (phase 1: intake, roles, pricing, QA).
--
-- A NORDVIK administrator opens an onboarding project for an approved store
-- (setup or active). Inventory arrives in batches (spreadsheet, existing POS
-- export, scanning or manual entry) as staged onboarding_items, which move
-- through Captured -> Awaiting Verification -> Awaiting Pricing -> Awaiting
-- Retailer Approval -> Ready for Sale. Staged items are NOT stock: only the
-- Ready for Sale step creates the store_inventory record and its "receive"
-- movement (apply_inventory_movement), so incomplete or unapproved records can
-- never be sold. eBay publication is tracked separately (marketplace_status)
-- and is built in phase 2.
--
-- Permissions are enforced here, not in the app. Retailer staff need the
-- per-employee action_permissions flag for each step (owners and managers have
-- them all, via nordvik_can_manage_store):
--   onboarding_scan     capture and submit items
--   onboarding_verify   confirm catalogue identity, condition and quantities
--   onboarding_price    copy existing prices
--   onboarding_approve  approve prices and stock (store manager)
-- NORDVIK administrators (nordvik_is_admin) create and oversee projects, log
-- labour and resolve exceptions, but cannot approve stock for sale: that is
-- always the retailer's decision.
--
-- Prices are only ever the retailer's own (imported or entered by staff);
-- nothing here reads market valuations. Every change is written to the
-- append-only onboarding_item_events log, including each price change.
--
-- Makes no changes to existing inventory or transaction records. Rerunnable.

BEGIN;

CREATE TABLE IF NOT EXISTS public.onboarding_projects (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id               uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  status                 text NOT NULL DEFAULT 'assessment' CHECK (status IN ('assessment','active','paused','completed','cancelled')),
  categories             text[] NOT NULL DEFAULT '{}',
  approx_quantity        integer,
  data_sources           text[] NOT NULL DEFAULT '{}',   -- spreadsheet | pos_export | scanning | manual
  existing_pos           text,                           -- the retailer's current POS / system
  pricing_methods        text,                           -- how the retailer prices today
  require_price_approval boolean NOT NULL DEFAULT true,
  expected_hours         numeric(8,2),
  notes                  text,
  created_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz
);
CREATE INDEX IF NOT EXISTS onboarding_projects_store_idx ON public.onboarding_projects(store_id);

CREATE TABLE IF NOT EXISTS public.onboarding_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.onboarding_projects(id) ON DELETE CASCADE,
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('spreadsheet','pos_export','scan','manual')),
  label       text,
  file_name   text,
  item_count  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_employee_id uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_batches_project_idx ON public.onboarding_batches(project_id);

CREATE TABLE IF NOT EXISTS public.onboarding_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES public.onboarding_projects(id) ON DELETE CASCADE,
  batch_id             uuid NOT NULL REFERENCES public.onboarding_batches(id) ON DELETE CASCADE,
  store_id             uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  stage                text NOT NULL DEFAULT 'captured' CHECK (stage IN ('captured','awaiting_verification','awaiting_pricing','awaiting_approval','ready_for_sale','excluded')),
  -- eBay publication, separate from the intake stage (phase 2).
  marketplace_status   text NOT NULL DEFAULT 'not_listed' CHECK (marketplace_status IN ('not_listed','draft','awaiting_approval','publishing','published','failed','ended')),
  source               text NOT NULL,
  source_ref           text,            -- row number in the file, or the scan id
  source_row           jsonb,           -- the original imported row, untouched
  catalog_item_id      uuid REFERENCES public.items(item_id) ON DELETE SET NULL,
  category_name        text,
  name                 text,
  item_number          text,
  barcode              text,
  condition            text,
  grading_company      text,
  grade                text,
  cert_number          text,
  quantity             integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  in_store_price       numeric(12,2),
  online_price         numeric(12,2),
  cost                 numeric(12,2),
  price_source         text,            -- retailer_import | retailer_pos | staff_entered
  price_missing        boolean NOT NULL DEFAULT false,
  price_approved_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  price_approved_at    timestamptz,
  image_paths          jsonb NOT NULL DEFAULT '[]',
  assigned_employee_id uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  captured_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at          timestamptz,
  priced_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  priced_at            timestamptz,
  approved_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at          timestamptz,
  inventory_id         uuid REFERENCES public.store_inventory(id) ON DELETE SET NULL,
  qa_status            text NOT NULL DEFAULT 'unchecked' CHECK (qa_status IN ('unchecked','passed','failed')),
  qa_note              text,
  exception            text,            -- an unresolved problem; blocks advancing
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_items_project_stage_idx ON public.onboarding_items(project_id, stage);
CREATE INDEX IF NOT EXISTS onboarding_items_batch_idx ON public.onboarding_items(batch_id);
CREATE INDEX IF NOT EXISTS onboarding_items_assigned_idx ON public.onboarding_items(assigned_employee_id);

CREATE TABLE IF NOT EXISTS public.onboarding_item_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid REFERENCES public.onboarding_items(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES public.onboarding_projects(id) ON DELETE CASCADE,
  store_id          uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  event             text NOT NULL,   -- project_created | project_updated | batch_imported | captured | stage_change | edit | price_change | assigned | qa_check | exception | exception_resolved | labour
  from_stage        text,
  to_stage          text,
  changes           jsonb,           -- { field: { from, to } }
  note              text,
  actor_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_employee_id uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  actor_is_admin    boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_item_events_item_idx ON public.onboarding_item_events(item_id, created_at);
CREATE INDEX IF NOT EXISTS onboarding_item_events_project_idx ON public.onboarding_item_events(project_id, created_at);

CREATE TABLE IF NOT EXISTS public.onboarding_labour (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES public.onboarding_projects(id) ON DELETE CASCADE,
  store_id          uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  work_date         date NOT NULL DEFAULT current_date,
  hours             numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  stage             text,
  note              text,
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  employee_id       uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_labour_project_idx ON public.onboarding_labour(project_id);

-- ── Access ──────────────────────────────────────────────────────────────────
-- Read: NORDVIK administrators and the store's own members. Write: only through
-- the functions below (no direct table writes).
ALTER TABLE public.onboarding_projects    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_batches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_item_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_labour      ENABLE ROW LEVEL SECURITY;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['onboarding_projects','onboarding_batches','onboarding_items','onboarding_item_events','onboarding_labour'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_read') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.nordvik_is_admin() OR store_id IN (SELECT public.user_store_ids()))', t || '_read', t);
    END IF;
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Retailer staff: the step's flag on an active store (owners/managers have all).
CREATE OR REPLACE FUNCTION public.onboarding_staff_can(p_store_id uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.nordvik_can_manage_store(p_store_id, p_permission)
$$;

CREATE OR REPLACE FUNCTION public.onboarding_can(p_store_id uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.nordvik_is_admin() OR public.nordvik_can_manage_store(p_store_id, p_permission)
$$;

CREATE OR REPLACE FUNCTION public.onboarding_actor_employee(p_store_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id FROM public.store_employees e
   WHERE e.store_id = p_store_id AND e.status = 'active'
     AND (e.auth_user_id = auth.uid() OR e.employee_user_id = auth.uid())
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.onboarding_log(p_item_id uuid, p_project_id uuid, p_store_id uuid, p_event text, p_from text, p_to text, p_changes jsonb, p_note text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.onboarding_item_events (item_id, project_id, store_id, event, from_stage, to_stage, changes, note, actor_user_id, actor_employee_id, actor_is_admin)
  VALUES (p_item_id, p_project_id, p_store_id, p_event, p_from, p_to, NULLIF(p_changes, '{}'::jsonb), NULLIF(trim(coalesce(p_note, '')), ''), auth.uid(), public.onboarding_actor_employee(p_store_id), public.nordvik_is_admin())
$$;

CREATE OR REPLACE FUNCTION public.onboarding_money(p_value text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN nullif(regexp_replace(coalesce(p_value, ''), '[^0-9.\-]', '', 'g'), '') ~ '^-?[0-9]*\.?[0-9]+$'
    THEN round(regexp_replace(p_value, '[^0-9.\-]', '', 'g')::numeric, 2) END
$$;

-- ── Projects (NORDVIK administrators) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.onboarding_save_project(p_project_id uuid, p_store_id uuid, p_details jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_store uuid; v_status text;
BEGIN
  IF NOT public.nordvik_is_admin() THEN RAISE EXCEPTION 'Only NORDVIK administrators manage onboarding projects'; END IF;
  IF p_project_id IS NULL THEN
    SELECT s.status INTO v_status FROM public.stores s WHERE s.id = p_store_id;
    IF v_status IS NULL THEN RAISE EXCEPTION 'Store not found'; END IF;
    IF v_status NOT IN ('setup','active') THEN RAISE EXCEPTION 'Onboarding needs an approved store (setup or active), not %', v_status; END IF;
    INSERT INTO public.onboarding_projects (store_id, name, created_by)
    VALUES (p_store_id, coalesce(nullif(trim(p_details->>'name'), ''), 'Inventory onboarding'), auth.uid())
    RETURNING id INTO v_id;
    v_store := p_store_id;
    PERFORM public.onboarding_log(NULL, v_id, v_store, 'project_created', NULL, NULL, p_details, NULL);
  ELSE
    SELECT store_id INTO v_store FROM public.onboarding_projects WHERE id = p_project_id;
    IF v_store IS NULL THEN RAISE EXCEPTION 'Onboarding project not found'; END IF;
    v_id := p_project_id;
    PERFORM public.onboarding_log(NULL, v_id, v_store, 'project_updated', NULL, NULL, p_details, NULL);
  END IF;
  UPDATE public.onboarding_projects SET
    name                   = coalesce(nullif(trim(p_details->>'name'), ''), name),
    status                 = coalesce(nullif(p_details->>'status', ''), status),
    categories             = CASE WHEN p_details ? 'categories' THEN ARRAY(SELECT jsonb_array_elements_text(p_details->'categories')) ELSE categories END,
    approx_quantity        = CASE WHEN p_details ? 'approx_quantity' THEN nullif(p_details->>'approx_quantity', '')::integer ELSE approx_quantity END,
    data_sources           = CASE WHEN p_details ? 'data_sources' THEN ARRAY(SELECT jsonb_array_elements_text(p_details->'data_sources')) ELSE data_sources END,
    existing_pos           = CASE WHEN p_details ? 'existing_pos' THEN nullif(trim(p_details->>'existing_pos'), '') ELSE existing_pos END,
    pricing_methods        = CASE WHEN p_details ? 'pricing_methods' THEN nullif(trim(p_details->>'pricing_methods'), '') ELSE pricing_methods END,
    require_price_approval = CASE WHEN p_details ? 'require_price_approval' THEN (p_details->>'require_price_approval')::boolean ELSE require_price_approval END,
    expected_hours         = CASE WHEN p_details ? 'expected_hours' THEN nullif(p_details->>'expected_hours', '')::numeric ELSE expected_hours END,
    notes                  = CASE WHEN p_details ? 'notes' THEN nullif(trim(p_details->>'notes'), '') ELSE notes END,
    completed_at           = CASE WHEN p_details->>'status' = 'completed' THEN coalesce(completed_at, now()) WHEN p_details ? 'status' THEN NULL ELSE completed_at END,
    updated_at             = now()
  WHERE id = v_id;
  RETURN v_id;
END $$;

-- Labour: administrators, or retailer staff working on the project.
CREATE OR REPLACE FUNCTION public.onboarding_log_hours(p_project_id uuid, p_hours numeric, p_work_date date, p_stage text, p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_store uuid; v_id uuid;
BEGIN
  SELECT store_id INTO v_store FROM public.onboarding_projects WHERE id = p_project_id;
  IF v_store IS NULL THEN RAISE EXCEPTION 'Onboarding project not found'; END IF;
  IF NOT (public.onboarding_can(v_store, 'onboarding_scan') OR public.onboarding_can(v_store, 'onboarding_verify')
       OR public.onboarding_can(v_store, 'onboarding_price') OR public.onboarding_can(v_store, 'onboarding_approve')) THEN
    RAISE EXCEPTION 'Not authorised for this onboarding project';
  END IF;
  INSERT INTO public.onboarding_labour (project_id, store_id, work_date, hours, stage, note, user_id, employee_id)
  VALUES (p_project_id, v_store, coalesce(p_work_date, current_date), p_hours, nullif(p_stage, ''), nullif(trim(coalesce(p_note, '')), ''), auth.uid(), public.onboarding_actor_employee(v_store))
  RETURNING id INTO v_id;
  PERFORM public.onboarding_log(NULL, p_project_id, v_store, 'labour', NULL, NULL, jsonb_build_object('hours', p_hours, 'stage', p_stage, 'work_date', p_work_date), p_note);
  RETURN v_id;
END $$;

-- ── Intake ──────────────────────────────────────────────────────────────────
-- A batch of captured items. p_items: [{ name, category_name, catalog_item_id,
-- item_number, barcode, condition, grading_company, grade, cert_number,
-- quantity, in_store_price, online_price, cost, source_ref, source_row,
-- image_paths }]. Prices are stored exactly as given (the retailer's own); a
-- row with neither price is flagged as missing a price. p_submit sends the
-- items straight on to verification.
-- A scanning session creates its batch with no items and adds to it as cards
-- are saved (onboarding_add_items).
CREATE OR REPLACE FUNCTION public.onboarding_create_batch(p_project_id uuid, p_source text, p_label text, p_file_name text, p_items jsonb, p_submit boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_store uuid; v_status text; v_batch uuid;
BEGIN
  SELECT store_id, status INTO v_store, v_status FROM public.onboarding_projects WHERE id = p_project_id;
  IF v_store IS NULL THEN RAISE EXCEPTION 'Onboarding project not found'; END IF;
  IF v_status IN ('completed','cancelled') THEN RAISE EXCEPTION 'This onboarding project is %', v_status; END IF;
  IF NOT public.onboarding_can(v_store, 'onboarding_scan') THEN RAISE EXCEPTION 'Capturing items needs the onboarding scan permission'; END IF;
  IF p_source <> 'scan' AND (jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0) THEN RAISE EXCEPTION 'The batch has no items'; END IF;

  INSERT INTO public.onboarding_batches (project_id, store_id, source, label, file_name, created_by, created_by_employee_id)
  VALUES (p_project_id, v_store, p_source, nullif(trim(coalesce(p_label, '')), ''), nullif(p_file_name, ''), auth.uid(), public.onboarding_actor_employee(v_store))
  RETURNING id INTO v_batch;
  IF jsonb_typeof(p_items) = 'array' AND jsonb_array_length(p_items) > 0 THEN
    PERFORM public.onboarding_add_items(v_batch, p_items, p_submit);
  END IF;
  PERFORM public.onboarding_log(NULL, p_project_id, v_store, 'batch_imported', NULL, NULL, jsonb_build_object('batch_id', v_batch, 'source', p_source, 'items', coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items END), 0), 'file_name', p_file_name), NULL);
  UPDATE public.onboarding_projects SET status = CASE WHEN status = 'assessment' THEN 'active' ELSE status END, updated_at = now() WHERE id = p_project_id;
  RETURN v_batch;
END $$;

-- Adds captured items to a batch. Returns the new item ids, in order.
CREATE OR REPLACE FUNCTION public.onboarding_add_items(p_batch_id uuid, p_items jsonb, p_submit boolean DEFAULT false)
RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_store uuid; v_project uuid; v_source text; v_status text; v_row jsonb; v_item uuid; v_stage text; v_ids uuid[] := '{}';
  v_in numeric; v_online numeric;
BEGIN
  SELECT b.store_id, b.project_id, b.source, p.status INTO v_store, v_project, v_source, v_status
    FROM public.onboarding_batches b JOIN public.onboarding_projects p ON p.id = b.project_id WHERE b.id = p_batch_id;
  IF v_store IS NULL THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF v_status IN ('completed','cancelled') THEN RAISE EXCEPTION 'This onboarding project is %', v_status; END IF;
  IF NOT public.onboarding_can(v_store, 'onboarding_scan') THEN RAISE EXCEPTION 'Capturing items needs the onboarding scan permission'; END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'No items to add'; END IF;
  IF jsonb_array_length(p_items) > 5000 THEN RAISE EXCEPTION 'Add at most 5,000 rows at a time'; END IF;
  v_stage := CASE WHEN p_submit THEN 'awaiting_verification' ELSE 'captured' END;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_in := public.onboarding_money(v_row->>'in_store_price');
    v_online := public.onboarding_money(v_row->>'online_price');
    INSERT INTO public.onboarding_items (project_id, batch_id, store_id, stage, source, source_ref, source_row, catalog_item_id, category_name, name,
      item_number, barcode, condition, grading_company, grade, cert_number, quantity, in_store_price, online_price, cost, price_source, price_missing,
      image_paths, captured_by)
    VALUES (v_project, p_batch_id, v_store, v_stage, v_source, nullif(v_row->>'source_ref', ''), v_row->'source_row',
      nullif(v_row->>'catalog_item_id', '')::uuid, nullif(trim(v_row->>'category_name'), ''), nullif(trim(v_row->>'name'), ''),
      nullif(trim(v_row->>'item_number'), ''), nullif(trim(v_row->>'barcode'), ''), nullif(trim(v_row->>'condition'), ''),
      nullif(trim(v_row->>'grading_company'), ''), nullif(trim(v_row->>'grade'), ''), nullif(trim(v_row->>'cert_number'), ''),
      greatest(0, coalesce(nullif(v_row->>'quantity', '')::integer, 1)), v_in, v_online, public.onboarding_money(v_row->>'cost'),
      CASE WHEN v_in IS NOT NULL OR v_online IS NOT NULL THEN CASE WHEN v_source = 'pos_export' THEN 'retailer_pos' WHEN v_source IN ('scan','manual') THEN 'staff_entered' ELSE 'retailer_import' END END,
      v_in IS NULL AND v_online IS NULL,
      coalesce(v_row->'image_paths', '[]'::jsonb), auth.uid())
    RETURNING id INTO v_item;
    PERFORM public.onboarding_log(v_item, v_project, v_store, 'captured', NULL, v_stage, NULL, NULL);
    v_ids := v_ids || v_item;
  END LOOP;

  UPDATE public.onboarding_batches SET item_count = item_count + cardinality(v_ids) WHERE id = p_batch_id;
  RETURN v_ids;
END $$;

-- Edits one staged item. Identity, condition and quantity need the verify
-- permission (or scan, while still Captured); prices need the price
-- permission (or approve, while awaiting approval). Every changed field is
-- logged with its old and new value; price edits are logged as price_change.
CREATE OR REPLACE FUNCTION public.onboarding_update_item(p_item_id uuid, p_changes jsonb, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.onboarding_items; v_new public.onboarding_items; k text; v_diff jsonb := '{}'; v_price_diff jsonb := '{}';
  identity_keys text[] := ARRAY['catalog_item_id','category_name','name','item_number','barcode','condition','grading_company','grade','cert_number','quantity','image_paths'];
  price_keys text[] := ARRAY['in_store_price','online_price','cost'];
BEGIN
  SELECT * INTO v FROM public.onboarding_items WHERE id = p_item_id FOR UPDATE;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Item not found'; END IF;
  IF v.stage IN ('ready_for_sale','excluded') THEN RAISE EXCEPTION 'This item is % and can no longer be edited here', replace(v.stage, '_', ' '); END IF;
  FOR k IN SELECT jsonb_object_keys(p_changes) LOOP
    IF k = ANY(identity_keys) THEN
      IF NOT (public.onboarding_can(v.store_id, 'onboarding_verify') OR (v.stage = 'captured' AND public.onboarding_can(v.store_id, 'onboarding_scan'))) THEN
        RAISE EXCEPTION 'Changing % needs the onboarding verify permission', k;
      END IF;
    ELSIF k = ANY(price_keys) THEN
      IF NOT (public.onboarding_staff_can(v.store_id, 'onboarding_price') OR (v.stage = 'awaiting_approval' AND public.onboarding_staff_can(v.store_id, 'onboarding_approve'))) THEN
        RAISE EXCEPTION 'Changing prices needs the retailer''s onboarding price permission';
      END IF;
    ELSE
      RAISE EXCEPTION 'Field % cannot be edited', k;
    END IF;
  END LOOP;

  UPDATE public.onboarding_items SET
    catalog_item_id = CASE WHEN p_changes ? 'catalog_item_id' THEN nullif(p_changes->>'catalog_item_id', '')::uuid ELSE catalog_item_id END,
    category_name   = CASE WHEN p_changes ? 'category_name' THEN nullif(trim(p_changes->>'category_name'), '') ELSE category_name END,
    name            = CASE WHEN p_changes ? 'name' THEN nullif(trim(p_changes->>'name'), '') ELSE name END,
    item_number     = CASE WHEN p_changes ? 'item_number' THEN nullif(trim(p_changes->>'item_number'), '') ELSE item_number END,
    barcode         = CASE WHEN p_changes ? 'barcode' THEN nullif(trim(p_changes->>'barcode'), '') ELSE barcode END,
    condition       = CASE WHEN p_changes ? 'condition' THEN nullif(trim(p_changes->>'condition'), '') ELSE condition END,
    grading_company = CASE WHEN p_changes ? 'grading_company' THEN nullif(trim(p_changes->>'grading_company'), '') ELSE grading_company END,
    grade           = CASE WHEN p_changes ? 'grade' THEN nullif(trim(p_changes->>'grade'), '') ELSE grade END,
    cert_number     = CASE WHEN p_changes ? 'cert_number' THEN nullif(trim(p_changes->>'cert_number'), '') ELSE cert_number END,
    quantity        = CASE WHEN p_changes ? 'quantity' THEN greatest(0, coalesce(nullif(p_changes->>'quantity', '')::integer, 0)) ELSE quantity END,
    image_paths     = CASE WHEN p_changes ? 'image_paths' THEN coalesce(p_changes->'image_paths', '[]'::jsonb) ELSE image_paths END,
    in_store_price  = CASE WHEN p_changes ? 'in_store_price' THEN public.onboarding_money(p_changes->>'in_store_price') ELSE in_store_price END,
    online_price    = CASE WHEN p_changes ? 'online_price' THEN public.onboarding_money(p_changes->>'online_price') ELSE online_price END,
    cost            = CASE WHEN p_changes ? 'cost' THEN public.onboarding_money(p_changes->>'cost') ELSE cost END,
    updated_at      = now()
  WHERE id = p_item_id
  RETURNING * INTO v_new;

  FOR k IN SELECT jsonb_object_keys(p_changes) LOOP
    IF (to_jsonb(v)->k) IS DISTINCT FROM (to_jsonb(v_new)->k) THEN
      IF k = ANY(price_keys) THEN v_price_diff := v_price_diff || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(v)->k, 'to', to_jsonb(v_new)->k));
      ELSE v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(v)->k, 'to', to_jsonb(v_new)->k)); END IF;
    END IF;
  END LOOP;

  IF v_price_diff <> '{}' THEN
    -- A staff-entered price, re-flagged if both prices are now empty. A price
    -- changed after approval needs approving again.
    UPDATE public.onboarding_items SET
      price_source = CASE WHEN v_new.in_store_price IS NULL AND v_new.online_price IS NULL THEN NULL ELSE 'staff_entered' END,
      price_missing = v_new.in_store_price IS NULL AND v_new.online_price IS NULL,
      price_approved_by = NULL, price_approved_at = NULL
    WHERE id = p_item_id;
    PERFORM public.onboarding_log(p_item_id, v.project_id, v.store_id, 'price_change', v.stage, v.stage, v_price_diff, p_note);
  END IF;
  IF v_diff <> '{}' THEN PERFORM public.onboarding_log(p_item_id, v.project_id, v.store_id, 'edit', v.stage, v.stage, v_diff, p_note); END IF;
END $$;

-- Stock record + receive movement for an approved item (the existing
-- inventory path; apply_inventory_movement checks store membership).
CREATE OR REPLACE FUNCTION public.onboarding_make_stock(p_item public.onboarding_items, p_location_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_inventory uuid; v_sku text;
BEGIN
  v_sku := upper(left(regexp_replace(coalesce(p_item.item_number, p_item.name, 'ITEM'), '[^A-Za-z0-9]+', '', 'g'), 10));
  v_sku := coalesce(nullif(v_sku, ''), 'ITEM') || '-' || upper(left(replace(p_item.id::text, '-', ''), 8));
  INSERT INTO public.store_inventory (store_id, catalog_item_id, sku, barcode, condition, grade, grading_company, cert_number,
    cost_basis, buy_price, sell_price, in_store_price, name_snapshot, status, is_used, is_trade_in)
  VALUES (p_item.store_id, p_item.catalog_item_id, v_sku, p_item.barcode, p_item.condition, p_item.grade, p_item.grading_company, p_item.cert_number,
    p_item.cost, p_item.cost, coalesce(p_item.online_price, p_item.in_store_price), p_item.in_store_price,
    coalesce(p_item.name, 'Item'), 'active', false, false)
  RETURNING id INTO v_inventory;
  IF p_item.quantity > 0 THEN
    PERFORM public.apply_inventory_movement(v_inventory, p_location_id, p_item.quantity, 'receive', 'onboarding');
  END IF;
  RETURN v_inventory;
END $$;

-- Moves items to another stage. Forward moves check that the item is complete
-- for the next stage; any earlier stage can be returned to (with a note).
-- Ready for Sale needs the retailer's approve permission and a location, and
-- is the only step that creates stock. Returns { moved, skipped: [{id, reason}] }.
CREATE OR REPLACE FUNCTION public.onboarding_advance(p_item_ids uuid[], p_to_stage text, p_note text DEFAULT NULL, p_location_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.onboarding_items; v_order text[] := ARRAY['captured','awaiting_verification','awaiting_pricing','awaiting_approval','ready_for_sale'];
  v_from int; v_to int; v_reason text; v_moved int := 0; v_skipped jsonb := '[]'; v_require boolean; v_target text; v_inventory uuid;
BEGIN
  IF NOT (p_to_stage = ANY(v_order) OR p_to_stage = 'excluded') THEN RAISE EXCEPTION 'Unknown stage %', p_to_stage; END IF;
  FOR v IN SELECT * FROM public.onboarding_items WHERE id = ANY(p_item_ids) ORDER BY created_at FOR UPDATE LOOP
    v_reason := NULL; v_target := p_to_stage;
    v_from := array_position(v_order, v.stage); v_to := array_position(v_order, p_to_stage);
    SELECT require_price_approval INTO v_require FROM public.onboarding_projects WHERE id = v.project_id;

    IF v.stage IN ('ready_for_sale','excluded') THEN v_reason := 'already ' || replace(v.stage, '_', ' ');
    ELSIF v.exception IS NOT NULL THEN v_reason := 'has an unresolved exception';
    ELSIF p_to_stage = 'excluded' THEN
      IF NOT (public.onboarding_can(v.store_id, 'onboarding_verify') OR public.onboarding_can(v.store_id, 'onboarding_approve')) THEN v_reason := 'needs the verify or approve permission';
      ELSIF coalesce(trim(p_note), '') = '' THEN v_reason := 'give a reason for excluding it'; END IF;
    ELSIF v_to <= v_from THEN
      IF v_to = v_from THEN v_reason := 'already at that stage';
      ELSIF coalesce(trim(p_note), '') = '' THEN v_reason := 'say why it is being sent back';
      ELSIF NOT (public.onboarding_can(v.store_id, 'onboarding_verify') OR public.onboarding_can(v.store_id, 'onboarding_price') OR public.onboarding_can(v.store_id, 'onboarding_approve')) THEN v_reason := 'not authorised to send items back'; END IF;
    ELSIF v_to <> v_from + 1 AND NOT (v.stage = 'awaiting_pricing' AND p_to_stage = 'ready_for_sale' AND NOT v_require) THEN
      v_reason := 'move one stage at a time';
    ELSIF p_to_stage = 'awaiting_verification' THEN
      IF NOT public.onboarding_can(v.store_id, 'onboarding_scan') THEN v_reason := 'needs the scan permission'; END IF;
    ELSIF p_to_stage = 'awaiting_pricing' THEN
      IF NOT public.onboarding_can(v.store_id, 'onboarding_verify') THEN v_reason := 'needs the verify permission';
      ELSIF v.name IS NULL AND v.catalog_item_id IS NULL THEN v_reason := 'needs a catalogue item or a name';
      ELSIF v.quantity < 1 THEN v_reason := 'quantity is 0'; END IF;
    ELSIF p_to_stage = 'awaiting_approval' THEN
      IF NOT public.onboarding_staff_can(v.store_id, 'onboarding_price') THEN v_reason := 'needs the retailer''s price permission';
      ELSIF v.in_store_price IS NULL AND v.online_price IS NULL THEN v_reason := 'has no price (flagged as missing)'; END IF;
      -- Without retailer price approval configured, priced items skip straight on.
      IF v_reason IS NULL AND NOT v_require THEN v_target := 'ready_for_sale'; END IF;
    END IF;
    IF v_reason IS NULL AND v_target = 'ready_for_sale' THEN
      IF v_require AND NOT public.onboarding_staff_can(v.store_id, 'onboarding_approve') THEN v_reason := 'needs the retailer''s approve permission';
      ELSIF NOT v_require AND NOT public.onboarding_staff_can(v.store_id, 'onboarding_price') THEN v_reason := 'needs the retailer''s price permission';
      ELSIF p_location_id IS NULL THEN v_reason := 'choose the location to receive stock into';
      ELSIF v.in_store_price IS NULL AND v.online_price IS NULL THEN v_reason := 'has no price';
      ELSIF v.quantity < 1 THEN v_reason := 'quantity is 0'; END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('id', v.id, 'name', v.name, 'reason', v_reason);
      CONTINUE;
    END IF;

    IF v_target = 'ready_for_sale' THEN
      v_inventory := public.onboarding_make_stock(v, p_location_id);
      UPDATE public.onboarding_items SET stage = 'ready_for_sale', inventory_id = v_inventory,
        approved_by = auth.uid(), approved_at = now(),
        price_approved_by = CASE WHEN v_require THEN auth.uid() ELSE price_approved_by END,
        price_approved_at = CASE WHEN v_require THEN now() ELSE price_approved_at END,
        priced_by = CASE WHEN v.stage = 'awaiting_pricing' THEN auth.uid() ELSE priced_by END,
        priced_at = CASE WHEN v.stage = 'awaiting_pricing' THEN now() ELSE priced_at END,
        updated_at = now()
      WHERE id = v.id;
      PERFORM public.onboarding_log(v.id, v.project_id, v.store_id, 'stage_change', v.stage, 'ready_for_sale', jsonb_build_object('inventory_id', v_inventory, 'quantity', v.quantity, 'in_store_price', v.in_store_price, 'online_price', v.online_price), p_note);
    ELSE
      UPDATE public.onboarding_items SET stage = v_target,
        verified_by = CASE WHEN v_target = 'awaiting_pricing' AND v_to > v_from THEN auth.uid() ELSE verified_by END,
        verified_at = CASE WHEN v_target = 'awaiting_pricing' AND v_to > v_from THEN now() ELSE verified_at END,
        priced_by = CASE WHEN v_target = 'awaiting_approval' THEN auth.uid() ELSE priced_by END,
        priced_at = CASE WHEN v_target = 'awaiting_approval' THEN now() ELSE priced_at END,
        -- Sent back before approval: any price approval no longer stands.
        price_approved_by = CASE WHEN v_target <> 'awaiting_approval' AND v_to < v_from THEN NULL ELSE price_approved_by END,
        price_approved_at = CASE WHEN v_target <> 'awaiting_approval' AND v_to < v_from THEN NULL ELSE price_approved_at END,
        updated_at = now()
      WHERE id = v.id;
      PERFORM public.onboarding_log(v.id, v.project_id, v.store_id, 'stage_change', v.stage, v_target, NULL, p_note);
    END IF;
    v_moved := v_moved + 1;
  END LOOP;
  RETURN jsonb_build_object('moved', v_moved, 'skipped', v_skipped);
END $$;

-- Assigns items to an employee (administrators and store managers).
CREATE OR REPLACE FUNCTION public.onboarding_assign(p_item_ids uuid[], p_employee_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v record; v_count int := 0;
BEGIN
  FOR v IN SELECT id, project_id, store_id, assigned_employee_id FROM public.onboarding_items WHERE id = ANY(p_item_ids) FOR UPDATE LOOP
    IF NOT public.onboarding_can(v.store_id, 'onboarding_approve') THEN RAISE EXCEPTION 'Assigning work needs the onboarding approve permission'; END IF;
    IF p_employee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.store_employees WHERE id = p_employee_id AND store_id = v.store_id) THEN
      RAISE EXCEPTION 'That employee does not work at this store';
    END IF;
    IF v.assigned_employee_id IS DISTINCT FROM p_employee_id THEN
      UPDATE public.onboarding_items SET assigned_employee_id = p_employee_id, updated_at = now() WHERE id = v.id;
      PERFORM public.onboarding_log(v.id, v.project_id, v.store_id, 'assigned', NULL, NULL, jsonb_build_object('assigned_employee_id', jsonb_build_object('from', v.assigned_employee_id, 'to', p_employee_id)), NULL);
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END $$;

-- Quality assurance sample check (administrators and store managers):
-- p_checks e.g. { identity: true, quantity: true, price: false }.
CREATE OR REPLACE FUNCTION public.onboarding_qa_check(p_item_id uuid, p_passed boolean, p_checks jsonb, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v record;
BEGIN
  SELECT id, project_id, store_id INTO v FROM public.onboarding_items WHERE id = p_item_id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Item not found'; END IF;
  IF NOT public.onboarding_can(v.store_id, 'onboarding_approve') THEN RAISE EXCEPTION 'Quality checks need the onboarding approve permission'; END IF;
  IF NOT p_passed AND coalesce(trim(p_note), '') = '' THEN RAISE EXCEPTION 'Say what failed the check'; END IF;
  UPDATE public.onboarding_items SET qa_status = CASE WHEN p_passed THEN 'passed' ELSE 'failed' END, qa_note = nullif(trim(coalesce(p_note, '')), ''),
    -- A failed check is an exception until someone resolves it.
    exception = CASE WHEN p_passed THEN exception ELSE coalesce(exception, 'Failed quality check: ' || trim(p_note)) END,
    updated_at = now()
  WHERE id = p_item_id;
  PERFORM public.onboarding_log(p_item_id, v.project_id, v.store_id, 'qa_check', NULL, NULL, jsonb_build_object('passed', p_passed, 'checks', p_checks), p_note);
END $$;

-- Raises (p_exception text) or resolves (p_exception NULL) an exception.
-- Anyone on the project can raise one; administrators and store managers resolve.
CREATE OR REPLACE FUNCTION public.onboarding_set_exception(p_item_id uuid, p_exception text, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v record;
BEGIN
  SELECT id, project_id, store_id, exception INTO v FROM public.onboarding_items WHERE id = p_item_id FOR UPDATE;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Item not found'; END IF;
  IF nullif(trim(coalesce(p_exception, '')), '') IS NULL THEN
    IF NOT public.onboarding_can(v.store_id, 'onboarding_approve') THEN RAISE EXCEPTION 'Resolving exceptions needs the onboarding approve permission'; END IF;
    IF coalesce(trim(p_note), '') = '' THEN RAISE EXCEPTION 'Say how it was resolved'; END IF;
    UPDATE public.onboarding_items SET exception = NULL, updated_at = now() WHERE id = p_item_id;
    PERFORM public.onboarding_log(p_item_id, v.project_id, v.store_id, 'exception_resolved', NULL, NULL, jsonb_build_object('exception', v.exception), p_note);
  ELSE
    IF NOT (public.onboarding_can(v.store_id, 'onboarding_scan') OR public.onboarding_can(v.store_id, 'onboarding_verify')
         OR public.onboarding_can(v.store_id, 'onboarding_price') OR public.onboarding_can(v.store_id, 'onboarding_approve')) THEN
      RAISE EXCEPTION 'Not authorised for this onboarding project';
    END IF;
    UPDATE public.onboarding_items SET exception = trim(p_exception), updated_at = now() WHERE id = p_item_id;
    PERFORM public.onboarding_log(p_item_id, v.project_id, v.store_id, 'exception', NULL, NULL, jsonb_build_object('exception', trim(p_exception)), p_note);
  END IF;
END $$;

-- Supervisor dashboard numbers for a project.
CREATE OR REPLACE FUNCTION public.onboarding_project_summary(p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_store uuid; v jsonb;
BEGIN
  SELECT store_id INTO v_store FROM public.onboarding_projects WHERE id = p_project_id;
  IF v_store IS NULL THEN RAISE EXCEPTION 'Onboarding project not found'; END IF;
  IF NOT (public.nordvik_is_admin() OR v_store IN (SELECT public.user_store_ids())) THEN RAISE EXCEPTION 'Not authorised for this onboarding project'; END IF;
  SELECT jsonb_build_object(
    'stages', coalesce((SELECT jsonb_object_agg(stage, n) FROM (SELECT stage, count(*) n FROM public.onboarding_items WHERE project_id = p_project_id GROUP BY stage) s), '{}'),
    'units', coalesce((SELECT jsonb_object_agg(stage, n) FROM (SELECT stage, sum(quantity) n FROM public.onboarding_items WHERE project_id = p_project_id GROUP BY stage) s), '{}'),
    'items', (SELECT count(*) FROM public.onboarding_items WHERE project_id = p_project_id),
    'missing_prices', (SELECT count(*) FROM public.onboarding_items WHERE project_id = p_project_id AND price_missing AND stage NOT IN ('ready_for_sale','excluded')),
    'exceptions', (SELECT count(*) FROM public.onboarding_items WHERE project_id = p_project_id AND exception IS NOT NULL),
    'unassigned', (SELECT count(*) FROM public.onboarding_items WHERE project_id = p_project_id AND assigned_employee_id IS NULL AND stage NOT IN ('ready_for_sale','excluded')),
    'qa', jsonb_build_object(
      'passed', (SELECT count(*) FROM public.onboarding_items WHERE project_id = p_project_id AND qa_status = 'passed'),
      'failed', (SELECT count(*) FROM public.onboarding_items WHERE project_id = p_project_id AND qa_status = 'failed')),
    'actual_hours', (SELECT coalesce(sum(hours), 0) FROM public.onboarding_labour WHERE project_id = p_project_id),
    'batches', (SELECT count(*) FROM public.onboarding_batches WHERE project_id = p_project_id)
  ) INTO v;
  RETURN v;
END $$;

-- ── Staff and their onboarding permissions ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.onboarding_employee_name(p_employee_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(nullif(trim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username) FROM public.store_employees e WHERE e.id = p_employee_id
$$;

-- The store's staff, for assigning work, with each person's onboarding
-- permissions (owners and managers have them all).
CREATE OR REPLACE FUNCTION public.onboarding_staff(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (public.nordvik_is_admin() OR p_store_id IN (SELECT public.user_store_ids())) THEN RAISE EXCEPTION 'Not authorised for this store'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', e.id, 'name', public.onboarding_employee_name(e.id), 'role', e.role,
      'permissions', (SELECT jsonb_object_agg(k, lower(e.role) IN ('owner','manager') OR coalesce(coalesce(e.action_permissions, e.permissions, '{}'::jsonb)->>k, 'false') = 'true')
                        FROM unnest(ARRAY['onboarding_scan','onboarding_verify','onboarding_price','onboarding_approve']) k))
      ORDER BY public.onboarding_employee_name(e.id))
    FROM public.store_employees e WHERE e.store_id = p_store_id AND e.status = 'active'), '[]'::jsonb);
END $$;

-- Sets an employee's onboarding permissions (store managers with employee
-- management, or NORDVIK administrators). Only these four keys are touched.
CREATE OR REPLACE FUNCTION public.onboarding_set_staff_permissions(p_store_id uuid, p_employee_id uuid, p_permissions jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_clean jsonb := '{}'; k text; v_old jsonb;
BEGIN
  IF NOT (public.nordvik_is_admin() OR public.nordvik_can_manage_store(p_store_id, 'employee_management')) THEN
    RAISE EXCEPTION 'Changing permissions needs employee management access';
  END IF;
  FOREACH k IN ARRAY ARRAY['onboarding_scan','onboarding_verify','onboarding_price','onboarding_approve'] LOOP
    v_clean := v_clean || jsonb_build_object(k, coalesce((p_permissions->>k)::boolean, false));
  END LOOP;
  SELECT coalesce(action_permissions, permissions, '{}'::jsonb) INTO v_old FROM public.store_employees WHERE id = p_employee_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
  UPDATE public.store_employees SET action_permissions = v_old || v_clean WHERE id = p_employee_id;
END $$;

-- Approved stores (setup or active) for NORDVIK administrators, with their
-- organisation and any onboarding projects.
CREATE OR REPLACE FUNCTION public.onboarding_admin_stores()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.nordvik_is_admin() THEN RAISE EXCEPTION 'Only NORDVIK administrators can list stores for onboarding'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'store_name', s.store_name, 'store_code', s.store_code, 'status', s.status,
      'organization', o.name, 'organization_status', o.onboarding_status) ORDER BY s.store_name)
    FROM public.stores s LEFT JOIN public.organizations o ON o.id = s.organization_id
    WHERE s.status IN ('setup','active')), '[]'::jsonb);
END $$;

-- The project's history (newest first), with who did each step.
CREATE OR REPLACE FUNCTION public.onboarding_events(p_project_id uuid, p_item_id uuid DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_store uuid;
BEGIN
  SELECT store_id INTO v_store FROM public.onboarding_projects WHERE id = p_project_id;
  IF v_store IS NULL THEN RAISE EXCEPTION 'Onboarding project not found'; END IF;
  IF NOT (public.nordvik_is_admin() OR v_store IN (SELECT public.user_store_ids())) THEN RAISE EXCEPTION 'Not authorised for this onboarding project'; END IF;
  RETURN coalesce((SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.created_at DESC) FROM (
    SELECT ev.id, ev.item_id, ev.event, ev.from_stage, ev.to_stage, ev.changes, ev.note, ev.created_at, ev.actor_is_admin,
      CASE WHEN ev.actor_employee_id IS NOT NULL THEN public.onboarding_employee_name(ev.actor_employee_id) WHEN ev.actor_is_admin THEN 'NORDVIK' ELSE 'Store owner' END AS actor,
      i.name AS item_name
    FROM public.onboarding_item_events ev LEFT JOIN public.onboarding_items i ON i.id = ev.item_id
    WHERE ev.project_id = p_project_id AND (p_item_id IS NULL OR ev.item_id = p_item_id)
    ORDER BY ev.created_at DESC LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000)) x), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.onboarding_log(uuid,uuid,uuid,text,text,text,jsonb,text), public.onboarding_make_stock(public.onboarding_items,uuid),
  public.onboarding_employee_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.onboarding_staff_can(uuid,text), public.onboarding_can(uuid,text), public.onboarding_actor_employee(uuid),
  public.onboarding_save_project(uuid,uuid,jsonb), public.onboarding_log_hours(uuid,numeric,date,text,text),
  public.onboarding_create_batch(uuid,text,text,text,jsonb,boolean), public.onboarding_add_items(uuid,jsonb,boolean), public.onboarding_update_item(uuid,jsonb,text),
  public.onboarding_advance(uuid[],text,text,uuid), public.onboarding_assign(uuid[],uuid), public.onboarding_qa_check(uuid,boolean,jsonb,text),
  public.onboarding_set_exception(uuid,text,text), public.onboarding_project_summary(uuid), public.onboarding_staff(uuid),
  public.onboarding_set_staff_permissions(uuid,uuid,jsonb), public.onboarding_events(uuid,uuid,integer), public.onboarding_admin_stores() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.onboarding_staff_can(uuid,text), public.onboarding_can(uuid,text), public.onboarding_actor_employee(uuid),
  public.onboarding_save_project(uuid,uuid,jsonb), public.onboarding_log_hours(uuid,numeric,date,text,text),
  public.onboarding_create_batch(uuid,text,text,text,jsonb,boolean), public.onboarding_add_items(uuid,jsonb,boolean), public.onboarding_update_item(uuid,jsonb,text),
  public.onboarding_advance(uuid[],text,text,uuid), public.onboarding_assign(uuid[],uuid), public.onboarding_qa_check(uuid,boolean,jsonb,text),
  public.onboarding_set_exception(uuid,text,text), public.onboarding_project_summary(uuid), public.onboarding_staff(uuid),
  public.onboarding_set_staff_permissions(uuid,uuid,jsonb), public.onboarding_events(uuid,uuid,integer), public.onboarding_admin_stores() TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
