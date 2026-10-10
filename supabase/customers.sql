-- POS Customers: store customers and linked CollectorsHub members.
--
-- Builds on what exists: store_customers (one row per store per customer;
-- collectorshub_user_id links a member), store_credit_ledger (store credit,
-- per store, needs a linked member; checkout already locks and checks the
-- balance), store_transactions / items / payments, store_return_records.
-- This file only ADDS: columns on store_customers, notes, an audit log,
-- member-approved link requests, and the functions the Customers screen uses.
--
-- Store isolation: every function checks the signed-in user is staff of the
-- store (user_store_ids) and only reads that store's rows. A member linked to
-- several stores is a separate store_customers row at each; one store never
-- sees another's history, credit, notes or trade-ins.
--
-- Linking a member needs their approval on their own signed-in account
-- (customer_link_decide checks auth.uid()); searching for a username grants
-- nothing. (The older link_store_customer_to_profile, which links without the
-- member's approval, isn't used by the POS Customers screen.)
--
-- Run after the website's store migrations. Rerunnable; never deletes data.

-- ── Columns on store_customers (additive) ───────────────────────────────────
ALTER TABLE public.store_customers ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE public.store_customers ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE public.store_customers ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.store_customers ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE public.store_customers ADD COLUMN IF NOT EXISTS customer_number text;
ALTER TABLE public.store_customers ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES public.store_customers(id) ON DELETE SET NULL;
ALTER TABLE public.store_customers ADD COLUMN IF NOT EXISTS created_by_user uuid;
ALTER TABLE public.store_customers DROP CONSTRAINT IF EXISTS store_customers_status_check;
ALTER TABLE public.store_customers ADD CONSTRAINT store_customers_status_check CHECK (status IN ('active', 'inactive', 'merged'));

-- Customer IDs (C-000123), per store, assigned automatically (also to rows the website creates).
CREATE TABLE IF NOT EXISTS public.store_customer_counters (store_id uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE, last integer NOT NULL DEFAULT 0);
ALTER TABLE public.store_customer_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_customer_counters FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.store_customer_next_number(p_store_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v integer;
BEGIN
  INSERT INTO public.store_customer_counters (store_id, last) VALUES (p_store_id, 1)
  ON CONFLICT (store_id) DO UPDATE SET last = public.store_customer_counters.last + 1
  RETURNING last INTO v;
  RETURN 'C-' || lpad(v::text, 6, '0');
END $$;
REVOKE ALL ON FUNCTION public.store_customer_next_number(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.store_customers_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.customer_number IS NULL THEN NEW.customer_number := public.store_customer_next_number(NEW.store_id); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS store_customers_number ON public.store_customers;
CREATE TRIGGER store_customers_number BEFORE INSERT ON public.store_customers FOR EACH ROW EXECUTE FUNCTION public.store_customers_number();

-- Number existing customers, oldest first.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, store_id FROM public.store_customers WHERE customer_number IS NULL ORDER BY created_at LOOP
    UPDATE public.store_customers SET customer_number = public.store_customer_next_number(r.store_id) WHERE id = r.id;
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS store_customers_number_uniq ON public.store_customers (store_id, customer_number);
CREATE INDEX IF NOT EXISTS store_customers_profile_idx ON public.store_customers (store_id, collectorshub_user_id);

-- ── Notes, audit, link requests ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.store_customer_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES public.store_customers(id) ON DELETE CASCADE,
  body                text NOT NULL,
  created_by_user     uuid,
  created_by_employee uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_employee uuid REFERENCES public.store_employees(id) ON DELETE SET NULL,
  updated_at          timestamptz,
  deleted_at          timestamptz
);
CREATE INDEX IF NOT EXISTS store_customer_notes_idx ON public.store_customer_notes (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.store_customer_audit (
  id          bigserial PRIMARY KEY,
  store_id    uuid NOT NULL,
  customer_id uuid,
  actor_user  uuid,
  employee_id uuid,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_customer_audit_idx ON public.store_customer_audit (store_id, customer_id, id DESC);
CREATE OR REPLACE FUNCTION public.store_customer_audit_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'The customer audit log is append-only.'; END $$;
DROP TRIGGER IF EXISTS store_customer_audit_append_only ON public.store_customer_audit;
CREATE TRIGGER store_customer_audit_append_only BEFORE UPDATE OR DELETE ON public.store_customer_audit FOR EACH ROW EXECUTE FUNCTION public.store_customer_audit_append_only();

CREATE TABLE IF NOT EXISTS public.store_customer_link_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES public.store_customers(id) ON DELETE CASCADE,
  profile_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'cancelled')),
  requested_by   uuid,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '2 days',
  decided_at     timestamptz
);
CREATE INDEX IF NOT EXISTS store_customer_link_requests_profile_idx ON public.store_customer_link_requests (profile_id, status);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['store_customer_notes', 'store_customer_audit', 'store_customer_link_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- ── Helpers ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customers_require_staff(p_store_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.customers_require_staff(uuid) FROM PUBLIC, anon, authenticated;

-- Managers (and the store's organization) for sensitive actions.
CREATE OR REPLACE FUNCTION public.customers_is_manager(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.myhr_is_manager(p_store_id)
      OR EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND s.organization_id IN (SELECT public.user_org_ids()))
$$;
REVOKE ALL ON FUNCTION public.customers_is_manager(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.customers_audit(p_store uuid, p_customer uuid, p_action text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.store_customer_audit (store_id, customer_id, actor_user, employee_id, action, detail)
  VALUES (p_store, p_customer, auth.uid(), public.myhr_employee_id(p_store), p_action, COALESCE(p_detail, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.customers_audit(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- A customer's store credit at this store (the ledger is keyed by the member when linked).
CREATE OR REPLACE FUNCTION public.customers_balance(p_store_id uuid, p_customer_id uuid, p_profile_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(CASE WHEN p_profile_id IS NOT NULL
    THEN (SELECT sum(l.amount) FROM public.store_credit_ledger l WHERE l.store_id = p_store_id AND l.collectorshub_user_id = p_profile_id)
    ELSE (SELECT sum(l.amount) FROM public.store_credit_ledger l WHERE l.store_id = p_store_id AND l.customer_id = p_customer_id AND l.collectorshub_user_id IS NULL) END, 0)
$$;
REVOKE ALL ON FUNCTION public.customers_balance(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── Dashboard and directory ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customers_summary(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  RETURN jsonb_build_object(
    'total', (SELECT count(*) FROM public.store_customers WHERE store_id = p_store_id AND status <> 'merged'),
    'members', (SELECT count(*) FROM public.store_customers WHERE store_id = p_store_id AND status <> 'merged' AND collectorshub_user_id IS NOT NULL),
    'outstanding_credit', (SELECT COALESCE(sum(amount), 0) FROM public.store_credit_ledger WHERE store_id = p_store_id),
    'new_this_month', (SELECT count(*) FROM public.store_customers WHERE store_id = p_store_id AND status <> 'merged' AND created_at >= date_trunc('month', now()))
  );
END $$;

CREATE OR REPLACE FUNCTION public.customers_list(p_store_id uuid, p_search text DEFAULT '', p_filter text DEFAULT 'all', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (id uuid, customer_number text, name text, first_name text, last_name text, username text, avatar_url text, is_member boolean,
               status text, email text, phone text, balance numeric, last_purchase timestamptz, transactions integer, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q text := lower(btrim(COALESCE(p_search, '')));
        v_digits text := regexp_replace(COALESCE(p_search, ''), '[^0-9]', '', 'g');
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  RETURN QUERY
  WITH base AS (
    SELECT c.*, p.username AS p_username, p.avatar_url AS p_avatar,
           COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), NULLIF(btrim(c.display_name), ''), p.username, c.membership_code, 'Customer') AS c_name
      FROM public.store_customers c
      LEFT JOIN public.profiles p ON p.id = c.collectorshub_user_id
     WHERE c.store_id = p_store_id AND c.status <> 'merged'
       AND CASE p_filter WHEN 'members' THEN c.collectorshub_user_id IS NOT NULL WHEN 'store' THEN c.collectorshub_user_id IS NULL
                         WHEN 'active' THEN c.status = 'active' WHEN 'inactive' THEN c.status = 'inactive' ELSE true END
       AND (v_q = '' OR lower(COALESCE(concat_ws(' ', c.first_name, c.last_name), '')) LIKE '%' || v_q || '%'
            OR lower(COALESCE(c.display_name, '')) LIKE '%' || v_q || '%' OR lower(COALESCE(p.username, '')) LIKE '%' || ltrim(v_q, '@') || '%'
            OR lower(COALESCE(c.customer_number, '')) LIKE '%' || v_q || '%' OR lower(COALESCE(c.membership_code, '')) LIKE '%' || ltrim(v_q, '@') || '%'
            OR lower(COALESCE(c.email, '')) LIKE '%' || v_q || '%'
            OR (length(v_digits) >= 4 AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE '%' || v_digits || '%'))
  )
  SELECT b.id, b.customer_number, b.c_name, b.first_name, b.last_name, b.p_username, b.p_avatar, b.collectorshub_user_id IS NOT NULL,
         b.status, b.email, b.phone, public.customers_balance(p_store_id, b.id, b.collectorshub_user_id),
         (SELECT max(t.created_at) FROM public.store_transactions t WHERE t.store_id = p_store_id AND t.customer_id = b.id),
         (SELECT count(*)::int FROM public.store_transactions t WHERE t.store_id = p_store_id AND t.customer_id = b.id),
         count(*) OVER ()
    FROM base b
   ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0);
END $$;

-- ── Profile ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_profile(p_store_id uuid, p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.store_customers; p record;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  SELECT * INTO c FROM public.store_customers WHERE id = p_customer_id AND store_id = p_store_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Customer not found.'; END IF;
  SELECT pr.username, pr.display_name, pr.avatar_url, pr.collector_level INTO p FROM public.profiles pr WHERE pr.id = c.collectorshub_user_id;
  RETURN jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'customer_number', c.customer_number, 'first_name', c.first_name, 'last_name', c.last_name,
        'display_name', c.display_name, 'email', c.email, 'phone', c.phone, 'address', c.address, 'status', c.status, 'created_at', c.created_at,
        'is_member', c.collectorshub_user_id IS NOT NULL, 'profile_id', c.collectorshub_user_id),
    'member', CASE WHEN c.collectorshub_user_id IS NULL THEN NULL ELSE jsonb_build_object('username', p.username, 'display_name', p.display_name,
        'avatar_url', p.avatar_url, 'level', p.collector_level) END,
    'stats', (SELECT jsonb_build_object(
        'transactions', count(*),
        'purchases', count(*) FILTER (WHERE t.transaction_type IN ('sale', 'exchange')),
        'total_spent', COALESCE(sum(t.total) FILTER (WHERE t.transaction_type IN ('sale', 'exchange') AND t.total > 0), 0),
        'trade_ins', count(*) FILTER (WHERE t.transaction_type IN ('trade_in', 'exchange')),
        'last_purchase', max(t.created_at))
        FROM public.store_transactions t WHERE t.store_id = p_store_id AND t.customer_id = c.id),
    'balance', public.customers_balance(p_store_id, c.id, c.collectorshub_user_id),
    'can_manage', public.customers_is_manager(p_store_id),
    'link_request', (SELECT jsonb_build_object('id', r.id, 'status', r.status, 'expires_at', r.expires_at, 'username', pr.username)
                       FROM public.store_customer_link_requests r JOIN public.profiles pr ON pr.id = r.profile_id
                      WHERE r.customer_id = c.id AND r.status = 'pending' AND r.expires_at > now() ORDER BY r.requested_at DESC LIMIT 1),
    'notices', jsonb_strip_nulls(jsonb_build_object(
        'collection_held', CASE WHEN c.collectorshub_user_id IS NOT NULL AND to_regclass('public.collection_intake_jobs') IS NOT NULL THEN
          (SELECT count(*) FROM public.collection_intake_jobs j WHERE j.store_id = p_store_id AND j.collector_user_id = c.collectorshub_user_id AND j.custody_status IN ('in_store', 'partially_returned')) END,
        'inactive', CASE WHEN c.status = 'inactive' THEN true END))
  );
END $$;

-- Purchase history (paged), with items, payments, refund status and employee.
CREATE OR REPLACE FUNCTION public.customer_transactions(p_store_id uuid, p_customer_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (id uuid, transaction_number text, created_at timestamptz, transaction_type text, status text, items text, item_count integer,
               subtotal numeric, tax numeric, total numeric, payments text, refunded boolean, employee_name text, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  RETURN QUERY
  SELECT t.id, t.transaction_number, t.created_at, t.transaction_type, t.status,
         (SELECT string_agg(concat(i.quantity, ' × ', COALESCE(i.name_snapshot, 'Item'), CASE WHEN i.direction = 'in' THEN ' (in)' ELSE '' END), ', ' ORDER BY i.created_at)
            FROM public.store_transaction_items i WHERE i.transaction_id = t.id),
         (SELECT COALESCE(sum(i.quantity), 0)::int FROM public.store_transaction_items i WHERE i.transaction_id = t.id),
         t.subtotal, t.tax_total, t.total,
         (SELECT string_agg(DISTINCT replace(pm.method, '_', ' '), ', ') FROM public.store_transaction_payments pm WHERE pm.transaction_id = t.id),
         EXISTS (SELECT 1 FROM public.store_return_records r WHERE r.original_transaction_id = t.id),
         COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username),
         count(*) OVER ()
    FROM public.store_transactions t
    LEFT JOIN public.store_employees e ON e.id = t.employee_id
   WHERE t.store_id = p_store_id AND t.customer_id = p_customer_id
   ORDER BY t.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0);
END $$;

-- One transaction's lines and payments (this store's own).
CREATE OR REPLACE FUNCTION public.customer_transaction_detail(p_store_id uuid, p_transaction_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  IF NOT EXISTS (SELECT 1 FROM public.store_transactions WHERE id = p_transaction_id AND store_id = p_store_id) THEN RAISE EXCEPTION 'Transaction not found.'; END IF;
  RETURN jsonb_build_object(
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', i.name_snapshot, 'sku', i.sku_snapshot, 'condition', i.condition, 'direction', i.direction,
                 'quantity', i.quantity, 'unit_price', i.unit_price, 'discount', i.discount_total, 'line_total', i.line_total) ORDER BY i.created_at)
               FROM public.store_transaction_items i WHERE i.transaction_id = p_transaction_id), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', pm.method, 'amount', pm.amount)) FROM public.store_transaction_payments pm WHERE pm.transaction_id = p_transaction_id), '[]'::jsonb),
    'refunds', COALESCE((SELECT jsonb_agg(to_jsonb(r) - 'store_id') FROM public.store_return_records r WHERE r.original_transaction_id = p_transaction_id), '[]'::jsonb));
END $$;

-- Items the customer sold or traded to the store.
CREATE OR REPLACE FUNCTION public.customer_trade_ins(p_store_id uuid, p_customer_id uuid, p_limit integer DEFAULT 100)
RETURNS TABLE (transaction_id uuid, transaction_number text, created_at timestamptz, name text, condition text, quantity integer, amount numeric, paid_as text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  RETURN QUERY
  SELECT t.id, t.transaction_number, t.created_at, i.name_snapshot, i.condition, i.quantity, i.line_total,
         CASE WHEN COALESCE(t.trade_credit_total, 0) > 0 AND t.transaction_type = 'trade_in' THEN 'Store credit'
              ELSE COALESCE((SELECT string_agg(DISTINCT replace(pm.method, '_', ' '), ', ') FROM public.store_transaction_payments pm WHERE pm.transaction_id = t.id), 'Trade value') END,
         t.status
    FROM public.store_transactions t
    JOIN public.store_transaction_items i ON i.transaction_id = t.id AND i.direction = 'in'
   WHERE t.store_id = p_store_id AND t.customer_id = p_customer_id AND t.transaction_type IN ('trade_in', 'exchange')
   ORDER BY t.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 500);
END $$;

-- Collection services (Express Scan and Drop-Off jobs) for a linked member at this store.
CREATE OR REPLACE FUNCTION public.customer_collection_jobs(p_store_id uuid, p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_profile uuid;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  SELECT collectorshub_user_id INTO v_profile FROM public.store_customers WHERE id = p_customer_id AND store_id = p_store_id;
  IF v_profile IS NULL OR to_regclass('public.collection_intake_jobs') IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', j.id, 'reference', j.reference, 'kind', j.kind, 'status', j.status, 'custody_status', j.custody_status,
           'created_at', j.created_at, 'received_at', j.received_at, 'returned_at', j.returned_at,
           'scanned', (SELECT COALESCE(sum(i.quantity) FILTER (WHERE i.status <> 'excluded'), 0) FROM public.collection_intake_items i WHERE i.job_id = j.id),
           'imported', (SELECT COALESCE(sum(i.quantity) FILTER (WHERE i.status = 'imported'), 0) FROM public.collection_intake_items i WHERE i.job_id = j.id)) ORDER BY j.created_at DESC)
    FROM public.collection_intake_jobs j WHERE j.store_id = p_store_id AND j.collector_user_id = v_profile), '[]'::jsonb);
END $$;

-- Membership: level, and items this store has added to their collection (no other collection data).
CREATE OR REPLACE FUNCTION public.customer_loyalty(p_store_id uuid, p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_profile uuid; p record;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  SELECT collectorshub_user_id INTO v_profile FROM public.store_customers WHERE id = p_customer_id AND store_id = p_store_id;
  IF v_profile IS NULL THEN RETURN NULL; END IF;
  SELECT username, collector_level INTO p FROM public.profiles WHERE id = v_profile;
  RETURN jsonb_build_object('username', p.username, 'level', p.collector_level,
    'items_from_store', (SELECT count(*) FROM public.owned_copies oc WHERE oc.user_id = v_profile AND oc.metadata->>'store_id' = p_store_id::text),
    'items_from_purchases', (SELECT count(*) FROM public.owned_copies oc WHERE oc.user_id = v_profile AND oc.metadata->>'store_id' = p_store_id::text AND oc.metadata->>'source' = 'store_pos'),
    'items_from_scanning', (SELECT count(*) FROM public.owned_copies oc WHERE oc.user_id = v_profile AND oc.metadata->>'store_id' = p_store_id::text AND oc.metadata->>'source' = 'store_scan'));
END $$;

-- ── Create / edit / status ──────────────────────────────────────────────────
-- Store customer (no CollectorsHub account needed). Possible duplicates are
-- returned instead of creating, unless p_force.
CREATE OR REPLACE FUNCTION public.customer_create(p_store_id uuid, p_data jsonb, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_first text := NULLIF(btrim(p_data->>'first_name'), '');
  v_last text := NULLIF(btrim(p_data->>'last_name'), '');
  v_email text := NULLIF(lower(btrim(p_data->>'email')), '');
  v_phone text := NULLIF(btrim(p_data->>'phone'), '');
  v_digits text := regexp_replace(COALESCE(p_data->>'phone', ''), '[^0-9]', '', 'g');
  v_dupes jsonb;
  v_id uuid;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  IF v_first IS NULL AND v_last IS NULL AND NULLIF(btrim(p_data->>'display_name'), '') IS NULL THEN RAISE EXCEPTION 'Enter the customer''s name.'; END IF;
  IF NOT p_force THEN
    SELECT jsonb_agg(jsonb_build_object('id', c.id, 'customer_number', c.customer_number, 'name', COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.display_name), 'email', c.email, 'phone', c.phone))
      INTO v_dupes FROM public.store_customers c
     WHERE c.store_id = p_store_id AND c.status <> 'merged'
       AND ((v_email IS NOT NULL AND lower(c.email) = v_email)
         OR (length(v_digits) >= 7 AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = v_digits)
         OR (v_first IS NOT NULL AND v_last IS NOT NULL AND lower(c.first_name) = lower(v_first) AND lower(c.last_name) = lower(v_last)));
    IF v_dupes IS NOT NULL THEN RETURN jsonb_build_object('duplicates', v_dupes); END IF;
  END IF;
  INSERT INTO public.store_customers (store_id, first_name, last_name, display_name, email, phone, address, notes, created_by_user, status)
  VALUES (p_store_id, v_first, v_last, COALESCE(NULLIF(btrim(p_data->>'display_name'), ''), NULLIF(btrim(concat_ws(' ', v_first, v_last)), '')),
          v_email, v_phone, NULLIF(btrim(p_data->>'address'), ''), NULL, auth.uid(), 'active')
  RETURNING id INTO v_id;
  IF NULLIF(btrim(p_data->>'notes'), '') IS NOT NULL THEN
    INSERT INTO public.store_customer_notes (store_id, customer_id, body, created_by_user, created_by_employee)
    VALUES (p_store_id, v_id, btrim(p_data->>'notes'), auth.uid(), public.myhr_employee_id(p_store_id));
  END IF;
  PERFORM public.customers_audit(p_store_id, v_id, 'customer_created', jsonb_build_object('forced_past_duplicates', p_force));
  RETURN jsonb_build_object('id', v_id, 'customer_number', (SELECT customer_number FROM public.store_customers WHERE id = v_id));
END $$;

-- Edit what the store holds. For members, their username, display name and
-- photo belong to their CollectorsHub account and aren't changed here.
CREATE OR REPLACE FUNCTION public.customer_update(p_store_id uuid, p_customer_id uuid, p_data jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.store_customers; v_changed text[] := '{}'; k text;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  SELECT * INTO c FROM public.store_customers WHERE id = p_customer_id AND store_id = p_store_id FOR UPDATE;
  IF c.id IS NULL OR c.status = 'merged' THEN RAISE EXCEPTION 'Customer not found.'; END IF;
  FOREACH k IN ARRAY ARRAY['first_name', 'last_name', 'email', 'phone', 'address', 'display_name'] LOOP
    IF p_data ? k AND NOT (k = 'display_name' AND c.collectorshub_user_id IS NOT NULL) THEN v_changed := v_changed || k; END IF;
  END LOOP;
  UPDATE public.store_customers SET
    first_name = CASE WHEN p_data ? 'first_name' THEN NULLIF(btrim(p_data->>'first_name'), '') ELSE first_name END,
    last_name = CASE WHEN p_data ? 'last_name' THEN NULLIF(btrim(p_data->>'last_name'), '') ELSE last_name END,
    email = CASE WHEN p_data ? 'email' THEN NULLIF(lower(btrim(p_data->>'email')), '') ELSE email END,
    phone = CASE WHEN p_data ? 'phone' THEN NULLIF(btrim(p_data->>'phone'), '') ELSE phone END,
    address = CASE WHEN p_data ? 'address' THEN NULLIF(btrim(p_data->>'address'), '') ELSE address END,
    display_name = CASE WHEN p_data ? 'display_name' AND collectorshub_user_id IS NULL THEN NULLIF(btrim(p_data->>'display_name'), '') ELSE display_name END,
    updated_at = now()
   WHERE id = c.id;
  PERFORM public.customers_audit(p_store_id, c.id, 'customer_updated', jsonb_build_object('fields', v_changed));
END $$;

-- Inactive / active (managers). History and credit are kept.
CREATE OR REPLACE FUNCTION public.customer_set_status(p_store_id uuid, p_customer_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  IF NOT public.customers_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can change a customer''s status.'; END IF;
  IF p_status NOT IN ('active', 'inactive') THEN RAISE EXCEPTION 'Unknown status.'; END IF;
  UPDATE public.store_customers SET status = p_status, updated_at = now() WHERE id = p_customer_id AND store_id = p_store_id AND status <> 'merged';
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found.'; END IF;
  PERFORM public.customers_audit(p_store_id, p_customer_id, 'customer_' || p_status, '{}'::jsonb);
END $$;

-- ── Notes (the store's own; staff see them, author or a manager edits) ──────
CREATE OR REPLACE FUNCTION public.customer_notes(p_store_id uuid, p_customer_id uuid)
RETURNS TABLE (id uuid, body text, created_at timestamptz, created_by text, updated_at timestamptz, updated_by text, mine boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  RETURN QUERY
  SELECT n.id, n.body, n.created_at, COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username, 'Store owner'),
         n.updated_at, COALESCE(NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.username), n.created_by_user = auth.uid()
    FROM public.store_customer_notes n
    LEFT JOIN public.store_employees e ON e.id = n.created_by_employee
    LEFT JOIN public.store_employees u ON u.id = n.updated_by_employee
   WHERE n.store_id = p_store_id AND n.customer_id = p_customer_id AND n.deleted_at IS NULL
   ORDER BY n.created_at DESC;
END $$;

CREATE OR REPLACE FUNCTION public.customer_note_save(p_store_id uuid, p_customer_id uuid, p_note_id uuid, p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n public.store_customer_notes; v_id uuid;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  IF length(btrim(COALESCE(p_body, ''))) < 1 THEN RAISE EXCEPTION 'The note is empty.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_customers WHERE id = p_customer_id AND store_id = p_store_id) THEN RAISE EXCEPTION 'Customer not found.'; END IF;
  IF p_note_id IS NULL THEN
    INSERT INTO public.store_customer_notes (store_id, customer_id, body, created_by_user, created_by_employee)
    VALUES (p_store_id, p_customer_id, btrim(p_body), auth.uid(), public.myhr_employee_id(p_store_id)) RETURNING id INTO v_id;
    PERFORM public.customers_audit(p_store_id, p_customer_id, 'note_added', jsonb_build_object('note_id', v_id));
    RETURN v_id;
  END IF;
  SELECT * INTO n FROM public.store_customer_notes WHERE id = p_note_id AND store_id = p_store_id AND customer_id = p_customer_id AND deleted_at IS NULL;
  IF n.id IS NULL THEN RAISE EXCEPTION 'Note not found.'; END IF;
  IF n.created_by_user IS DISTINCT FROM auth.uid() AND NOT public.customers_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only the author or a manager can edit this note.'; END IF;
  UPDATE public.store_customer_notes SET body = btrim(p_body), updated_at = now(), updated_by_employee = public.myhr_employee_id(p_store_id) WHERE id = n.id;
  PERFORM public.customers_audit(p_store_id, p_customer_id, 'note_edited', jsonb_build_object('note_id', n.id));
  RETURN n.id;
END $$;

CREATE OR REPLACE FUNCTION public.customer_note_delete(p_store_id uuid, p_note_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n public.store_customer_notes;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  SELECT * INTO n FROM public.store_customer_notes WHERE id = p_note_id AND store_id = p_store_id AND deleted_at IS NULL;
  IF n.id IS NULL THEN RAISE EXCEPTION 'Note not found.'; END IF;
  IF n.created_by_user IS DISTINCT FROM auth.uid() AND NOT public.customers_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only the author or a manager can remove this note.'; END IF;
  UPDATE public.store_customer_notes SET deleted_at = now() WHERE id = n.id;
  PERFORM public.customers_audit(p_store_id, n.customer_id, 'note_removed', jsonb_build_object('note_id', n.id));
END $$;

-- ── Linking a CollectorsHub account (the member approves) ───────────────────
CREATE OR REPLACE FUNCTION public.customer_link_request(p_store_id uuid, p_customer_id uuid, p_profile_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.store_customers; v_id uuid;
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  SELECT * INTO c FROM public.store_customers WHERE id = p_customer_id AND store_id = p_store_id;
  IF c.id IS NULL OR c.status = 'merged' THEN RAISE EXCEPTION 'Customer not found.'; END IF;
  IF c.collectorshub_user_id IS NOT NULL THEN RAISE EXCEPTION 'This customer is already linked to a CollectorsHub account.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile_id AND NULLIF(btrim(username), '') IS NOT NULL) THEN RAISE EXCEPTION 'CollectorsHub account not found.'; END IF;
  UPDATE public.store_customer_link_requests SET status = 'cancelled', decided_at = now() WHERE customer_id = c.id AND status = 'pending';
  INSERT INTO public.store_customer_link_requests (store_id, customer_id, profile_id, requested_by) VALUES (p_store_id, c.id, p_profile_id, auth.uid()) RETURNING id INTO v_id;
  PERFORM public.customers_audit(p_store_id, c.id, 'link_requested', jsonb_build_object('request_id', v_id));
  RETURN v_id;
END $$;

-- Merge one store customer into another (keeps every record; internal).
CREATE OR REPLACE FUNCTION public.customers_merge_rows(p_store_id uuid, p_keep uuid, p_merge uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k public.store_customers; m public.store_customers;
BEGIN
  SELECT * INTO k FROM public.store_customers WHERE id = p_keep AND store_id = p_store_id FOR UPDATE;
  SELECT * INTO m FROM public.store_customers WHERE id = p_merge AND store_id = p_store_id FOR UPDATE;
  IF k.id IS NULL OR m.id IS NULL OR k.id = m.id THEN RAISE EXCEPTION 'Customers not found.'; END IF;
  IF k.collectorshub_user_id IS NOT NULL AND m.collectorshub_user_id IS NOT NULL AND k.collectorshub_user_id <> m.collectorshub_user_id THEN
    RAISE EXCEPTION 'These customers are linked to different CollectorsHub accounts and can''t be merged.';
  END IF;
  UPDATE public.store_transactions SET customer_id = k.id WHERE store_id = p_store_id AND customer_id = m.id;
  UPDATE public.store_credit_ledger SET customer_id = k.id WHERE store_id = p_store_id AND customer_id = m.id;
  UPDATE public.store_customer_notes SET customer_id = k.id WHERE store_id = p_store_id AND customer_id = m.id;
  UPDATE public.store_customer_link_requests SET customer_id = k.id WHERE store_id = p_store_id AND customer_id = m.id;
  IF to_regclass('public.store_orders') IS NOT NULL THEN EXECUTE 'UPDATE public.store_orders SET customer_id = $1 WHERE store_id = $2 AND customer_id = $3' USING k.id, p_store_id, m.id; END IF;
  IF to_regclass('public.store_checkout_groups') IS NOT NULL THEN EXECUTE 'UPDATE public.store_checkout_groups SET customer_id = $1 WHERE store_id = $2 AND customer_id = $3' USING k.id, p_store_id, m.id; END IF;
  IF to_regclass('public.store_buyback_identifications') IS NOT NULL THEN EXECUTE 'UPDATE public.store_buyback_identifications SET customer_id = $1 WHERE store_id = $2 AND customer_id = $3' USING k.id, p_store_id, m.id; END IF;
  UPDATE public.store_customers SET
    collectorshub_user_id = COALESCE(k.collectorshub_user_id, m.collectorshub_user_id),
    membership_code = COALESCE(k.membership_code, m.membership_code),
    first_name = COALESCE(k.first_name, m.first_name), last_name = COALESCE(k.last_name, m.last_name),
    email = COALESCE(k.email, m.email), phone = COALESCE(k.phone, m.phone), address = COALESCE(k.address, m.address),
    created_at = LEAST(k.created_at, m.created_at), updated_at = now()
   WHERE id = k.id;
  UPDATE public.store_customers SET status = 'merged', merged_into = k.id, collectorshub_user_id = NULL, updated_at = now() WHERE id = m.id;
END $$;
REVOKE ALL ON FUNCTION public.customers_merge_rows(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Member side: requests waiting for them, approve or decline.
CREATE OR REPLACE FUNCTION public.customer_link_requests_mine()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first.'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'status', CASE WHEN r.status = 'pending' AND r.expires_at < now() THEN 'expired' ELSE r.status END,
           'requested_at', r.requested_at, 'expires_at', r.expires_at, 'store_name', s.store_name) ORDER BY r.requested_at DESC)
    FROM public.store_customer_link_requests r JOIN public.stores s ON s.id = r.store_id
   WHERE r.profile_id = auth.uid() AND r.requested_at > now() - interval '30 days'), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.customer_link_decide(p_request_id uuid, p_approve boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.store_customer_link_requests; v_existing uuid; v_username text;
BEGIN
  SELECT * INTO r FROM public.store_customer_link_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL OR r.profile_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Request not found.'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request is already %.', r.status; END IF;
  IF r.expires_at < now() THEN UPDATE public.store_customer_link_requests SET status = 'expired' WHERE id = r.id; RAISE EXCEPTION 'This request has expired.'; END IF;
  IF NOT p_approve THEN
    UPDATE public.store_customer_link_requests SET status = 'declined', decided_at = now() WHERE id = r.id;
    INSERT INTO public.store_customer_audit (store_id, customer_id, actor_user, action) VALUES (r.store_id, r.customer_id, auth.uid(), 'link_declined_by_member');
    RETURN 'declined';
  END IF;
  SELECT username INTO v_username FROM public.profiles WHERE id = r.profile_id;
  -- The member may already have a row at this store (made at a checkout): fold it into this customer so nothing is duplicated.
  SELECT id INTO v_existing FROM public.store_customers WHERE store_id = r.store_id AND collectorshub_user_id = r.profile_id AND id <> r.customer_id AND status <> 'merged' LIMIT 1;
  UPDATE public.store_customers SET collectorshub_user_id = r.profile_id, membership_code = v_username, updated_at = now() WHERE id = r.customer_id;
  IF v_existing IS NOT NULL THEN PERFORM public.customers_merge_rows(r.store_id, r.customer_id, v_existing); END IF;
  UPDATE public.store_customer_link_requests SET status = 'approved', decided_at = now() WHERE id = r.id;
  INSERT INTO public.store_customer_audit (store_id, customer_id, actor_user, action, detail)
  VALUES (r.store_id, r.customer_id, auth.uid(), 'linked_by_member', jsonb_build_object('folded_in', v_existing));
  RETURN 'approved';
END $$;

-- Unlink (managers): history and records stay; credit stays with the member's account at this store.
CREATE OR REPLACE FUNCTION public.customer_unlink(p_store_id uuid, p_customer_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  IF NOT public.customers_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can unlink an account.'; END IF;
  UPDATE public.store_customers SET collectorshub_user_id = NULL, updated_at = now() WHERE id = p_customer_id AND store_id = p_store_id AND collectorshub_user_id IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'This customer isn''t linked.'; END IF;
  PERFORM public.customers_audit(p_store_id, p_customer_id, 'unlinked', '{}'::jsonb);
END $$;

-- ── Duplicates and merging (managers) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_duplicates(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  RETURN COALESCE((SELECT jsonb_agg(g) FROM (
    SELECT reason, key, jsonb_agg(jsonb_build_object('id', id, 'customer_number', customer_number, 'name', name, 'email', email, 'phone', phone, 'is_member', is_member, 'created_at', created_at) ORDER BY created_at) AS customers
      FROM (
        SELECT 'Same email' AS reason, lower(email) AS key, id, customer_number, COALESCE(NULLIF(btrim(concat_ws(' ', first_name, last_name)), ''), display_name) AS name, email, phone, collectorshub_user_id IS NOT NULL AS is_member, created_at
          FROM public.store_customers WHERE store_id = p_store_id AND status <> 'merged' AND email IS NOT NULL
        UNION ALL
        SELECT 'Same phone', regexp_replace(phone, '[^0-9]', '', 'g'), id, customer_number, COALESCE(NULLIF(btrim(concat_ws(' ', first_name, last_name)), ''), display_name), email, phone, collectorshub_user_id IS NOT NULL, created_at
          FROM public.store_customers WHERE store_id = p_store_id AND status <> 'merged' AND length(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) >= 7
        UNION ALL
        SELECT 'Same name', lower(concat_ws(' ', first_name, last_name)), id, customer_number, concat_ws(' ', first_name, last_name), email, phone, collectorshub_user_id IS NOT NULL, created_at
          FROM public.store_customers WHERE store_id = p_store_id AND status <> 'merged' AND first_name IS NOT NULL AND last_name IS NOT NULL
      ) x GROUP BY reason, key HAVING count(*) > 1 LIMIT 100) g), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.customer_merge(p_store_id uuid, p_keep uuid, p_merge uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.customers_require_staff(p_store_id);
  IF NOT public.customers_is_manager(p_store_id) THEN RAISE EXCEPTION 'Only managers can merge customers.'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Give a reason for the merge.'; END IF;
  PERFORM public.customers_merge_rows(p_store_id, p_keep, p_merge);
  PERFORM public.customers_audit(p_store_id, p_keep, 'customers_merged', jsonb_build_object('merged', p_merge, 'reason', btrim(p_reason)));
END $$;

GRANT EXECUTE ON FUNCTION public.customers_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customers_list(uuid, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_profile(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_transactions(uuid, uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_transaction_detail(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_trade_ins(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_collection_jobs(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_loyalty(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_create(uuid, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_update(uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_set_status(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_notes(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_note_save(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_note_delete(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_link_request(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_link_requests_mine() TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_link_decide(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_unlink(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_duplicates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_merge(uuid, uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
