-- CollectorsHub POS: Transactions management (ledger, details, refunds, voids, audit).
-- Run after customers.sql. Safe to run more than once.
--
-- Reads the existing ledger (store_transactions + items + payments); nothing here
-- creates a second ledger. Refunds go through the existing complete_store_return
-- (a linked 'return' transaction + store_return_records + store credit), with
-- limits, duplicate protection, item-level returns and permissions added here.
-- Card payments are taken on a separate terminal (no payment integration), so a
-- card refund is recorded only after staff confirm they refunded it on the terminal.
--
-- Permissions (store_employees.action_permissions, or the role defaults):
--   view_all_transactions  owner / manager / store_manager / assistant_manager / supervisor
--   refunds                same roles; others may refund up to $50, or more with a manager's PIN
--   voids                  same roles, or with a manager's PIN
-- The store owner and the store's organization always have all of them.

-- ── Tables ──────────────────────────────────────────────────────────────────
-- Which original lines a refund returned, and whether the stock came back.
CREATE TABLE IF NOT EXISTS public.store_refund_lines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id               uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  original_transaction_id uuid NOT NULL REFERENCES public.store_transactions(id) ON DELETE CASCADE,
  return_transaction_id  uuid REFERENCES public.store_transactions(id) ON DELETE SET NULL,
  original_item_id       uuid NOT NULL REFERENCES public.store_transaction_items(id) ON DELETE CASCADE,
  quantity               integer NOT NULL CHECK (quantity > 0),
  amount                 numeric(12,2) NOT NULL DEFAULT 0,
  restocked              boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_refund_lines_original_idx ON public.store_refund_lines (original_transaction_id);

-- One row per refund request, so a retry (double click, network retry) returns the first result.
CREATE TABLE IF NOT EXISTS public.store_refund_requests (
  request_id             uuid PRIMARY KEY,
  store_id               uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  original_transaction_id uuid NOT NULL REFERENCES public.store_transactions(id) ON DELETE CASCADE,
  result                 jsonb NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit trail (no update/delete through the POS).
CREATE TABLE IF NOT EXISTS public.store_transaction_audit (
  id              bigserial PRIMARY KEY,
  store_id        uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  transaction_id  uuid REFERENCES public.store_transactions(id) ON DELETE SET NULL,
  location_id     uuid,
  employee_id     uuid,
  actor_user      uuid,
  action          text NOT NULL,
  reason          text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_transaction_audit_txn_idx ON public.store_transaction_audit (transaction_id, created_at);
CREATE INDEX IF NOT EXISTS store_transaction_audit_store_idx ON public.store_transaction_audit (store_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['store_refund_lines', 'store_refund_requests', 'store_transaction_audit'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS store_txn_store_employee_idx ON public.store_transactions (store_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS store_return_records_original_idx ON public.store_return_records (original_transaction_id);

-- Creation, completion and status changes are recorded automatically.
CREATE OR REPLACE FUNCTION public.tx_audit_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.store_transaction_audit (store_id, transaction_id, location_id, employee_id, actor_user, action, detail)
    VALUES (NEW.store_id, NEW.id, NEW.location_id, NEW.employee_id, auth.uid(), CASE WHEN NEW.status = 'completed' THEN 'completed' ELSE 'created' END,
            jsonb_build_object('type', NEW.transaction_type, 'status', NEW.status, 'total', NEW.total, 'number', NEW.transaction_number));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.store_transaction_audit (store_id, transaction_id, location_id, employee_id, actor_user, action, detail)
    VALUES (NEW.store_id, NEW.id, NEW.location_id, NEW.employee_id, auth.uid(), 'status_changed', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS store_transactions_audit ON public.store_transactions;
CREATE TRIGGER store_transactions_audit AFTER INSERT OR UPDATE OF status ON public.store_transactions
  FOR EACH ROW EXECUTE FUNCTION public.tx_audit_trigger();

-- ── Access ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tx_access(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid; v_role text; v_perm jsonb := '{}'::jsonb; v_boss boolean; v_lead boolean;
BEGIN
  IF p_store_id IS NULL OR p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  v_emp := public.current_store_employee_id(p_store_id);
  SELECT lower(COALESCE(e.role, '')), COALESCE(e.action_permissions, e.permissions, '{}'::jsonb) INTO v_role, v_perm FROM public.store_employees e WHERE e.id = v_emp;
  v_boss := EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND (s.owner_user_id = auth.uid() OR s.organization_id IN (SELECT public.user_org_ids())));
  v_lead := v_boss OR COALESCE(v_role, '') IN ('owner', 'manager', 'store_manager', 'assistant_manager', 'supervisor');
  RETURN jsonb_build_object(
    'employee_id', v_emp,
    'view_all', v_lead OR (v_perm ->> 'view_all_transactions') = 'true',
    'refund', v_lead OR (v_perm ->> 'refunds') = 'true',
    'void', v_lead OR (v_perm ->> 'voids') = 'true',
    'sensitive', v_lead,
    'refund_limit', 50);
END $$;
REVOKE ALL ON FUNCTION public.tx_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tx_access(uuid) TO authenticated;

-- A manager's username + PIN, checked on the server (approvals for refunds / voids).
CREATE OR REPLACE FUNCTION public.tx_check_approver(p_store_id uuid, p_approver jsonb)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code text; r record;
BEGIN
  IF p_approver IS NULL OR COALESCE(p_approver ->> 'username', '') = '' OR COALESCE(p_approver ->> 'pin', '') = '' THEN RETURN NULL; END IF;
  SELECT store_code INTO v_code FROM public.stores WHERE id = p_store_id;
  SELECT * INTO r FROM public.verify_store_employee_pin(v_code, p_approver ->> 'username', p_approver ->> 'pin') LIMIT 1;
  IF r.employee_id IS NULL OR r.store_id IS DISTINCT FROM p_store_id THEN RAISE EXCEPTION 'Manager username or PIN is not correct.'; END IF;
  IF lower(COALESCE(r.role, '')) NOT IN ('owner', 'manager', 'store_manager', 'assistant_manager', 'supervisor') THEN RAISE EXCEPTION 'That employee can''t approve this.'; END IF;
  RETURN r.employee_id;
END $$;
REVOKE ALL ON FUNCTION public.tx_check_approver(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- The store's time zone (first location that has one).
CREATE OR REPLACE FUNCTION public.tx_store_tz(p_store_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT l.time_zone FROM public.store_locations l WHERE l.store_id = p_store_id AND NULLIF(l.time_zone, '') IS NOT NULL
                    AND EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = l.time_zone) ORDER BY l.created_at LIMIT 1), 'America/Halifax')
$$;
REVOKE ALL ON FUNCTION public.tx_store_tz(uuid) FROM PUBLIC, anon, authenticated;

-- What a customer paid on a transaction (positive payments; trade-in credit isn't money paid), and what's been refunded.
CREATE OR REPLACE FUNCTION public.tx_paid(p_txn uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(sum(p.amount) FILTER (WHERE p.amount > 0 AND p.method <> 'trade_credit'), 0) FROM public.store_transaction_payments p WHERE p.transaction_id = p_txn
$$;
CREATE OR REPLACE FUNCTION public.tx_refunded(p_txn uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(sum(r.refund_amount), 0) FROM public.store_return_records r WHERE r.original_transaction_id = p_txn
$$;
REVOKE ALL ON FUNCTION public.tx_paid(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tx_refunded(uuid) FROM PUBLIC, anon, authenticated;

-- Ledger type: sale | buy | trade_in | trade (trade-in + sale) | refund | adjustment
CREATE OR REPLACE FUNCTION public.tx_kind(t public.store_transactions)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN t.transaction_type = 'sale' THEN 'sale'
    WHEN t.transaction_type = 'exchange' THEN 'trade'
    WHEN t.transaction_type IN ('return', 'refund') THEN 'refund'
    WHEN t.transaction_type = 'trade_in' THEN CASE WHEN t.trade_credit_total > 0 OR EXISTS (SELECT 1 FROM public.store_transaction_payments p WHERE p.transaction_id = t.id AND p.method IN ('store_credit', 'trade_credit')) THEN 'trade_in' ELSE 'buy' END
    ELSE t.transaction_type END
$$;
-- Ledger status: completed | refunded | partially_refunded | voided | pending
CREATE OR REPLACE FUNCTION public.tx_state(t public.store_transactions)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN t.status = 'void' THEN 'voided'
    WHEN t.status <> 'completed' THEN 'pending'
    WHEN t.transaction_type IN ('sale', 'exchange') THEN
      CASE WHEN public.tx_refunded(t.id) <= 0 THEN 'completed'
           WHEN public.tx_refunded(t.id) >= public.tx_paid(t.id) - 0.005 THEN 'refunded'
           ELSE 'partially_refunded' END
    ELSE 'completed' END
$$;
-- cash | card | store_credit | mixed | other | none
CREATE OR REPLACE FUNCTION public.tx_payment_kind(p_txn uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE count(DISTINCT k) WHEN 0 THEN 'none' WHEN 1 THEN min(k) ELSE 'mixed' END
    FROM (SELECT CASE WHEN p.method = 'cash' THEN 'cash' WHEN p.method IN ('card', 'debit', 'credit') THEN 'card'
                      WHEN p.method IN ('store_credit', 'trade_credit') THEN 'store_credit' ELSE 'other' END AS k
            FROM public.store_transaction_payments p WHERE p.transaction_id = p_txn AND p.amount <> 0) x
$$;
REVOKE ALL ON FUNCTION public.tx_kind(public.store_transactions) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tx_state(public.store_transactions) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tx_payment_kind(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tx_employee_name(p_employee uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(btrim(concat_ws(' ', e.first_name, e.last_name)), ''), e.username) FROM public.store_employees e WHERE e.id = p_employee
$$;
REVOKE ALL ON FUNCTION public.tx_employee_name(uuid) FROM PUBLIC, anon, authenticated;

-- ── Summary cards (store-local "today", all of the store's transactions) ────
CREATE OR REPLACE FUNCTION public.tx_summary(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tz text; v_from timestamptz; v_to timestamptz;
BEGIN
  PERFORM public.tx_access(p_store_id);
  v_tz := public.tx_store_tz(p_store_id);
  v_from := (date_trunc('day', now() AT TIME ZONE v_tz)) AT TIME ZONE v_tz;
  v_to := v_from + interval '1 day';
  RETURN (
    WITH t AS (
      SELECT * FROM public.store_transactions
       WHERE store_id = p_store_id AND status = 'completed' AND COALESCE(completed_at, created_at) >= v_from AND COALESCE(completed_at, created_at) < v_to
    )
    SELECT jsonb_build_object(
      'time_zone', v_tz,
      -- Net sales before tax: sale/exchange subtotals less refunds (their pre-tax part). Trade-in credit isn't revenue.
      'sales', COALESCE((SELECT sum(subtotal) FROM t WHERE transaction_type IN ('sale', 'exchange')), 0)
             + COALESCE((SELECT sum(subtotal) FROM t WHERE transaction_type IN ('return', 'refund')), 0),
      'refunds', COALESCE((SELECT sum(abs(total)) FROM t WHERE transaction_type IN ('return', 'refund')), 0),
      'items_sold', COALESCE((SELECT sum(i.quantity) FROM t JOIN public.store_transaction_items i ON i.transaction_id = t.id
                               WHERE t.transaction_type IN ('sale', 'exchange') AND i.direction = 'out'), 0)
                  - COALESCE((SELECT sum(l.quantity) FROM t JOIN public.store_refund_lines l ON l.return_transaction_id = t.id), 0),
      'transactions', (SELECT count(*) FROM t))
  );
END $$;

-- ── Ledger ──────────────────────────────────────────────────────────────────
-- p_filter: all | sales | buys | refunds | voided | pending | mine
-- p_range:  today | yesterday | 7d | 30d | custom (p_from / p_to dates, store-local) | all
-- p_payment: cash | card | store_credit | mixed | other;  p_status: completed | refunded | partially_refunded | voided | pending
CREATE OR REPLACE FUNCTION public.tx_list(p_store_id uuid, p_filter text DEFAULT 'all', p_search text DEFAULT '', p_range text DEFAULT '30d',
                                          p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_employee_id uuid DEFAULT NULL, p_payment text DEFAULT NULL,
                                          p_status text DEFAULT NULL, p_customer_id uuid DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_access jsonb := public.tx_access(p_store_id); v_tz text := public.tx_store_tz(p_store_id);
        v_today date; v_from date; v_to date; v_q text := lower(btrim(COALESCE(p_search, '')));
        v_emp uuid; v_all boolean;
BEGIN
  v_emp := NULLIF(v_access ->> 'employee_id', '')::uuid;
  v_all := (v_access ->> 'view_all')::boolean;
  v_today := (now() AT TIME ZONE v_tz)::date;
  SELECT CASE p_range WHEN 'today' THEN v_today WHEN 'yesterday' THEN v_today - 1 WHEN '7d' THEN v_today - 6 WHEN '30d' THEN v_today - 29 WHEN 'custom' THEN p_from END,
         CASE p_range WHEN 'yesterday' THEN v_today WHEN 'custom' THEN p_to + 1 WHEN 'all' THEN NULL ELSE v_today + 1 END
    INTO v_from, v_to;
  -- (dates are converted to the store's time zone below)
  RETURN (
    WITH base AS (
      SELECT t.*, public.tx_kind(t) AS kind, public.tx_state(t) AS state, public.tx_payment_kind(t.id) AS pay
        FROM public.store_transactions t
       WHERE t.store_id = p_store_id
         AND (v_from IS NULL OR t.created_at >= (v_from::timestamp AT TIME ZONE v_tz))
         AND (v_to IS NULL OR t.created_at < (v_to::timestamp AT TIME ZONE v_tz))
         -- Without "view all", employees see their own transactions (and can look one up by its exact number).
         AND (v_all OR t.employee_id = v_emp OR (v_q <> '' AND lower(t.transaction_number) = v_q))
         AND (p_filter <> 'mine' OR t.employee_id = v_emp)
         AND (p_employee_id IS NULL OR t.employee_id = p_employee_id)
         AND (p_customer_id IS NULL OR t.customer_id = p_customer_id)
         AND (v_q = '' OR lower(t.transaction_number) LIKE '%' || v_q || '%'
              OR EXISTS (SELECT 1 FROM public.store_checkout_groups g WHERE g.id = t.checkout_group_id AND lower(g.group_number) LIKE '%' || v_q || '%')
              OR EXISTS (SELECT 1 FROM public.store_customers c LEFT JOIN public.profiles pr ON pr.id = c.collectorshub_user_id
                          WHERE c.id = t.customer_id AND (lower(concat_ws(' ', c.first_name, c.last_name, c.display_name)) LIKE '%' || v_q || '%'
                                OR lower(COALESCE(pr.username, '')) LIKE '%' || ltrim(v_q, '@') || '%' OR lower(COALESCE(c.customer_number, '')) = v_q))
              OR EXISTS (SELECT 1 FROM public.store_transaction_items i LEFT JOIN public.store_inventory si ON si.id = i.inventory_id
                          WHERE i.transaction_id = t.id AND (lower(COALESCE(i.sku_snapshot, '')) LIKE '%' || v_q || '%' OR lower(COALESCE(i.name_snapshot, '')) LIKE '%' || v_q || '%'
                                OR lower(COALESCE(si.barcode, '')) = v_q)))
    ),
    filtered AS (
      SELECT * FROM base b
       WHERE CASE p_filter WHEN 'sales' THEN b.kind IN ('sale', 'trade') AND b.status <> 'void'
                           WHEN 'buys' THEN b.kind IN ('buy', 'trade_in', 'trade') AND b.status <> 'void'
                           WHEN 'refunds' THEN b.kind = 'refund' WHEN 'voided' THEN b.state = 'voided' WHEN 'pending' THEN b.state = 'pending'
                           WHEN 'pawn' THEN b.transaction_type LIKE 'pawn\_%' ELSE true END
         AND (p_payment IS NULL OR p_payment = '' OR b.pay = p_payment)
         AND (p_status IS NULL OR p_status = '' OR b.state = p_status)
    ),
    page AS (SELECT * FROM filtered ORDER BY created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0))
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM filtered),
      'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', p.id, 'number', p.transaction_number, 'created_at', p.created_at, 'completed_at', p.completed_at,
          'kind', p.kind, 'state', p.state, 'payment', p.pay, 'total', p.total, 'refunded', public.tx_refunded(p.id),
          'items', (SELECT COALESCE(sum(i.quantity), 0) FROM public.store_transaction_items i WHERE i.transaction_id = p.id),
          'employee_id', p.employee_id, 'employee', public.tx_employee_name(p.employee_id), 'mine', p.employee_id = v_emp,
          'customer_id', p.customer_id,
          'customer', (SELECT COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), NULLIF(btrim(c.display_name), ''), pr.display_name, pr.username)
                         FROM public.store_customers c LEFT JOIN public.profiles pr ON pr.id = c.collectorshub_user_id WHERE c.id = p.customer_id),
          'username', (SELECT pr.username FROM public.store_customers c JOIN public.profiles pr ON pr.id = c.collectorshub_user_id WHERE c.id = p.customer_id))
        ORDER BY p.created_at DESC) FROM page p), '[]'::jsonb),
      'employees', CASE WHEN v_all THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'name', public.tx_employee_name(e.id)) ORDER BY public.tx_employee_name(e.id))
                                                   FROM public.store_employees e WHERE e.store_id = p_store_id AND EXISTS (SELECT 1 FROM public.store_transactions x WHERE x.store_id = p_store_id AND x.employee_id = e.id)), '[]'::jsonb) END,
      'access', v_access)
  );
END $$;

-- ── Details ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tx_detail(p_store_id uuid, p_transaction_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_access jsonb := public.tx_access(p_store_id); t public.store_transactions; v_sensitive boolean; v_paid numeric; v_refunded numeric;
BEGIN
  SELECT * INTO t FROM public.store_transactions WHERE id = p_transaction_id AND store_id = p_store_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Transaction not found.'; END IF;
  -- Any staff member of the store can open a transaction they found (the ledger limits what they can browse).
  v_sensitive := (v_access ->> 'sensitive')::boolean;
  v_paid := public.tx_paid(t.id);
  v_refunded := public.tx_refunded(t.id);
  RETURN jsonb_build_object(
    'access', v_access,
    'transaction', jsonb_build_object(
      'id', t.id, 'number', t.transaction_number, 'kind', public.tx_kind(t), 'type', t.transaction_type, 'state', public.tx_state(t), 'status', t.status,
      'created_at', t.created_at, 'completed_at', t.completed_at, 'notes', t.notes,
      'subtotal', t.subtotal, 'discount_total', t.discount_total, 'tax_total', t.tax_total, 'trade_credit_total', t.trade_credit_total,
      'store_credit_total', t.store_credit_total, 'total', t.total, 'balance', t.balance,
      'paid', v_paid, 'refunded', v_refunded, 'refundable', GREATEST(v_paid - v_refunded, 0),
      'group_number', (SELECT g.group_number FROM public.store_checkout_groups g WHERE g.id = t.checkout_group_id),
      'store_name', (SELECT s.store_name FROM public.stores s WHERE s.id = t.store_id),
      'location_name', (SELECT l.location_name FROM public.store_locations l WHERE l.id = t.location_id),
      'location_id', t.location_id,
      'register', (SELECT sh.register_name FROM public.store_register_shifts sh WHERE sh.location_id = t.location_id AND sh.opened_at <= t.created_at
                     AND (sh.closed_at IS NULL OR sh.closed_at >= t.created_at) ORDER BY sh.opened_at DESC LIMIT 1),
      'employee', public.tx_employee_name(t.employee_id), 'employee_id', t.employee_id,
      'original', (SELECT jsonb_build_object('id', o.id, 'number', o.transaction_number) FROM public.store_return_records r JOIN public.store_transactions o ON o.id = r.original_transaction_id WHERE r.return_transaction_id = t.id LIMIT 1)),
    'customer', (SELECT jsonb_build_object('id', c.id, 'customer_number', c.customer_number, 'is_member', c.collectorshub_user_id IS NOT NULL,
                   'name', COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), NULLIF(btrim(c.display_name), ''), pr.display_name, pr.username),
                   'username', pr.username, 'avatar_url', pr.avatar_url, 'email', CASE WHEN v_sensitive OR t.employee_id = NULLIF(v_access ->> 'employee_id', '')::uuid THEN c.email END)
                   FROM public.store_customers c LEFT JOIN public.profiles pr ON pr.id = c.collectorshub_user_id WHERE c.id = t.customer_id),
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'direction', i.direction, 'name', i.name_snapshot, 'sku', i.sku_snapshot, 'catalog_item_id', i.catalog_item_id, 'inventory_id', i.inventory_id,
        'condition', i.condition, 'grade', i.grade, 'quantity', i.quantity, 'unit_price', i.unit_price, 'discount', i.discount_total, 'line_total', i.line_total,
        'refunded_qty', COALESCE((SELECT sum(l.quantity) FROM public.store_refund_lines l WHERE l.original_item_id = i.id), 0),
        'image_path', (SELECT ii.image_path FROM public.item_images ii WHERE ii.item_id = i.catalog_item_id AND NULLIF(ii.image_path, '') IS NOT NULL ORDER BY ii.position LIMIT 1),
        'store_image_path', (SELECT sim.storage_path FROM public.store_inventory_images sim WHERE sim.inventory_id = i.inventory_id ORDER BY sim.position LIMIT 1))
        ORDER BY i.direction DESC, i.created_at) FROM public.store_transaction_items i WHERE i.transaction_id = t.id), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', p.method, 'amount', p.amount, 'reference', p.reference) ORDER BY p.created_at)
                           FROM public.store_transaction_payments p WHERE p.transaction_id = t.id), '[]'::jsonb),
    'refunds', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'transaction_id', r.return_transaction_id, 'number', rt.transaction_number, 'created_at', r.created_at, 'method', r.refund_method,
        'amount', r.refund_amount, 'reason', r.reason, 'employee', public.tx_employee_name(r.employee_id),
        'lines', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', oi.name_snapshot, 'quantity', l.quantity, 'amount', l.amount, 'restocked', l.restocked))
                             FROM public.store_refund_lines l JOIN public.store_transaction_items oi ON oi.id = l.original_item_id WHERE l.return_transaction_id = r.return_transaction_id), '[]'::jsonb))
        ORDER BY r.created_at) FROM public.store_return_records r LEFT JOIN public.store_transactions rt ON rt.id = r.return_transaction_id WHERE r.original_transaction_id = t.id), '[]'::jsonb),
    'store_credit', COALESCE((SELECT jsonb_agg(jsonb_build_object('entry_type', l.entry_type, 'amount', l.amount, 'created_at', l.created_at, 'note', l.note) ORDER BY l.created_at)
                               FROM public.store_credit_ledger l WHERE l.store_id = p_store_id AND (l.transaction_id = t.id
                                 OR l.transaction_id IN (SELECT r.return_transaction_id FROM public.store_return_records r WHERE r.original_transaction_id = t.id))), '[]'::jsonb),
    -- Seller identification for buys / trade-ins: only for supervisors and managers.
    'identification', CASE WHEN v_sensitive THEN jsonb_build_object(
        'seller', (SELECT jsonb_build_object('name', v.seller_name, 'photo_id_shown', v.photo_id_shown, 'id_type', v.id_type, 'verified_by', public.tx_employee_name(v.verified_by_employee_id), 'verified_at', v.verified_at)
                     FROM public.store_seller_verifications v WHERE v.transaction_id = t.id LIMIT 1),
        'buyback', CASE WHEN to_regclass('public.store_buyback_identifications') IS NOT NULL THEN
                     (SELECT jsonb_build_object('method', b.method, 'id_type', b.id_type, 'employee', public.tx_employee_name(b.employee_id), 'created_at', b.created_at)
                        FROM public.store_buyback_identifications b WHERE b.transaction_id = t.id ORDER BY b.created_at DESC LIMIT 1) END)
      ELSE NULL END,
    'audit', CASE WHEN v_sensitive THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('action', a.action, 'reason', a.reason, 'created_at', a.created_at,
                    'employee', public.tx_employee_name(a.employee_id), 'detail', a.detail) ORDER BY a.created_at)
               FROM public.store_transaction_audit a WHERE a.transaction_id = t.id), '[]'::jsonb) END
  );
END $$;

-- ── Refund ──────────────────────────────────────────────────────────────────
-- p_lines: [{ item_id, quantity, restock }] (returned items), or [] for an amount-only refund.
-- p_amount: the amount to refund (defaults to the lines' value incl. their share of tax).
-- p_method: cash | card | store_credit.  p_request_id: a fresh uuid per attempt (retries return the first result).
CREATE OR REPLACE FUNCTION public.tx_refund(p_store_id uuid, p_location_id uuid, p_transaction_id uuid, p_lines jsonb, p_amount numeric,
                                            p_method text, p_reason text, p_request_id uuid, p_approver jsonb DEFAULT NULL, p_card_confirmed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_access jsonb := public.tx_access(p_store_id); t public.store_transactions; v_prev jsonb; v_paid numeric; v_refunded numeric; v_remaining numeric;
        v_line jsonb; it public.store_transaction_items; v_qty integer; v_done integer; v_amount numeric := 0; v_lines_amount numeric := 0; v_tax numeric := 0;
        v_out_total numeric; v_restock jsonb := '[]'::jsonb; v_records jsonb := '[]'::jsonb; v_approver uuid; v_card_paid numeric; v_card_refunded numeric;
        v_result jsonb; v_return uuid; v_share numeric; v_line_tax numeric; v_lines_tax numeric := 0; v_money_paid numeric; v_money_refunded numeric;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Missing request id.'; END IF;
  SELECT result INTO v_prev FROM public.store_refund_requests WHERE request_id = p_request_id;
  IF v_prev IS NOT NULL THEN RETURN v_prev || jsonb_build_object('repeated', true); END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'A refund reason is required.'; END IF;
  IF p_method NOT IN ('cash', 'card', 'store_credit') THEN RAISE EXCEPTION 'Choose cash, card or store credit.'; END IF;

  -- Locks the sale so two refunds can't run at once.
  SELECT * INTO t FROM public.store_transactions WHERE id = p_transaction_id AND store_id = p_store_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Transaction not found.'; END IF;
  IF t.status <> 'completed' THEN RAISE EXCEPTION 'Only completed transactions can be refunded.'; END IF;
  IF t.transaction_type NOT IN ('sale', 'exchange') THEN RAISE EXCEPTION 'Only sales can be refunded. Buys and trade-ins aren''t refunds.'; END IF;
  IF p_location_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.store_locations l WHERE l.id = p_location_id AND l.store_id = p_store_id) THEN p_location_id := t.location_id; END IF;

  v_paid := public.tx_paid(t.id);
  v_refunded := public.tx_refunded(t.id);
  v_remaining := round(v_paid - v_refunded, 2);
  IF v_remaining <= 0 THEN RAISE EXCEPTION 'This transaction has already been fully refunded.'; END IF;

  SELECT COALESCE(sum(line_total), 0) INTO v_out_total FROM public.store_transaction_items WHERE transaction_id = t.id AND direction = 'out';
  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) LOOP
    SELECT * INTO it FROM public.store_transaction_items WHERE id = NULLIF(v_line ->> 'item_id', '')::uuid AND transaction_id = t.id AND direction = 'out';
    IF it.id IS NULL THEN RAISE EXCEPTION 'That item isn''t part of this sale.'; END IF;
    v_qty := COALESCE((v_line ->> 'quantity')::integer, 0);
    IF v_qty < 1 THEN CONTINUE; END IF;
    SELECT COALESCE(sum(quantity), 0) INTO v_done FROM public.store_refund_lines WHERE original_item_id = it.id;
    IF v_qty > it.quantity - v_done THEN RAISE EXCEPTION 'Only % of "%" can still be refunded.', it.quantity - v_done, COALESCE(it.name_snapshot, 'this item'); END IF;
    -- The line's price paid, plus its share of the sale's tax.
    v_share := round(it.line_total / GREATEST(it.quantity, 1) * v_qty, 2);
    v_line_tax := CASE WHEN v_out_total > 0 THEN round(t.tax_total * v_share / v_out_total, 2) ELSE 0 END;
    v_share := v_share + v_line_tax;
    v_lines_tax := v_lines_tax + v_line_tax;
    v_lines_amount := v_lines_amount + v_share;
    v_records := v_records || jsonb_build_object('item_id', it.id, 'quantity', v_qty, 'amount', v_share, 'restock', COALESCE((v_line ->> 'restock')::boolean, false) AND it.inventory_id IS NOT NULL);
    IF COALESCE((v_line ->> 'restock')::boolean, false) AND it.inventory_id IS NOT NULL THEN
      v_restock := v_restock || jsonb_build_object('inventory_id', it.inventory_id, 'catalog_item_id', it.catalog_item_id, 'direction', 'in',
                    'name_snapshot', it.name_snapshot, 'sku_snapshot', it.sku_snapshot, 'condition', it.condition, 'grade', it.grade,
                    'unit_price', it.unit_price, 'quantity', v_qty, 'line_total', round(it.line_total / GREATEST(it.quantity, 1) * v_qty, 2));
    END IF;
  END LOOP;

  v_amount := round(COALESCE(NULLIF(p_amount, 0), v_lines_amount), 2);
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount or choose items to refund.'; END IF;
  IF v_amount > v_remaining THEN RAISE EXCEPTION 'At most % can still be refunded on this transaction.', to_char(v_remaining, 'FM$999,999,990.00'); END IF;

  -- What was paid with store credit goes back as store credit, not cash or card.
  IF p_method IN ('cash', 'card') THEN
    SELECT COALESCE(sum(amount) FILTER (WHERE amount > 0 AND method NOT IN ('store_credit', 'trade_credit')), 0) INTO v_money_paid FROM public.store_transaction_payments WHERE transaction_id = t.id;
    SELECT COALESCE(sum(refund_amount), 0) INTO v_money_refunded FROM public.store_return_records WHERE original_transaction_id = t.id AND refund_method IN ('cash', 'card');
    IF v_amount > v_money_paid - v_money_refunded + 0.005 THEN
      RAISE EXCEPTION 'At most % can be refunded as cash or card; the rest was paid with store credit, so refund that as store credit.', to_char(GREATEST(v_money_paid - v_money_refunded, 0), 'FM$999,999,990.00');
    END IF;
  END IF;

  -- Card: no more than was paid by card, and only after it was refunded on the terminal.
  IF p_method = 'card' THEN
    SELECT COALESCE(sum(amount) FILTER (WHERE amount > 0), 0) INTO v_card_paid FROM public.store_transaction_payments WHERE transaction_id = t.id AND method IN ('card', 'debit', 'credit');
    SELECT COALESCE(sum(refund_amount), 0) INTO v_card_refunded FROM public.store_return_records WHERE original_transaction_id = t.id AND refund_method = 'card';
    IF v_card_paid <= 0 THEN RAISE EXCEPTION 'This sale wasn''t paid by card. Refund it as cash or store credit.'; END IF;
    IF v_amount > v_card_paid - v_card_refunded + 0.005 THEN RAISE EXCEPTION 'At most % can go back to the card.', to_char(v_card_paid - v_card_refunded, 'FM$999,999,990.00'); END IF;
    IF NOT COALESCE(p_card_confirmed, false) THEN RAISE EXCEPTION 'Refund the card on the payment terminal first, then confirm it here.'; END IF;
  END IF;

  -- Permission: refunds permission, or up to the limit, or a manager's approval.
  IF NOT (v_access ->> 'refund')::boolean AND v_amount > (v_access ->> 'refund_limit')::numeric THEN
    v_approver := public.tx_check_approver(p_store_id, p_approver);
    IF v_approver IS NULL THEN RAISE EXCEPTION 'APPROVAL_REQUIRED: Refunds over % need a supervisor or manager.', to_char((v_access ->> 'refund_limit')::numeric, 'FM$999,990.00'); END IF;
  ELSIF p_approver IS NOT NULL THEN
    v_approver := public.tx_check_approver(p_store_id, p_approver);
  END IF;

  -- The existing return engine: linked 'return' transaction, return record, restock, store credit.
  v_result := public.complete_store_return(t.id, p_location_id, v_restock, p_method, v_amount, btrim(p_reason));
  v_return := (v_result ->> 'transaction_id')::uuid;
  v_tax := CASE WHEN v_lines_amount > 0 THEN round(v_lines_tax * v_amount / v_lines_amount, 2)
                ELSE round(v_amount * t.tax_total / NULLIF(t.subtotal + t.tax_total, 0), 2) END;
  v_tax := LEAST(v_amount, GREATEST(COALESCE(v_tax, 0), 0));
  UPDATE public.store_transactions SET subtotal = -(v_amount - v_tax), tax_total = -v_tax WHERE id = v_return;

  INSERT INTO public.store_refund_lines (store_id, original_transaction_id, return_transaction_id, original_item_id, quantity, amount, restocked)
  SELECT p_store_id, t.id, v_return, (r ->> 'item_id')::uuid, (r ->> 'quantity')::integer, (r ->> 'amount')::numeric, (r ->> 'restock')::boolean
    FROM jsonb_array_elements(v_records) r;

  INSERT INTO public.store_transaction_audit (store_id, transaction_id, location_id, employee_id, actor_user, action, reason, detail)
  VALUES (p_store_id, t.id, p_location_id, public.current_store_employee_id(p_store_id), auth.uid(), 'refund_completed', btrim(p_reason),
          jsonb_build_object('return_transaction_id', v_return, 'return_number', v_result ->> 'transaction_number', 'amount', v_amount, 'tax', v_tax,
                             'method', p_method, 'lines', v_records, 'approved_by', v_approver, 'card_terminal_confirmed', p_method = 'card'));

  v_result := jsonb_build_object('transaction_id', v_return, 'transaction_number', v_result ->> 'transaction_number', 'amount', v_amount, 'tax', v_tax,
                                 'method', p_method, 'remaining', round(v_remaining - v_amount, 2));
  INSERT INTO public.store_refund_requests (request_id, store_id, original_transaction_id, result) VALUES (p_request_id, p_store_id, t.id, v_result);
  RETURN v_result;
END $$;

-- ── Void (only transactions that aren't completed) ──────────────────────────
CREATE OR REPLACE FUNCTION public.tx_void(p_store_id uuid, p_transaction_id uuid, p_reason text, p_approver jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_access jsonb := public.tx_access(p_store_id); t public.store_transactions; v_approver uuid;
BEGIN
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'A reason is required.'; END IF;
  SELECT * INTO t FROM public.store_transactions WHERE id = p_transaction_id AND store_id = p_store_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'Transaction not found.'; END IF;
  IF t.status = 'void' THEN RAISE EXCEPTION 'This transaction is already voided.'; END IF;
  IF t.status = 'completed' THEN RAISE EXCEPTION 'Completed transactions can''t be voided. Refund it instead.'; END IF;
  IF NOT (v_access ->> 'void')::boolean THEN
    v_approver := public.tx_check_approver(p_store_id, p_approver);
    IF v_approver IS NULL THEN RAISE EXCEPTION 'APPROVAL_REQUIRED: Voids need a supervisor or manager.'; END IF;
  END IF;
  -- Not completed: no stock or payment was taken, so there's nothing to reverse.
  UPDATE public.store_transactions SET status = 'void' WHERE id = t.id;
  INSERT INTO public.store_transaction_audit (store_id, transaction_id, location_id, employee_id, actor_user, action, reason, detail)
  VALUES (p_store_id, t.id, t.location_id, public.current_store_employee_id(p_store_id), auth.uid(), 'voided', btrim(p_reason),
          jsonb_build_object('previous_status', t.status, 'approved_by', v_approver));
END $$;

-- Reprints and emailed receipts are recorded too.
CREATE OR REPLACE FUNCTION public.tx_log_receipt(p_store_id uuid, p_transaction_id uuid, p_action text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.tx_access(p_store_id);
  IF p_action NOT IN ('receipt_printed', 'receipt_emailed', 'receipt_viewed') THEN RAISE EXCEPTION 'unknown action'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_transactions WHERE id = p_transaction_id AND store_id = p_store_id) THEN RAISE EXCEPTION 'Transaction not found.'; END IF;
  INSERT INTO public.store_transaction_audit (store_id, transaction_id, employee_id, actor_user, action)
  VALUES (p_store_id, p_transaction_id, public.current_store_employee_id(p_store_id), auth.uid(), p_action);
END $$;

GRANT EXECUTE ON FUNCTION public.tx_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tx_list(uuid, text, text, text, date, date, uuid, text, text, uuid, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tx_detail(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tx_refund(uuid, uuid, uuid, jsonb, numeric, text, text, uuid, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tx_void(uuid, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tx_log_receipt(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
