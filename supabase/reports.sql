-- CollectorsHub POS: Reports & Analytics.
-- Run after transactions.sql (and customer_wishlists.sql / pawn_loans.sql for those tabs).
-- Safe to run more than once.
--
-- Everything is read from the existing records (store_transactions + items + payments,
-- store_inventory, store_credit_ledger, store_register_shifts, pawn tables, wishlists);
-- no reporting copy of the data. All money figures go through rpt_facts, one row per
-- completed transaction, so every tab and export uses the same definitions:
--   Gross sales   = sale/exchange subtotals + their discounts (before tax)
--   Discounts     = discount_total on sales
--   Refunds       = pre-tax value of return transactions in the period (dated when refunded)
--   Net sales     = gross - discounts - refunds (= sale subtotals + return subtotals); no tax
--   COGS          = recorded cost of items sold - cost of returned items put back in stock
--   Gross profit  = net sales - COGS (marked incomplete when sold lines have no recorded cost)
--   Sales count   = completed sale/exchange transactions; refunds aren't counted as sales
--   Avg. sale     = net sales / sales count
-- Buys / trade-ins and pawn money movements are never sales revenue.
--
-- Two snapshots are added so history doesn't change when settings do:
--   store_transaction_items.cost_snapshot: the item's recorded cost when it was sold
--   store_transactions.tax_snapshot: the location's tax names / rates when it was rung up
-- Older rows: cost is backfilled from the item's current cost (cost_source says so);
-- tax shows as "breakdown not recorded" rather than being recalculated with today's rates.

-- ── Snapshots ───────────────────────────────────────────────────────────────
ALTER TABLE public.store_transaction_items ADD COLUMN IF NOT EXISTS cost_snapshot numeric(12,2);
ALTER TABLE public.store_transaction_items ADD COLUMN IF NOT EXISTS cost_source text;
ALTER TABLE public.store_transactions ADD COLUMN IF NOT EXISTS tax_snapshot jsonb;
ALTER TABLE public.store_register_shifts ADD COLUMN IF NOT EXISTS closed_by_employee uuid;

CREATE OR REPLACE FUNCTION public.rpt_item_cost_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.direction = 'out' AND NEW.cost_snapshot IS NULL AND NEW.inventory_id IS NOT NULL THEN
    SELECT COALESCE(si.cost_basis, si.buy_price) INTO NEW.cost_snapshot FROM public.store_inventory si WHERE si.id = NEW.inventory_id;
    IF NEW.cost_snapshot IS NOT NULL THEN NEW.cost_source := 'recorded at sale'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS store_transaction_items_cost_snapshot ON public.store_transaction_items;
CREATE TRIGGER store_transaction_items_cost_snapshot BEFORE INSERT ON public.store_transaction_items
  FOR EACH ROW EXECUTE FUNCTION public.rpt_item_cost_snapshot();

-- Earlier sales: the item's current recorded cost (labelled as backfilled).
UPDATE public.store_transaction_items i SET cost_snapshot = COALESCE(si.cost_basis, si.buy_price), cost_source = 'backfilled from current cost'
  FROM public.store_inventory si
 WHERE si.id = i.inventory_id AND i.direction = 'out' AND i.cost_snapshot IS NULL AND COALESCE(si.cost_basis, si.buy_price) IS NOT NULL;

CREATE OR REPLACE FUNCTION public.rpt_tax_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.tax_snapshot IS NULL AND NEW.location_id IS NOT NULL AND NEW.transaction_type NOT LIKE 'pawn\_%' THEN
    SELECT jsonb_strip_nulls(jsonb_build_object('province', l.province, 'rate_1', l.tax_rate_1, 'label_1', l.tax_label_1, 'rate_2', l.tax_rate_2, 'label_2', l.tax_label_2))
      INTO NEW.tax_snapshot FROM public.store_locations l WHERE l.id = NEW.location_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS store_transactions_tax_snapshot ON public.store_transactions;
CREATE TRIGGER store_transactions_tax_snapshot BEFORE INSERT ON public.store_transactions
  FOR EACH ROW EXECUTE FUNCTION public.rpt_tax_snapshot();

-- Who closed a register session.
CREATE OR REPLACE FUNCTION public.rpt_shift_closed_by()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' AND NEW.closed_by_employee IS NULL THEN
    NEW.closed_by_employee := public.current_store_employee_id(NEW.store_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS store_register_shifts_closed_by ON public.store_register_shifts;
CREATE TRIGGER store_register_shifts_closed_by BEFORE UPDATE ON public.store_register_shifts
  FOR EACH ROW EXECUTE FUNCTION public.rpt_shift_closed_by();

CREATE INDEX IF NOT EXISTS store_txn_store_status_time_idx ON public.store_transactions (store_id, status, created_at);
CREATE INDEX IF NOT EXISTS store_inv_movements_store_time_idx ON public.store_inventory_movements (store_id, created_at);
CREATE INDEX IF NOT EXISTS store_credit_ledger_store_idx ON public.store_credit_ledger (store_id, created_at);

CREATE TABLE IF NOT EXISTS public.report_exports (
  id          bigserial PRIMARY KEY,
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  report      text NOT NULL,
  format      text NOT NULL,
  period      text,
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  employee_id uuid,
  actor_user  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.report_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_exports FROM anon, authenticated;

-- ── Access ──────────────────────────────────────────────────────────────────
-- rep_basic (own sales figures), rep_store (store-wide sales), rep_employees, rep_customers,
-- rep_inventory, rep_registers, rep_tax, rep_pawn, rep_export.
-- Role defaults, each switchable per employee in store_employees.action_permissions.
CREATE OR REPLACE FUNCTION public.rpt_role_defaults(p_role text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_role, '')) IN ('owner', 'manager', 'store_manager') THEN
      '{"rep_basic":true,"rep_store":true,"rep_employees":true,"rep_customers":true,"rep_inventory":true,"rep_registers":true,"rep_tax":true,"rep_pawn":true,"rep_export":true}'::jsonb
    WHEN lower(COALESCE(p_role, '')) IN ('assistant_manager', 'supervisor') THEN
      '{"rep_basic":true,"rep_store":true,"rep_employees":true,"rep_customers":false,"rep_inventory":true,"rep_registers":true,"rep_tax":false,"rep_pawn":false,"rep_export":false}'::jsonb
    ELSE '{"rep_basic":true}'::jsonb END
$$;

CREATE OR REPLACE FUNCTION public.rpt_effective(p_role text, p_perm jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; out jsonb := '{}'::jsonb; v_def jsonb := public.rpt_role_defaults(p_role);
BEGIN
  FOREACH k IN ARRAY ARRAY['rep_basic', 'rep_store', 'rep_employees', 'rep_customers', 'rep_inventory', 'rep_registers', 'rep_tax', 'rep_pawn', 'rep_export'] LOOP
    out := out || jsonb_build_object(k, CASE WHEN COALESCE(p_perm, '{}'::jsonb) ? k THEN (p_perm ->> k) = 'true' ELSE COALESCE((v_def ->> k)::boolean, false) END);
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION public.rpt_access(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_boss boolean; v_emp uuid; v_role text; v_perm jsonb; out jsonb; k text;
BEGIN
  v_boss := EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND (s.owner_user_id = auth.uid() OR s.organization_id IN (SELECT public.user_org_ids())));
  IF p_store_id IS NULL OR (NOT v_boss AND p_store_id NOT IN (SELECT public.user_store_ids())) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  v_emp := public.current_store_employee_id(p_store_id);
  SELECT e.role, COALESCE(e.action_permissions, e.permissions, '{}'::jsonb) INTO v_role, v_perm FROM public.store_employees e WHERE e.id = v_emp;
  out := public.rpt_effective(v_role, v_perm);
  IF v_boss THEN
    FOREACH k IN ARRAY ARRAY['rep_basic', 'rep_store', 'rep_employees', 'rep_customers', 'rep_inventory', 'rep_registers', 'rep_tax', 'rep_pawn', 'rep_export'] LOOP
      out := out || jsonb_build_object(k, true);
    END LOOP;
  END IF;
  RETURN out || jsonb_build_object('boss', v_boss, 'employee_id', v_emp, 'time_zone', public.tx_store_tz(p_store_id),
    'pawn_enabled', EXISTS (SELECT 1 FROM public.store_features f WHERE f.store_id = p_store_id AND f.feature = 'pawns_loans' AND f.enabled) AND to_regclass('public.pawn_loans') IS NOT NULL,
    'locations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'name', l.location_name) ORDER BY l.created_at) FROM public.store_locations l WHERE l.store_id = p_store_id), '[]'::jsonb),
    'store_name', (SELECT store_name FROM public.stores WHERE id = p_store_id));
END $$;
REVOKE ALL ON FUNCTION public.rpt_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpt_access(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpt_require(p_store_id uuid, p_perm text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_access(p_store_id);
BEGIN
  IF NOT COALESCE((v ->> p_perm)::boolean, false) THEN RAISE EXCEPTION 'You don''t have access to this report (%).', replace(p_perm, 'rep_', ''); END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.rpt_require(uuid, text) FROM PUBLIC, anon, authenticated;

-- Store-local dates -> the period's instants.
CREATE OR REPLACE FUNCTION public.rpt_ts(p_store_id uuid, p_day date)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (p_day::timestamp AT TIME ZONE public.tx_store_tz(p_store_id))
$$;
REVOKE ALL ON FUNCTION public.rpt_ts(uuid, date) FROM PUBLIC, anon, authenticated;

-- ── The calculation layer: one row per completed transaction ─────────────────
-- kind: sale | refund | buy | pawn | other
CREATE OR REPLACE FUNCTION public.rpt_facts(p_store uuid, p_from timestamptz, p_to timestamptz, p_location uuid, p_employee uuid)
RETURNS TABLE (id uuid, number text, created_at timestamptz, local_ts timestamp, kind text, txn_type text, employee_id uuid, location_id uuid, customer_id uuid,
               is_member boolean, gross numeric, discount numeric, net numeric, tax numeric, total numeric, items numeric, cost numeric, cost_lines integer, missing_cost_lines integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.transaction_number, t.created_at, (t.created_at AT TIME ZONE public.tx_store_tz(p_store)),
         CASE WHEN t.transaction_type IN ('sale', 'exchange') THEN 'sale' WHEN t.transaction_type IN ('return', 'refund') THEN 'refund'
              WHEN t.transaction_type = 'trade_in' THEN 'buy' WHEN t.transaction_type LIKE 'pawn\_%' THEN 'pawn' ELSE 'other' END,
         t.transaction_type, t.employee_id, t.location_id, t.customer_id,
         EXISTS (SELECT 1 FROM public.store_customers c WHERE c.id = t.customer_id AND c.collectorshub_user_id IS NOT NULL),
         CASE WHEN t.transaction_type IN ('sale', 'exchange') THEN t.subtotal + t.discount_total ELSE 0 END,
         CASE WHEN t.transaction_type IN ('sale', 'exchange') THEN t.discount_total ELSE 0 END,
         CASE WHEN t.transaction_type IN ('sale', 'exchange', 'return', 'refund') THEN t.subtotal ELSE 0 END,
         CASE WHEN t.transaction_type IN ('sale', 'exchange', 'return', 'refund') THEN t.tax_total ELSE 0 END,
         t.total,
         CASE WHEN t.transaction_type IN ('sale', 'exchange') THEN COALESCE((SELECT sum(i.quantity) FROM public.store_transaction_items i WHERE i.transaction_id = t.id AND i.direction = 'out'), 0)
              WHEN t.transaction_type IN ('return', 'refund') THEN -COALESCE((SELECT sum(l.quantity) FROM public.store_refund_lines l WHERE l.return_transaction_id = t.id), 0)
              ELSE 0 END,
         CASE WHEN t.transaction_type IN ('sale', 'exchange') THEN COALESCE((SELECT sum(i.quantity * i.cost_snapshot) FROM public.store_transaction_items i WHERE i.transaction_id = t.id AND i.direction = 'out'), 0)
              WHEN t.transaction_type IN ('return', 'refund') THEN -COALESCE((SELECT sum(l.quantity * oi.cost_snapshot) FROM public.store_refund_lines l JOIN public.store_transaction_items oi ON oi.id = l.original_item_id
                                                                            WHERE l.return_transaction_id = t.id AND l.restocked), 0)
              ELSE 0 END,
         CASE WHEN t.transaction_type IN ('sale', 'exchange') THEN (SELECT count(*)::int FROM public.store_transaction_items i WHERE i.transaction_id = t.id AND i.direction = 'out') ELSE 0 END,
         CASE WHEN t.transaction_type IN ('sale', 'exchange') THEN (SELECT count(*)::int FROM public.store_transaction_items i WHERE i.transaction_id = t.id AND i.direction = 'out' AND i.cost_snapshot IS NULL) ELSE 0 END
    FROM public.store_transactions t
   WHERE t.store_id = p_store AND t.status = 'completed' AND t.created_at >= p_from AND t.created_at < p_to
     AND (p_location IS NULL OR t.location_id = p_location) AND (p_employee IS NULL OR t.employee_id = p_employee)
$$;
REVOKE ALL ON FUNCTION public.rpt_facts(uuid, timestamptz, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- The headline numbers for a set of facts.
CREATE OR REPLACE FUNCTION public.rpt_totals(p_store uuid, p_from timestamptz, p_to timestamptz, p_location uuid, p_employee uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'gross_sales', COALESCE(sum(gross), 0), 'discounts', COALESCE(sum(discount), 0),
    'refunds', COALESCE(-sum(net) FILTER (WHERE kind = 'refund'), 0),
    'net_sales', COALESCE(sum(net), 0),
    'tax_collected', COALESCE(sum(tax) FILTER (WHERE kind = 'sale'), 0), 'tax_refunded', COALESCE(-sum(tax) FILTER (WHERE kind = 'refund'), 0),
    'sales_count', count(*) FILTER (WHERE kind = 'sale'), 'refund_count', count(*) FILTER (WHERE kind = 'refund'),
    'buy_count', count(*) FILTER (WHERE kind = 'buy'), 'pawn_count', count(*) FILTER (WHERE kind = 'pawn'),
    'items_sold', COALESCE(sum(items), 0), 'cogs', COALESCE(sum(cost), 0),
    'gross_profit', COALESCE(sum(net), 0) - COALESCE(sum(cost), 0),
    'margin_pct', CASE WHEN COALESCE(sum(net), 0) > 0 THEN round((COALESCE(sum(net), 0) - COALESCE(sum(cost), 0)) / sum(net) * 100, 1) END,
    'avg_sale', CASE WHEN count(*) FILTER (WHERE kind = 'sale') > 0 THEN round(COALESCE(sum(net), 0) / count(*) FILTER (WHERE kind = 'sale'), 2) END,
    'cost_lines', COALESCE(sum(cost_lines), 0), 'missing_cost_lines', COALESCE(sum(missing_cost_lines), 0))
  FROM public.rpt_facts(p_store, p_from, p_to, p_location, p_employee)
$$;
REVOKE ALL ON FUNCTION public.rpt_totals(uuid, timestamptz, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Employees without store-wide access only see their own figures.
CREATE OR REPLACE FUNCTION public.rpt_scope_employee(v jsonb, p_employee uuid)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN COALESCE((v ->> 'rep_store')::boolean, false) THEN p_employee ELSE NULLIF(v ->> 'employee_id', '')::uuid END
$$;

-- ── Overview (the four cards + comparison) ──────────────────────────────────
-- p_compare: previous | year
CREATE OR REPLACE FUNCTION public.rpt_overview(p_store_id uuid, p_from date, p_to date, p_location uuid DEFAULT NULL, p_compare text DEFAULT 'previous')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_basic'); v_emp uuid; v_days integer := p_to - p_from + 1; v_cf date; v_ct date; cur jsonb; prev jsonb;
BEGIN
  v_emp := public.rpt_scope_employee(v, NULL);
  v_cf := CASE WHEN p_compare = 'year' THEN (p_from - interval '1 year')::date ELSE p_from - v_days END;
  v_ct := CASE WHEN p_compare = 'year' THEN (p_to - interval '1 year')::date ELSE p_from - 1 END;
  cur := public.rpt_totals(p_store_id, public.rpt_ts(p_store_id, p_from), public.rpt_ts(p_store_id, p_to + 1), p_location, v_emp);
  prev := public.rpt_totals(p_store_id, public.rpt_ts(p_store_id, v_cf), public.rpt_ts(p_store_id, v_ct + 1), p_location, v_emp);
  RETURN jsonb_build_object('access', v, 'current', cur,
    -- No comparison when the comparison period had no completed sales (nothing to compare with).
    'comparison', CASE WHEN (prev ->> 'sales_count')::int > 0 THEN prev END,
    'comparison_period', jsonb_build_object('from', v_cf, 'to', v_ct, 'kind', p_compare),
    'scope', CASE WHEN v_emp IS NOT NULL THEN 'own' ELSE 'store' END,
    'first_transaction', (SELECT min(created_at) FROM public.store_transactions WHERE store_id = p_store_id AND status = 'completed'));
END $$;

-- ── Sales & revenue ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpt_sales(p_store_id uuid, p_from date, p_to date, p_location uuid DEFAULT NULL, p_employee uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_basic'); v_emp uuid; f timestamptz := public.rpt_ts(p_store_id, p_from); t timestamptz := public.rpt_ts(p_store_id, p_to + 1); v_hourly boolean := p_to - p_from < 2;
BEGIN
  v_emp := public.rpt_scope_employee(v, p_employee);
  RETURN (
    WITH facts AS (SELECT * FROM public.rpt_facts(p_store_id, f, t, p_location, v_emp)),
    sales AS (SELECT * FROM facts WHERE kind IN ('sale', 'refund')),
    lines AS (
      SELECT i.*, x.local_ts, x.location_id, x.employee_id, it.category_id, it.brand_id,
             COALESCE(i.catalog_item_id::text, NULLIF(i.sku_snapshot, ''), i.name_snapshot) AS product_key
        FROM facts x JOIN public.store_transaction_items i ON i.transaction_id = x.id AND i.direction = 'out'
        LEFT JOIN public.items it ON it.item_id = i.catalog_item_id
       WHERE x.kind = 'sale'
    ),
    refunded AS (
      SELECT oi.id AS item_id, sum(l.quantity) AS qty, sum(l.amount) AS amount
        FROM public.store_refund_lines l JOIN public.store_transaction_items oi ON oi.id = l.original_item_id
       WHERE l.store_id = p_store_id AND l.original_transaction_id IN (SELECT id FROM facts WHERE kind = 'sale')
       GROUP BY oi.id
    ),
    products AS (
      SELECT l.product_key, max(l.name_snapshot) AS name, max(l.sku_snapshot) AS sku, max(l.catalog_item_id::text) AS catalog_item_id,
             sum(l.quantity) AS qty, sum(l.line_total) AS revenue, sum(l.quantity * l.cost_snapshot) AS cost, bool_or(l.cost_snapshot IS NULL) AS cost_missing,
             sum(l.discount_total) AS discount, count(*) FILTER (WHERE l.discount_total > 0) AS discounted, COALESCE(sum(r.qty), 0) AS refunded_qty
        FROM lines l LEFT JOIN refunded r ON r.item_id = l.id GROUP BY l.product_key
    )
    SELECT jsonb_build_object(
      'access', v, 'scope', CASE WHEN v_emp IS NOT NULL AND p_employee IS NULL THEN 'own' ELSE 'store' END,
      'totals', public.rpt_totals(p_store_id, f, t, p_location, v_emp),
      'granularity', CASE WHEN v_hourly THEN 'hour' ELSE 'day' END,
      'over_time', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', b, 'net', n, 'count', c) ORDER BY b) FROM (
          SELECT CASE WHEN v_hourly THEN to_char(date_trunc('hour', local_ts), 'YYYY-MM-DD HH24:00') ELSE to_char(local_ts::date, 'YYYY-MM-DD') END AS b,
                 sum(net) AS n, count(*) FILTER (WHERE kind = 'sale') AS c FROM sales GROUP BY 1) x), '[]'::jsonb),
      'by_category', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', label, 'net', n, 'qty', q) ORDER BY n DESC) FROM (
          SELECT COALESCE(c.name, CASE WHEN l.catalog_item_id IS NULL THEN 'Store items (not catalogued)' ELSE 'Uncategorised' END) AS label, sum(l.line_total) AS n, sum(l.quantity) AS q
            FROM lines l LEFT JOIN public.categories c ON c.category_id = l.category_id GROUP BY 1) x), '[]'::jsonb),
      'by_payment', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', method, 'amount', a) ORDER BY a DESC) FROM (
          SELECT p.method, sum(p.amount) AS a FROM sales s JOIN public.store_transaction_payments p ON p.transaction_id = s.id GROUP BY p.method) x), '[]'::jsonb),
      'by_location', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', COALESCE(l.location_name, 'Unknown location'), 'net', n, 'count', c) ORDER BY n DESC) FROM (
          SELECT location_id, sum(net) AS n, count(*) FILTER (WHERE kind = 'sale') AS c FROM sales GROUP BY location_id) x LEFT JOIN public.store_locations l ON l.id = x.location_id), '[]'::jsonb),
      'by_employee', CASE WHEN (v ->> 'rep_employees')::boolean THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', employee_id, 'label', COALESCE(public.tx_employee_name(employee_id), 'Not recorded'), 'net', n, 'count', c) ORDER BY n DESC) FROM (
          SELECT employee_id, sum(net) AS n, count(*) FILTER (WHERE kind = 'sale') AS c FROM sales GROUP BY employee_id) x), '[]'::jsonb) END,
      'by_hour', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', h, 'net', n, 'count', c) ORDER BY h) FROM (
          SELECT extract(hour FROM local_ts)::int AS h, sum(net) AS n, count(*) FILTER (WHERE kind = 'sale') AS c FROM sales GROUP BY 1) x), '[]'::jsonb),
      'by_weekday', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', d, 'net', n, 'count', c) ORDER BY d) FROM (
          SELECT extract(isodow FROM local_ts)::int AS d, sum(net) AS n, count(*) FILTER (WHERE kind = 'sale') AS c FROM sales GROUP BY 1) x), '[]'::jsonb),
      'best_sellers', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.qty DESC) FROM (SELECT * FROM products ORDER BY qty DESC LIMIT 10) p), '[]'::jsonb),
      'top_revenue', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.revenue DESC) FROM (SELECT * FROM products ORDER BY revenue DESC LIMIT 10) p), '[]'::jsonb),
      'top_profit', COALESCE((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('profit', p.revenue - p.cost) ORDER BY p.revenue - p.cost DESC) FROM (SELECT * FROM products WHERE NOT cost_missing ORDER BY revenue - cost DESC LIMIT 10) p), '[]'::jsonb),
      'most_discounted', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.discounted DESC, p.discount DESC) FROM (SELECT * FROM products WHERE discounted > 0 ORDER BY discounted DESC, discount DESC LIMIT 10) p), '[]'::jsonb),
      'highest_refund_rate', COALESCE((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('refund_rate', round(p.refunded_qty / NULLIF(p.qty, 0) * 100, 1)) ORDER BY p.refunded_qty / NULLIF(p.qty, 0) DESC) FROM (SELECT * FROM products WHERE refunded_qty > 0 ORDER BY refunded_qty / NULLIF(qty, 0) DESC LIMIT 10) p), '[]'::jsonb))
  );
END $$;

-- ── Inventory & profitability ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpt_inventory(p_store_id uuid, p_from date, p_to date, p_location uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_inventory'); f timestamptz := public.rpt_ts(p_store_id, p_from); t timestamptz := public.rpt_ts(p_store_id, p_to + 1); v_today date := (now() AT TIME ZONE public.tx_store_tz(p_store_id))::date;
BEGIN
  RETURN (
    WITH stock AS (
      SELECT si.id, si.catalog_item_id, si.name_snapshot, si.sku, si.condition, si.created_at, si.listed_for_sale,
             COALESCE(si.cost_basis, si.buy_price) AS unit_cost, COALESCE(si.in_store_price, si.sell_price) AS store_price, si.sell_price AS online_price,
             it.market_price, it.category_id, it.brand_id, sum(q.quantity - q.quantity_reserved) AS available, sum(q.quantity) AS on_hand
        FROM public.store_inventory si
        JOIN public.store_inventory_quantities q ON q.inventory_id = si.id AND (p_location IS NULL OR q.location_id = p_location)
        LEFT JOIN public.items it ON it.item_id = si.catalog_item_id
       WHERE si.store_id = p_store_id AND si.status = 'active'
       GROUP BY si.id, it.market_price, it.category_id, it.brand_id
    ),
    held AS (SELECT * FROM stock WHERE on_hand > 0),
    facts AS (SELECT * FROM public.rpt_facts(p_store_id, f, t, p_location, NULL)),
    lines AS (
      SELECT i.*, x.location_id, it.category_id, it.brand_id FROM facts x JOIN public.store_transaction_items i ON i.transaction_id = x.id AND i.direction = 'out'
        LEFT JOIN public.items it ON it.item_id = i.catalog_item_id WHERE x.kind = 'sale'
    ),
    last_sold AS (
      SELECT m.inventory_id, max(m.created_at) AS at FROM public.store_inventory_movements m WHERE m.store_id = p_store_id AND m.movement_type = 'sale' GROUP BY m.inventory_id
    )
    SELECT jsonb_build_object(
      'access', v,
      'stats', (SELECT jsonb_build_object(
          'units', COALESCE(sum(on_hand), 0), 'available_units', COALESCE(sum(available), 0), 'stock_records', count(*),
          'unique_products', count(DISTINCT COALESCE(catalog_item_id::text, id::text)),
          'cost_value', COALESCE(sum(on_hand * unit_cost), 0), 'units_missing_cost', COALESCE(sum(on_hand) FILTER (WHERE unit_cost IS NULL), 0),
          'retail_value', COALESCE(sum(on_hand * store_price), 0), 'online_value', COALESCE(sum(on_hand * online_price) FILTER (WHERE listed_for_sale), 0),
          'market_value', COALESCE(sum(on_hand * market_price), 0), 'units_with_market_value', COALESCE(sum(on_hand) FILTER (WHERE market_price IS NOT NULL), 0),
          'potential_margin', COALESCE(sum(on_hand * (store_price - unit_cost)) FILTER (WHERE store_price > 0 AND unit_cost IS NOT NULL), 0),
          'low_stock', count(*) FILTER (WHERE available BETWEEN 1 AND 2), 'unpriced', count(*) FILTER (WHERE COALESCE(store_price, 0) <= 0))
        FROM held),
      'out_of_stock', (SELECT count(*) FROM stock WHERE on_hand <= 0),
      'ageing', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', b, 'units', u, 'cost', c) ORDER BY o) FROM (
          SELECT CASE WHEN a <= 30 THEN '0–30 days' WHEN a <= 60 THEN '31–60 days' WHEN a <= 90 THEN '61–90 days' WHEN a <= 180 THEN '91–180 days' ELSE 'Over 180 days' END AS b,
                 CASE WHEN a <= 30 THEN 1 WHEN a <= 60 THEN 2 WHEN a <= 90 THEN 3 WHEN a <= 180 THEN 4 ELSE 5 END AS o, sum(on_hand) AS u, sum(on_hand * unit_cost) AS c
            FROM (SELECT *, v_today - (created_at AT TIME ZONE public.tx_store_tz(p_store_id))::date AS a FROM held) h GROUP BY 1, 2) x), '[]'::jsonb),
      'period', (SELECT jsonb_build_object('revenue', COALESCE(sum(line_total), 0), 'cost', COALESCE(sum(quantity * cost_snapshot), 0), 'missing_cost_lines', count(*) FILTER (WHERE cost_snapshot IS NULL)) FROM lines),
      'profit_by_category', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', label, 'revenue', r, 'cost', c, 'profit', r - c, 'margin_pct', CASE WHEN r > 0 THEN round((r - c) / r * 100, 1) END, 'incomplete', m) ORDER BY r - c DESC) FROM (
          SELECT COALESCE(cat.name, CASE WHEN l.catalog_item_id IS NULL THEN 'Store items (not catalogued)' ELSE 'Uncategorised' END) AS label,
                 sum(l.line_total) AS r, COALESCE(sum(l.quantity * l.cost_snapshot), 0) AS c, bool_or(l.cost_snapshot IS NULL) AS m
            FROM lines l LEFT JOIN public.categories cat ON cat.category_id = l.category_id GROUP BY 1) x), '[]'::jsonb),
      'profit_by_brand', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', label, 'revenue', r, 'cost', c, 'profit', r - c, 'margin_pct', CASE WHEN r > 0 THEN round((r - c) / r * 100, 1) END, 'incomplete', m) ORDER BY r - c DESC) FROM (
          SELECT COALESCE(b.name, 'No brand recorded') AS label, sum(l.line_total) AS r, COALESCE(sum(l.quantity * l.cost_snapshot), 0) AS c, bool_or(l.cost_snapshot IS NULL) AS m
            FROM lines l LEFT JOIN public.brands b ON b.brand_id = l.brand_id GROUP BY 1) x), '[]'::jsonb),
      'profit_by_location', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', COALESCE(loc.location_name, 'Unknown location'), 'revenue', r, 'cost', c, 'profit', r - c, 'margin_pct', CASE WHEN r > 0 THEN round((r - c) / r * 100, 1) END, 'incomplete', m) ORDER BY r - c DESC) FROM (
          SELECT location_id, sum(line_total) AS r, COALESCE(sum(quantity * cost_snapshot), 0) AS c, bool_or(cost_snapshot IS NULL) AS m FROM lines GROUP BY location_id) x
          LEFT JOIN public.store_locations loc ON loc.id = x.location_id), '[]'::jsonb),
      'slow_moving', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', COALESCE(h.name_snapshot, h.sku), 'sku', h.sku, 'units', h.on_hand, 'cost', h.on_hand * h.unit_cost,
                   'days_held', v_today - (h.created_at AT TIME ZONE public.tx_store_tz(p_store_id))::date, 'last_sold', ls.at) ORDER BY h.on_hand * COALESCE(h.unit_cost, 0) DESC)
                   FROM (SELECT * FROM held h WHERE h.created_at < now() - interval '90 days'
                           AND NOT EXISTS (SELECT 1 FROM last_sold s WHERE s.inventory_id = h.id AND s.at > now() - interval '90 days')
                         ORDER BY h.on_hand * COALESCE(h.unit_cost, 0) DESC LIMIT 25) h LEFT JOIN last_sold ls ON ls.inventory_id = h.id), '[]'::jsonb),
      'movement', COALESCE((SELECT jsonb_agg(jsonb_build_object('type', ty, 'units', u, 'records', n) ORDER BY ty) FROM (
          SELECT CASE WHEN m.reason LIKE 'Forfeited pawn collateral%' THEN 'pawn_forfeiture' ELSE m.movement_type END AS ty, sum(m.quantity_change) AS u, count(*) AS n
            FROM public.store_inventory_movements m
           WHERE m.store_id = p_store_id AND m.created_at >= f AND m.created_at < t AND (p_location IS NULL OR m.location_id = p_location) GROUP BY 1) x), '[]'::jsonb))
  );
END $$;

-- ── Customers (members who shop here; no global membership data) ────────────
CREATE OR REPLACE FUNCTION public.rpt_customers(p_store_id uuid, p_from date, p_to date, p_location uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_customers'); f timestamptz := public.rpt_ts(p_store_id, p_from); t timestamptz := public.rpt_ts(p_store_id, p_to + 1);
        v_wish boolean := to_regprocedure('public.customers_wishlist_status(uuid,uuid)') IS NOT NULL AND to_regprocedure('public.customers_available_stock(uuid,uuid)') IS NOT NULL;
        v_result jsonb; v_wishlist jsonb;
BEGIN
  WITH facts AS (SELECT * FROM public.rpt_facts(p_store_id, f, t, p_location, NULL) WHERE kind IN ('sale', 'refund')),
  member_sales AS (
    SELECT x.*, c.collectorshub_user_id AS uid FROM facts x JOIN public.store_customers c ON c.id = x.customer_id AND c.collectorshub_user_id IS NOT NULL
  ),
  per_member AS (
    SELECT uid, count(*) FILTER (WHERE kind = 'sale') AS sales, sum(net) AS spend, sum(items) AS items,
           EXISTS (SELECT 1 FROM public.store_transactions t2 JOIN public.store_customers c2 ON c2.id = t2.customer_id
                    WHERE t2.store_id = p_store_id AND t2.status = 'completed' AND t2.transaction_type IN ('sale', 'exchange') AND t2.created_at < f AND c2.collectorshub_user_id = m.uid) AS before
      FROM member_sales m GROUP BY uid HAVING count(*) FILTER (WHERE kind = 'sale') > 0
  )
  SELECT jsonb_build_object(
    'access', v,
    'members', (SELECT jsonb_build_object('purchasing', count(*), 'new', count(*) FILTER (WHERE NOT before), 'returning', count(*) FILTER (WHERE before),
                  'repeat_rate_pct', CASE WHEN count(*) > 0 THEN round(count(*) FILTER (WHERE sales >= 2)::numeric / count(*) * 100, 1) END,
                  'avg_spend', CASE WHEN count(*) > 0 THEN round(sum(spend) / count(*), 2) END,
                  'frequency', CASE WHEN count(*) > 0 THEN round(sum(sales)::numeric / count(*), 2) END,
                  'transactions', COALESCE(sum(sales), 0), 'net', COALESCE(sum(spend), 0),
                  'avg_basket_items', CASE WHEN sum(sales) > 0 THEN round(sum(items) / sum(sales), 2) END) FROM per_member),
    'non_members', (SELECT jsonb_build_object('transactions', count(*) FILTER (WHERE kind = 'sale'), 'net', COALESCE(sum(net), 0)) FROM facts WHERE NOT is_member),
    'all_members_ever', (SELECT count(DISTINCT c.collectorshub_user_id) FROM public.store_customers c JOIN public.store_transactions t2 ON t2.customer_id = c.id AND t2.status = 'completed'
                          WHERE c.store_id = p_store_id AND c.collectorshub_user_id IS NOT NULL),
    'spending_over_time', COALESCE((SELECT jsonb_agg(jsonb_build_object('bucket', b, 'members', m, 'others', o) ORDER BY b) FROM (
        SELECT to_char(date_trunc('month', local_ts), 'YYYY-MM') AS b, COALESCE(sum(net) FILTER (WHERE is_member), 0) AS m, COALESCE(sum(net) FILTER (WHERE NOT is_member), 0) AS o FROM facts GROUP BY 1) x), '[]'::jsonb),
    'member_categories', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', label, 'net', n, 'qty', q) ORDER BY n DESC) FROM (
        SELECT COALESCE(cat.name, CASE WHEN i.catalog_item_id IS NULL THEN 'Store items (not catalogued)' ELSE 'Uncategorised' END) AS label, sum(i.line_total) AS n, sum(i.quantity) AS q
          FROM member_sales m JOIN public.store_transaction_items i ON i.transaction_id = m.id AND i.direction = 'out'
          LEFT JOIN public.items it ON it.item_id = i.catalog_item_id LEFT JOIN public.categories cat ON cat.category_id = it.category_id
         WHERE m.kind = 'sale' GROUP BY 1 ORDER BY 2 DESC LIMIT 12) x), '[]'::jsonb),
    'wishlist_available', v_wish)
  INTO v_result;

  -- Wishlist demand: only members who shop here and share their wishlist with this store.
  IF v_wish THEN
    EXECUTE $q$
      WITH sharing AS (
        SELECT DISTINCT c.collectorshub_user_id AS uid FROM public.store_customers c
          JOIN public.store_transactions t ON t.customer_id = c.id AND t.status = 'completed' AND t.store_id = $1
         WHERE c.store_id = $1 AND c.collectorshub_user_id IS NOT NULL AND c.status <> 'merged'
           AND public.customers_wishlist_status($1, c.collectorshub_user_id) = 'granted'
      ),
      wanted AS (SELECT w.catalog_item_id, count(DISTINCT w.user_id) AS wishers FROM public.wishlist_items w JOIN sharing s ON s.uid = w.user_id GROUP BY w.catalog_item_id),
      avail AS (SELECT * FROM public.customers_available_stock($1, $2)),
      demand AS (
        SELECT w.catalog_item_id, w.wishers, it.name, it.card_number, cat.name AS category, COALESCE(a.available, 0) AS available, a.price_min, a.price_max
          FROM wanted w JOIN public.items it ON it.item_id = w.catalog_item_id LEFT JOIN public.categories cat ON cat.category_id = it.category_id
          LEFT JOIN avail a ON a.catalog_item_id = w.catalog_item_id
      )
      SELECT jsonb_build_object(
        'sharing_members', (SELECT count(*) FROM sharing),
        'members_with_matches', (SELECT count(DISTINCT w.user_id) FROM public.wishlist_items w JOIN sharing s ON s.uid = w.user_id JOIN avail a ON a.catalog_item_id = w.catalog_item_id),
        'unique_items', (SELECT count(*) FROM demand), 'items_in_store', (SELECT count(*) FROM demand WHERE available > 0), 'items_not_in_store', (SELECT count(*) FROM demand WHERE available = 0),
        'top_categories', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', COALESCE(category, 'Uncategorised'), 'wishers', s, 'items', n) ORDER BY s DESC) FROM (
            SELECT category, sum(wishers) AS s, count(*) AS n FROM demand GROUP BY category ORDER BY 2 DESC LIMIT 10) x), '[]'::jsonb),
        'demand', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.wishers DESC, d.name) FROM (SELECT * FROM demand ORDER BY wishers DESC, name LIMIT 100) d), '[]'::jsonb))
    $q$ INTO v_wishlist USING p_store_id, p_location;
    v_result := v_result || jsonb_build_object('wishlist', v_wishlist);
  END IF;
  RETURN v_result;
END $$;

-- ── Employees ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpt_employees(p_store_id uuid, p_from date, p_to date, p_location uuid DEFAULT NULL, p_role text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_employees'); f timestamptz := public.rpt_ts(p_store_id, p_from); t timestamptz := public.rpt_ts(p_store_id, p_to + 1);
BEGIN
  RETURN jsonb_build_object('access', v,
    'roles', COALESCE((SELECT jsonb_agg(DISTINCT e.role) FROM public.store_employees e WHERE e.store_id = p_store_id AND e.role IS NOT NULL), '[]'::jsonb),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.employee_id, 'name', COALESCE(public.tx_employee_name(x.employee_id), 'Not recorded'), 'role', e.role,
              'transactions', x.txns, 'sales', x.sales, 'net', x.net, 'items', x.items, 'avg_sale', CASE WHEN x.sales > 0 THEN round(x.net_sales / x.sales, 2) END,
              'refunds', x.refunds, 'refund_amount', x.refund_amount, 'discounts', x.discounts, 'buys', x.buys,
              'pawn', CASE WHEN (v ->> 'rep_pawn')::boolean THEN x.pawn END) ORDER BY x.net DESC)
       FROM (SELECT employee_id, count(*) AS txns, count(*) FILTER (WHERE kind = 'sale') AS sales, COALESCE(sum(net), 0) AS net, COALESCE(sum(net) FILTER (WHERE kind = 'sale'), 0) AS net_sales,
                    COALESCE(sum(items), 0) AS items, count(*) FILTER (WHERE kind = 'refund') AS refunds, COALESCE(-sum(net) FILTER (WHERE kind = 'refund'), 0) AS refund_amount,
                    COALESCE(sum(discount), 0) AS discounts, count(*) FILTER (WHERE kind = 'buy') AS buys, count(*) FILTER (WHERE kind = 'pawn') AS pawn
               FROM public.rpt_facts(p_store_id, f, t, p_location, NULL) GROUP BY employee_id) x
       LEFT JOIN public.store_employees e ON e.id = x.employee_id
      WHERE p_role IS NULL OR p_role = '' OR e.role = p_role), '[]'::jsonb),
    'note', 'Each transaction records the one employee who completed it; its full value is credited to them.');
END $$;

-- ── Registers and cash ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpt_registers(p_store_id uuid, p_from date, p_to date, p_location uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_registers'); f timestamptz := public.rpt_ts(p_store_id, p_from); t timestamptz := public.rpt_ts(p_store_id, p_to + 1);
BEGIN
  RETURN jsonb_build_object('access', v, 'sessions', COALESCE((
    SELECT jsonb_agg(row ORDER BY (row ->> 'opened_at') DESC) FROM (
      SELECT jsonb_build_object('id', sh.id, 'register', sh.register_name, 'location', l.location_name, 'status', sh.status, 'opened_at', sh.opened_at, 'closed_at', sh.closed_at,
               'opened_by', public.tx_employee_name(sh.employee_id), 'closed_by', public.tx_employee_name(sh.closed_by_employee), 'opening', sh.opening_cash,
               'cash', c.cash, 'orders_cash', o.cash,
               'expected', sh.opening_cash + COALESCE((c.cash ->> 'total')::numeric, 0) + COALESCE(o.cash, 0),
               'counted', sh.counted_cash, 'over_short', sh.over_short, 'notes', sh.notes) AS row
        FROM public.store_register_shifts sh
        LEFT JOIN public.store_locations l ON l.id = sh.location_id
        LEFT JOIN LATERAL (
          SELECT jsonb_build_object(
                   'sales', COALESCE(sum(p.amount) FILTER (WHERE tx.transaction_type IN ('sale', 'exchange')), 0),
                   'refunds', COALESCE(sum(p.amount) FILTER (WHERE tx.transaction_type IN ('return', 'refund')), 0),
                   'buy_outs', COALESCE(sum(p.amount) FILTER (WHERE tx.transaction_type = 'trade_in'), 0),
                   'pawn_disbursements', COALESCE(sum(p.amount) FILTER (WHERE tx.transaction_type = 'pawn_loan'), 0),
                   'pawn_repayments', COALESCE(sum(p.amount) FILTER (WHERE tx.transaction_type IN ('pawn_payment', 'pawn_redemption', 'pawn_renewal')), 0),
                   'adjustments', COALESCE(sum(p.amount) FILTER (WHERE tx.transaction_type IN ('adjustment', 'pawn_reversal')), 0),
                   'total', COALESCE(sum(p.amount), 0)) AS cash
            FROM public.store_transactions tx JOIN public.store_transaction_payments p ON p.transaction_id = tx.id AND p.method = 'cash'
           WHERE tx.store_id = sh.store_id AND tx.location_id = sh.location_id AND tx.status = 'completed' AND tx.created_at >= sh.opened_at AND (sh.closed_at IS NULL OR tx.created_at <= sh.closed_at)
        ) c ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(op.amount), 0) AS cash FROM public.store_order_payments op JOIN public.store_orders od ON od.id = op.order_id
           WHERE od.store_id = sh.store_id AND COALESCE(op.location_id, od.location_id) = sh.location_id AND op.payment_method = 'cash'
             AND op.created_at >= sh.opened_at AND (sh.closed_at IS NULL OR op.created_at <= sh.closed_at)
        ) o ON true
       WHERE sh.store_id = p_store_id AND sh.opened_at >= f AND sh.opened_at < t AND (p_location IS NULL OR sh.location_id = p_location)
    ) s), '[]'::jsonb),
    'note', 'Expected cash = opening float + every cash payment in and out during the session. Card, debit and store credit never count toward the drawer.');
END $$;

-- ── Tax ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpt_tax(p_store_id uuid, p_from date, p_to date, p_location uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_tax'); f timestamptz := public.rpt_ts(p_store_id, p_from); t timestamptz := public.rpt_ts(p_store_id, p_to + 1);
BEGIN
  RETURN (
    WITH tx AS (
      SELECT x.*, s.tax_snapshot FROM public.rpt_facts(p_store_id, f, t, p_location, NULL) x JOIN public.store_transactions s ON s.id = x.id WHERE x.kind IN ('sale', 'refund')
    ),
    parts AS (
      SELECT tx.kind, COALESCE(tx.tax_snapshot ->> 'province', '') AS province,
             CASE WHEN tx.tax_snapshot IS NULL OR COALESCE((tx.tax_snapshot ->> 'rate_1')::numeric, 0) + COALESCE((tx.tax_snapshot ->> 'rate_2')::numeric, 0) = 0
                  THEN 'Breakdown not recorded' ELSE COALESCE(tx.tax_snapshot ->> 'label_1', 'Tax 1') END AS label,
             CASE WHEN tx.tax_snapshot IS NULL OR COALESCE((tx.tax_snapshot ->> 'rate_1')::numeric, 0) + COALESCE((tx.tax_snapshot ->> 'rate_2')::numeric, 0) = 0
                  THEN tx.tax ELSE round(tx.tax * (tx.tax_snapshot ->> 'rate_1')::numeric / ((tx.tax_snapshot ->> 'rate_1')::numeric + COALESCE((tx.tax_snapshot ->> 'rate_2')::numeric, 0)), 2) END AS amount
        FROM tx
      UNION ALL
      SELECT tx.kind, COALESCE(tx.tax_snapshot ->> 'province', ''), COALESCE(tx.tax_snapshot ->> 'label_2', 'Tax 2'),
             tx.tax - round(tx.tax * (tx.tax_snapshot ->> 'rate_1')::numeric / ((tx.tax_snapshot ->> 'rate_1')::numeric + (tx.tax_snapshot ->> 'rate_2')::numeric), 2)
        FROM tx WHERE COALESCE((tx.tax_snapshot ->> 'rate_2')::numeric, 0) > 0 AND COALESCE((tx.tax_snapshot ->> 'rate_1')::numeric, 0) > 0
    )
    SELECT jsonb_build_object('access', v,
      'summary', (SELECT jsonb_build_object(
          'taxable_sales', COALESCE(sum(net) FILTER (WHERE kind = 'sale' AND tax <> 0), 0),
          'untaxed_sales', COALESCE(sum(net) FILTER (WHERE kind = 'sale' AND tax = 0), 0),
          'tax_collected', COALESCE(sum(tax) FILTER (WHERE kind = 'sale'), 0), 'tax_refunded', COALESCE(-sum(tax) FILTER (WHERE kind = 'refund'), 0),
          'net_tax', COALESCE(sum(tax), 0), 'refunded_sales', COALESCE(-sum(net) FILTER (WHERE kind = 'refund'), 0),
          'transactions', count(*), 'with_breakdown', count(*) FILTER (WHERE tax_snapshot IS NOT NULL)) FROM tx),
      'by_tax', COALESCE((SELECT jsonb_agg(jsonb_build_object('province', province, 'label', label, 'collected', c, 'refunded', r, 'net', c - r) ORDER BY province, label) FROM (
          SELECT province, label, COALESCE(sum(amount) FILTER (WHERE kind = 'sale'), 0) AS c, COALESCE(-sum(amount) FILTER (WHERE kind = 'refund'), 0) AS r FROM parts GROUP BY 1, 2) x), '[]'::jsonb),
      'jurisdictions', COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('location', l.location_name, 'province', l.province, 'label_1', l.tax_label_1, 'rate_1', l.tax_rate_1, 'label_2', l.tax_label_2, 'rate_2', l.tax_rate_2))
                                   FROM public.store_locations l WHERE l.store_id = p_store_id AND (p_location IS NULL OR l.id = p_location)), '[]'::jsonb),
      'note', 'Uses the tax recorded on each transaction. Sales with no tax recorded can be exempt or zero-rated; the POS doesn''t record which, so they''re shown together. This is a summary for your bookkeeping, not a tax return.')
  );
END $$;

-- ── Accounting ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpt_accounting(p_store_id uuid, p_from date, p_to date, p_location uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_tax'); f timestamptz := public.rpt_ts(p_store_id, p_from); t timestamptz := public.rpt_ts(p_store_id, p_to + 1);
BEGIN
  RETURN jsonb_build_object('access', v,
    'totals', public.rpt_totals(p_store_id, f, t, p_location, NULL),
    'payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', method, 'kind', kind, 'amount', a, 'count', n) ORDER BY method, kind) FROM (
        SELECT p.method, x.kind, sum(p.amount) AS a, count(*) AS n FROM public.rpt_facts(p_store_id, f, t, p_location, NULL) x
          JOIN public.store_transaction_payments p ON p.transaction_id = x.id GROUP BY 1, 2) y), '[]'::jsonb),
    'buys', (SELECT jsonb_build_object('count', count(*), 'paid_out', COALESCE(-sum(total), 0)) FROM public.rpt_facts(p_store_id, f, t, p_location, NULL) WHERE kind = 'buy'),
    'store_credit', jsonb_build_object(
      'liability_now', (SELECT COALESCE(sum(amount), 0) FROM public.store_credit_ledger WHERE store_id = p_store_id),
      'liability_at_end', (SELECT COALESCE(sum(amount), 0) FROM public.store_credit_ledger WHERE store_id = p_store_id AND created_at < t),
      'issued', (SELECT COALESCE(sum(amount), 0) FROM public.store_credit_ledger WHERE store_id = p_store_id AND amount > 0 AND created_at >= f AND created_at < t),
      'redeemed', (SELECT COALESCE(-sum(amount), 0) FROM public.store_credit_ledger WHERE store_id = p_store_id AND amount < 0 AND created_at >= f AND created_at < t)),
    'inventory_cost_value', (SELECT COALESCE(sum(q.quantity * COALESCE(si.cost_basis, si.buy_price)), 0) FROM public.store_inventory si
                               JOIN public.store_inventory_quantities q ON q.inventory_id = si.id AND (p_location IS NULL OR q.location_id = p_location)
                              WHERE si.store_id = p_store_id AND si.status = 'active' AND q.quantity > 0),
    'pawn', CASE WHEN (v ->> 'rep_pawn')::boolean AND to_regclass('public.pawn_loans') IS NOT NULL THEN public.rpt_pawn_totals(p_store_id, f, t) END);
END $$;

-- ── Pawn & loans ────────────────────────────────────────────────────────────
-- (Defined only when pawn_loans.sql is installed; otherwise reports show the tab as unavailable.)
CREATE OR REPLACE FUNCTION public.rpt_pawn_totals(p_store_id uuid, f timestamptz, t timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF to_regclass('public.pawn_loans') IS NULL THEN RETURN NULL; END IF;
  EXECUTE $q$
    WITH loans AS (SELECT * FROM public.pawn_loans WHERE store_id = $1 AND NOT is_test),
         led AS (SELECT g.* FROM public.pawn_ledger g JOIN loans l ON l.id = g.loan_id WHERE g.created_at >= $2 AND g.created_at < $3)
    SELECT jsonb_build_object(
      'active_loans', (SELECT count(*) FROM loans WHERE status = 'active'),
      'principal_issued', (SELECT COALESCE(-sum(amount), 0) FROM led WHERE entry_type = 'disbursement'),
      'principal_outstanding', (SELECT COALESCE(sum(principal_outstanding), 0) FROM loans WHERE status IN ('active', 'forfeiture_review')),
      'repayments', (SELECT COALESCE(sum(amount), 0) FROM led WHERE entry_type IN ('payment', 'renewal')),
      'principal_repaid', (SELECT COALESCE(-sum(principal_part), 0) FROM led WHERE entry_type = 'payment'),
      'interest_and_fees', (SELECT COALESCE(-sum(charges_part), 0) FROM led WHERE entry_type IN ('payment', 'renewal')),
      'redeemed', (SELECT count(*) FROM loans WHERE status = 'redeemed' AND closed_at >= $2 AND closed_at < $3),
      'overdue', (SELECT count(*) FROM loans WHERE status = 'active' AND due_date < (now() AT TIME ZONE public.tx_store_tz($1))::date),
      'forfeiture_review', (SELECT count(*) FROM loans WHERE status = 'forfeiture_review'),
      'lawfully_acquired', (SELECT count(*) FROM public.pawn_collateral k JOIN loans l ON l.id = k.loan_id WHERE k.status = 'lawfully_acquired'))
  $q$ INTO v_result USING p_store_id, f, t;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.rpt_pawn_totals(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpt_pawn(p_store_id uuid, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_pawn'); f timestamptz := public.rpt_ts(p_store_id, p_from); t timestamptz := public.rpt_ts(p_store_id, p_to + 1); v_detail jsonb;
BEGIN
  IF NOT (v ->> 'pawn_enabled')::boolean THEN RAISE EXCEPTION 'Pawn & Loans isn''t enabled for this store.'; END IF;
  EXECUTE $q$
    WITH loans AS (SELECT * FROM public.pawn_loans WHERE store_id = $1 AND NOT is_test),
         held AS (SELECT k.* FROM public.pawn_collateral k JOIN loans l ON l.id = k.loan_id)
    SELECT jsonb_build_object(
      'activity', COALESCE((SELECT jsonb_object_agg(action, n) FROM (SELECT e.action, count(*) AS n FROM public.pawn_events e JOIN loans l ON l.id = e.loan_id
                              WHERE e.created_at >= $2 AND e.created_at < $3 GROUP BY e.action) x), '{}'::jsonb),
      'collateral', (SELECT jsonb_build_object(
          'held_items', count(*) FILTER (WHERE status IN ('in_custody', 'forfeiture_review', 'reserved_for_redemption')),
          'held_estimated_value', COALESCE(sum(estimated_value * quantity) FILTER (WHERE status IN ('in_custody', 'forfeiture_review', 'reserved_for_redemption')), 0),
          'held_loan_value', COALESCE(sum(allocated_loan_value) FILTER (WHERE status IN ('in_custody', 'forfeiture_review', 'reserved_for_redemption')), 0),
          'released', count(*) FILTER (WHERE status = 'released'), 'under_review', count(*) FILTER (WHERE status = 'forfeiture_review'),
          'lawfully_acquired', count(*) FILTER (WHERE status = 'lawfully_acquired'), 'transferred', count(*) FILTER (WHERE status = 'transferred_to_inventory')) FROM held),
      'by_category', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', COALESCE(category, 'Not set'), 'items', n, 'value', v) ORDER BY v DESC) FROM (
          SELECT category, count(*) AS n, COALESCE(sum(estimated_value * quantity), 0) AS v FROM held WHERE status IN ('in_custody', 'forfeiture_review', 'reserved_for_redemption') GROUP BY 1) x), '[]'::jsonb),
      'by_storage', COALESCE((SELECT jsonb_agg(jsonb_build_object('label', label, 'items', n) ORDER BY label) FROM (
          SELECT COALESCE(NULLIF(concat_ws(' / ', NULLIF(storage ->> 'room', ''), NULLIF(storage ->> 'cabinet', '')), ''), 'Not set') AS label, count(*) AS n
            FROM held WHERE status IN ('in_custody', 'forfeiture_review', 'reserved_for_redemption') GROUP BY 1) x), '[]'::jsonb),
      'overdue', COALESCE((SELECT jsonb_agg(jsonb_build_object('loan_number', loan_number, 'due_date', due_date, 'principal_outstanding', principal_outstanding) ORDER BY due_date)
                            FROM loans WHERE status = 'active' AND due_date < (now() AT TIME ZONE public.tx_store_tz($1))::date), '[]'::jsonb))
  $q$ INTO v_detail USING p_store_id, f, t;
  RETURN jsonb_build_object('access', v, 'totals', public.rpt_pawn_totals(p_store_id, f, t)) || v_detail;
END $$;

-- ── Detail rows for exports (same facts) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpt_transactions_detail(p_store_id uuid, p_from date, p_to date, p_location uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_export'); v_emp uuid := public.rpt_scope_employee(v, NULL);
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'number', x.number, 'date', to_char(x.local_ts, 'YYYY-MM-DD HH24:MI'), 'type', x.txn_type, 'kind', x.kind,
      'employee', public.tx_employee_name(x.employee_id), 'location', (SELECT location_name FROM public.store_locations WHERE id = x.location_id),
      'customer_type', CASE WHEN x.customer_id IS NULL THEN 'Guest' WHEN x.is_member THEN 'Member' ELSE 'Store customer' END,
      'gross', x.gross, 'discount', x.discount, 'net', x.net, 'tax', x.tax, 'total', x.total, 'items', x.items, 'cost', x.cost, 'missing_cost_lines', x.missing_cost_lines,
      'tax_detail', s.tax_snapshot,
      'payments', (SELECT string_agg(p.method || ' ' || p.amount, '; ' ORDER BY p.created_at) FROM public.store_transaction_payments p WHERE p.transaction_id = x.id)) ORDER BY x.created_at)
    FROM public.rpt_facts(p_store_id, public.rpt_ts(p_store_id, p_from), public.rpt_ts(p_store_id, p_to + 1), p_location, v_emp) x
    JOIN public.store_transactions s ON s.id = x.id), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.rpt_log_export(p_store_id uuid, p_report text, p_format text, p_period text, p_filters jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb := public.rpt_require(p_store_id, 'rep_export');
BEGIN
  INSERT INTO public.report_exports (store_id, report, format, period, filters, employee_id, actor_user)
  VALUES (p_store_id, p_report, p_format, p_period, COALESCE(p_filters, '{}'::jsonb), public.current_store_employee_id(p_store_id), auth.uid());
END $$;

-- ── Report access per employee (organization) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.rpt_staff(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND (s.owner_user_id = auth.uid() OR s.organization_id IN (SELECT public.user_org_ids()))) THEN
    RAISE EXCEPTION 'Report access is managed by the organization.';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'name', public.tx_employee_name(e.id), 'role', e.role,
            'permissions', public.rpt_effective(e.role, COALESCE(e.action_permissions, e.permissions, '{}'::jsonb)), 'defaults', public.rpt_role_defaults(e.role)) ORDER BY public.tx_employee_name(e.id))
    FROM public.store_employees e WHERE e.store_id = p_store_id AND e.status IN ('active', 'invited')), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.rpt_set_staff_access(p_store_id uuid, p_employee_id uuid, p_permissions jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k text; v_clean jsonb := '{}'::jsonb; v_old jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND (s.owner_user_id = auth.uid() OR s.organization_id IN (SELECT public.user_org_ids()))) THEN
    RAISE EXCEPTION 'Report access is managed by the organization.';
  END IF;
  FOREACH k IN ARRAY ARRAY['rep_basic', 'rep_store', 'rep_employees', 'rep_customers', 'rep_inventory', 'rep_registers', 'rep_tax', 'rep_pawn', 'rep_export'] LOOP
    v_clean := v_clean || jsonb_build_object(k, COALESCE((p_permissions ->> k)::boolean, false));
  END LOOP;
  SELECT COALESCE(action_permissions, permissions, '{}'::jsonb) INTO v_old FROM public.store_employees WHERE id = p_employee_id AND store_id = p_store_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found.'; END IF;
  UPDATE public.store_employees SET action_permissions = COALESCE(v_old, '{}'::jsonb) || v_clean WHERE id = p_employee_id;
END $$;

GRANT EXECUTE ON FUNCTION public.rpt_overview(uuid, date, date, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_sales(uuid, date, date, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_inventory(uuid, date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_customers(uuid, date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_employees(uuid, date, date, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_registers(uuid, date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_tax(uuid, date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_accounting(uuid, date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_pawn(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_transactions_detail(uuid, date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_log_export(uuid, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpt_set_staff_access(uuid, uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
