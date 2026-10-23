-- NORDVIK retailer provisioning. Run after the existing organisation/enterprise,
-- subscription, and store_features migrations. No inventory/customer/history DML.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'draft'
    CHECK (onboarding_status IN ('draft','pending_verification','approved','active','suspended')),
  ADD COLUMN IF NOT EXISTS business_details jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS designated_owner_email text,
  ADD COLUMN IF NOT EXISTS owner_invited_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_linked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_plan public.subscription_tier,
  ADD COLUMN IF NOT EXISTS subscription_billing_cycle text NOT NULL DEFAULT 'monthly'
    CHECK (subscription_billing_cycle IN ('monthly','annual')),
  ADD COLUMN IF NOT EXISTS gst_hst_status text NOT NULL DEFAULT 'not_registered'
    CHECK (gst_hst_status IN ('registered','not_registered','not_required')),
  ADD COLUMN IF NOT EXISTS gst_hst_account_number text,
  ADD COLUMN IF NOT EXISTS tax_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS tax_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid;
ALTER TABLE public.store_locations
  ADD COLUMN IF NOT EXISTS nordvik_tax_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS nordvik_tax_reviewed_by uuid;

-- Preserve the existing platform_admin role model. Only trusted server-side
-- provisioning may grant it; never trust user_metadata or an employee role.
CREATE OR REPLACE FUNCTION public.nordvik_is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND subscription_tier::text = 'platform_admin')
$$;
CREATE OR REPLACE FUNCTION public.nordvik_profile_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.subscription_tier::text = 'platform_admin' AND COALESCE(auth.role(),'') <> 'service_role'
      THEN RAISE EXCEPTION 'Platform privileges require trusted server provisioning'; END IF;
  ELSIF NEW.subscription_tier IS DISTINCT FROM OLD.subscription_tier
    AND (NEW.subscription_tier::text = 'platform_admin' OR OLD.subscription_tier::text = 'platform_admin')
    AND NOT public.nordvik_is_admin() AND COALESCE(auth.role(),'') <> 'service_role' THEN
    RAISE EXCEPTION 'Platform privileges cannot be self-assigned';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Account identity is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nordvik_profile_guard ON public.profiles;
CREATE TRIGGER nordvik_profile_guard BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.nordvik_profile_guard();

CREATE OR REPLACE FUNCTION public.nordvik_org_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Suspend organisations instead of deleting records'; END IF;
  IF NOT public.nordvik_is_admin() THEN
    IF TG_OP = 'INSERT' THEN RAISE EXCEPTION 'Only NORDVIK administrators create organisations'; END IF;
    IF (to_jsonb(NEW) - ARRAY['name','logo_url','banner_url','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['name','logo_url','banner_url','updated_at'])
       OR OLD.owner_user_id IS DISTINCT FROM auth.uid() OR OLD.onboarding_status <> 'active' THEN
      RAISE EXCEPTION 'Only NORDVIK administrators manage onboarding and activation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.onboarding_status <> 'draft' OR NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL) THEN
    RAISE EXCEPTION 'New organisations must start as Draft';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.onboarding_status IS DISTINCT FROM OLD.onboarding_status THEN
    IF NOT ((OLD.onboarding_status = 'draft' AND NEW.onboarding_status = 'pending_verification')
      OR (OLD.onboarding_status = 'pending_verification' AND NEW.onboarding_status IN ('draft','approved'))
      OR (OLD.onboarding_status = 'approved' AND NEW.onboarding_status = 'active')
      OR (OLD.onboarding_status = 'active' AND NEW.onboarding_status = 'suspended')
      OR (OLD.onboarding_status = 'suspended' AND NEW.onboarding_status = 'pending_verification')) THEN
      RAISE EXCEPTION 'Invalid onboarding status transition';
    END IF;
    IF NEW.onboarding_status = 'approved' THEN NEW.approved_at := now(); NEW.approved_by := auth.uid(); END IF;
    IF NEW.onboarding_status = 'pending_verification' THEN NEW.approved_at := NULL; NEW.approved_by := NULL; END IF;
    IF NEW.onboarding_status = 'active' AND (OLD.approved_at IS NULL OR OLD.approved_by IS NULL
      OR NOT NEW.owner_linked OR NEW.tax_reviewed_at IS NULL OR NEW.subscription_plan IS NULL) THEN
      RAISE EXCEPTION 'Activation requires explicit approval, an invited owner, subscription and tax review';
    END IF;
  END IF;
  IF NEW.gst_hst_status = 'registered' AND COALESCE(NEW.gst_hst_account_number,'') !~ '^[0-9]{9}RT[0-9]{4}$' THEN
    RAISE EXCEPTION 'A registered business requires a GST/HST account number (123456789RT0001)';
  END IF;
  IF NEW.gst_hst_status <> 'registered' AND NEW.gst_hst_account_number IS NOT NULL THEN RAISE EXCEPTION 'Unregistered businesses must not have a GST/HST account number'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nordvik_org_guard ON public.organizations;
CREATE TRIGGER nordvik_org_guard BEFORE INSERT OR UPDATE OR DELETE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.nordvik_org_guard();

-- Defence in depth: triggers also run within legacy SECURITY DEFINER RPCs.
CREATE OR REPLACE FUNCTION public.nordvik_provision_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Store and location records must be retained'; END IF;
  IF TG_OP = 'INSERT' AND NOT public.nordvik_is_admin() THEN RAISE EXCEPTION 'New stores and locations require NORDVIK approval'; END IF;
  IF TG_OP = 'UPDATE' AND NOT public.nordvik_is_admin() THEN
    IF TG_TABLE_NAME = 'stores' THEN
      IF (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.status IS DISTINCT FROM OLD.status
       OR (to_jsonb(NEW)->'is_test_store') IS DISTINCT FROM (to_jsonb(OLD)->'is_test_store')) THEN
      RAISE EXCEPTION 'Only NORDVIK administrators may change store ownership or status';
      END IF;
    ELSIF TG_TABLE_NAME = 'store_locations' THEN
      IF (NEW.store_id IS DISTINCT FROM OLD.store_id
      OR NEW.store_owner_id IS DISTINCT FROM OLD.store_owner_id
      OR NEW.tax_rate_1 IS DISTINCT FROM OLD.tax_rate_1 OR NEW.tax_rate_2 IS DISTINCT FROM OLD.tax_rate_2
      OR NEW.tax_label_1 IS DISTINCT FROM OLD.tax_label_1 OR NEW.tax_label_2 IS DISTINCT FROM OLD.tax_label_2
      OR NEW.nordvik_tax_reviewed_at IS DISTINCT FROM OLD.nordvik_tax_reviewed_at
      OR NEW.nordvik_tax_reviewed_by IS DISTINCT FROM OLD.nordvik_tax_reviewed_by) THEN
      RAISE EXCEPTION 'Location ownership and tax settings require NORDVIK review';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['stores','store_locations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS nordvik_provision_guard ON public.%I',t);
    EXECUTE format('CREATE TRIGGER nordvik_provision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.nordvik_provision_guard()',t);
  END LOOP;
END $$;

-- Exact store_id employee joins avoid access to another store owned by the
-- same account. Legacy standalone stores remain available to their members.
CREATE OR REPLACE FUNCTION public.user_org_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT id FROM public.organizations WHERE owner_user_id = auth.uid() AND onboarding_status = 'active'
$$;
CREATE OR REPLACE FUNCTION public.verify_organization_login(p_org_code text)
RETURNS TABLE(org_id uuid,org_code text,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id,o.org_code,o.name FROM public.organizations o
  WHERE o.org_code = upper(btrim(p_org_code)) AND o.owner_user_id = auth.uid() AND o.onboarding_status = 'active' LIMIT 1
$$;
CREATE OR REPLACE FUNCTION public.user_store_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.id FROM public.stores s LEFT JOIN public.organizations o ON o.id = s.organization_id
  WHERE s.status = 'active' AND (s.organization_id IS NULL OR o.onboarding_status = 'active')
    AND (s.owner_user_id = auth.uid() OR o.owner_user_id = auth.uid()
      OR EXISTS (SELECT 1 FROM public.store_employees e WHERE e.store_id = s.id AND e.status = 'active'
        AND (e.auth_user_id = auth.uid() OR e.employee_user_id = auth.uid())))
$$;

CREATE OR REPLACE FUNCTION public.nordvik_store_is_active(p_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.stores s LEFT JOIN public.organizations o ON o.id = s.organization_id
    WHERE s.id = p_store_id AND s.status = 'active' AND (s.organization_id IS NULL OR o.onboarding_status = 'active'))
$$;
CREATE OR REPLACE FUNCTION public.nordvik_can_manage_store(p_store_id uuid,p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.nordvik_store_is_active(p_store_id) AND EXISTS (
    SELECT 1 FROM public.stores s LEFT JOIN public.organizations o ON o.id = s.organization_id
    WHERE s.id = p_store_id AND (s.owner_user_id = auth.uid() OR o.owner_user_id = auth.uid()
      OR EXISTS (SELECT 1 FROM public.store_employees e WHERE e.store_id = s.id AND e.status = 'active'
        AND (e.auth_user_id = auth.uid() OR e.employee_user_id = auth.uid())
        AND (lower(e.role) IN ('owner','manager') OR
          COALESCE(to_jsonb(e)->'action_permissions',to_jsonb(e)->'permissions','{}')->>p_permission = 'true'))))
$$;

-- Block suspended/unapproved tenants at the write boundary, including service
-- endpoints and legacy RPCs that check owner_user_id directly. No record DML.
CREATE OR REPLACE FUNCTION public.nordvik_tenant_write_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data jsonb; prior_data jsonb; sid uuid; oid uuid;
BEGIN
  IF public.nordvik_is_admin() THEN IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD); ELSE row_data := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    prior_data := to_jsonb(OLD);
    IF (row_data->>'store_id') IS DISTINCT FROM (prior_data->>'store_id')
      OR (row_data->>'store_owner_id') IS DISTINCT FROM (prior_data->>'store_owner_id')
      OR (row_data->>'organization_id') IS DISTINCT FROM (prior_data->>'organization_id')
      OR (row_data->>'organisation_id') IS DISTINCT FROM (prior_data->>'organisation_id') THEN
      RAISE EXCEPTION 'Tenant ownership cannot be changed';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'stores' THEN sid := (row_data->>'id')::uuid;
  ELSE sid := (row_data->>'store_id')::uuid; END IF;
  oid := COALESCE(row_data->>'organization_id',row_data->>'organisation_id')::uuid;
  IF sid IS NOT NULL AND NOT public.nordvik_store_is_active(sid) THEN RAISE EXCEPTION 'Retailer account is not active'; END IF;
  IF auth.uid() IS NOT NULL AND COALESCE(auth.role(),'') <> 'service_role' THEN
    IF TG_TABLE_NAME = 'store_settings' AND NOT public.nordvik_can_manage_store(sid,'settings_management') THEN
      RAISE EXCEPTION 'Store settings require retailer administrative permission';
    END IF;
    IF TG_TABLE_NAME IN ('store_employees','store_employee_locations') AND NOT public.nordvik_can_manage_store(sid,'employee_management') THEN
      IF TG_TABLE_NAME <> 'store_employees' OR TG_OP <> 'UPDATE' OR
        COALESCE(prior_data->>'auth_user_id',prior_data->>'employee_user_id') IS DISTINCT FROM auth.uid()::text OR
        (row_data - ARRAY['photo_path','pin_hash','updated_at']) IS DISTINCT FROM (prior_data - ARRAY['photo_path','pin_hash','updated_at']) THEN
        RAISE EXCEPTION 'Employee management requires retailer administrative permission';
      END IF;
    END IF;
  END IF;
  IF oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = oid AND onboarding_status = 'active') THEN
    RAISE EXCEPTION 'Retailer organisation is not active'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name IN ('store_id','organization_id','organisation_id')
    AND c.table_name NOT IN ('organizations','org_audit_logs') AND c.table_name NOT LIKE 'identity_%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS nordvik_tenant_write_guard ON public.%I',t.table_name);
    EXECUTE format('CREATE TRIGGER nordvik_tenant_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.nordvik_tenant_write_guard()',t.table_name);
  END LOOP;
END $$;

-- Use the existing administrative audit history, with immutable snapshots.
CREATE OR REPLACE FUNCTION public.nordvik_audit_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE oid uuid; sid uuid; lid uuid; before_row jsonb; after_row jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_row := to_jsonb(OLD); END IF;
  after_row := to_jsonb(NEW);
  IF before_row IS NOT DISTINCT FROM after_row THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'organizations' THEN oid := NEW.id;
  ELSE
    sid := (after_row->>'store_id')::uuid;
    IF TG_TABLE_NAME = 'stores' THEN sid := NEW.id; END IF;
    IF TG_TABLE_NAME = 'store_locations' THEN lid := NEW.id; END IF;
    SELECT organization_id INTO oid FROM public.stores WHERE id = sid;
  END IF;
  IF oid IS NOT NULL THEN
    INSERT INTO public.org_audit_logs(organisation_id,actor_user_id,action,store_id,location_id,before_data,after_data)
    VALUES (oid,auth.uid(),TG_TABLE_NAME || '_' || lower(TG_OP),sid,lid,before_row,after_row);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.nordvik_audit_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'Administrative audit history is append-only'; END $$;
DROP TRIGGER IF EXISTS nordvik_audit_immutable ON public.org_audit_logs;
CREATE TRIGGER nordvik_audit_immutable BEFORE UPDATE OR DELETE ON public.org_audit_logs FOR EACH ROW EXECUTE FUNCTION public.nordvik_audit_immutable();
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.org_audit_logs FROM anon, authenticated;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','stores','store_locations','store_settings','store_features'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS nordvik_audit_change ON public.%I',t);
    EXECUTE format('CREATE TRIGGER nordvik_audit_change AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.nordvik_audit_change()',t);
  END LOOP;
END $$;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nordvik_org_boundary ON public.organizations;
CREATE POLICY nordvik_org_boundary ON public.organizations AS RESTRICTIVE TO authenticated
  USING (public.nordvik_is_admin() OR (owner_user_id = auth.uid() AND onboarding_status = 'active'))
  WITH CHECK (public.nordvik_is_admin() OR (owner_user_id = auth.uid() AND onboarding_status = 'active'));
DROP POLICY IF EXISTS nordvik_admin_orgs ON public.organizations;
CREATE POLICY nordvik_admin_orgs ON public.organizations TO authenticated USING (public.nordvik_is_admin()) WITH CHECK (public.nordvik_is_admin());
DROP POLICY IF EXISTS nordvik_admin_audit ON public.org_audit_logs;
CREATE POLICY nordvik_admin_audit ON public.org_audit_logs FOR SELECT TO authenticated USING (public.nordvik_is_admin());
-- Existing permissive tenant policies are retained; restrictive policies add an
-- exact membership boundary instead of accidentally broadening access.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['stores','store_locations','store_settings','store_employees','store_features',
    'store_inventory','store_inventory_quantities','store_inventory_movements','store_transactions','store_transaction_lines','store_customers'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS nordvik_store_boundary ON public.%I',t);
    EXECUTE format('CREATE POLICY nordvik_store_boundary ON public.%I AS RESTRICTIVE TO authenticated USING (public.nordvik_is_admin() OR %I IN (SELECT public.user_store_ids())) WITH CHECK (public.nordvik_is_admin() OR %I IN (SELECT public.user_store_ids()))',t,CASE WHEN t='stores' THEN 'id' ELSE 'store_id' END,CASE WHEN t='stores' THEN 'id' ELSE 'store_id' END);
  END LOOP;
END $$;

-- Single, transactional entry point. Caller identity always comes from JWT.
CREATE OR REPLACE FUNCTION public.nordvik_manage_store(p_action text, p_org_id uuid DEFAULT NULL, p_data jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.organizations; sid uuid; lid uuid; result jsonb; plan public.subscription_tier; owner_id uuid; rate numeric;
BEGIN
  IF NOT public.nordvik_is_admin() THEN RAISE EXCEPTION 'NORDVIK administrator required' USING ERRCODE = '42501'; END IF;
  IF p_action = 'list' THEN
    RETURN COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM public.organizations x),'[]');
  END IF;
  IF p_action IN ('create','configure') THEN
    IF EXISTS (SELECT 1 FROM unnest(ARRAY['legal_name','registration_number','contact_name','contact_email','owner_name','owner_email']) k WHERE NULLIF(btrim(p_data->>k),'') IS NULL) THEN
      RAISE EXCEPTION 'Business, registration, contact, owner and location details are required'; END IF;
    IF p_action = 'create' AND EXISTS (SELECT 1 FROM unnest(ARRAY['store_name','address','city','province','postal']) k WHERE NULLIF(btrim(p_data->>k),'') IS NULL) THEN RAISE EXCEPTION 'Store and primary location details required'; END IF;
    IF p_data->>'owner_email' !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR p_data->>'contact_email' !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RAISE EXCEPTION 'Valid contact and owner emails are required'; END IF;
    plan := (p_data->>'subscription_plan')::public.subscription_tier;
    IF plan::text NOT IN ('store','store_pro') OR plan IS NULL OR NOT EXISTS (SELECT 1 FROM public.subscription_plans WHERE tier = plan) THEN RAISE EXCEPTION 'Select an existing retailer subscription plan'; END IF;
    IF p_action = 'configure' THEN
      SELECT * INTO o FROM public.organizations WHERE id = p_org_id FOR UPDATE;
      IF NOT FOUND OR o.onboarding_status <> 'draft' THEN RAISE EXCEPTION 'Only Draft organisations can be configured'; END IF;
      IF o.designated_owner_email IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = o.owner_user_id AND lower(email) = lower(btrim(p_data->>'owner_email'))) THEN
        RAISE EXCEPTION 'Existing organisation must retain its current account owner'; END IF;
      UPDATE public.organizations SET name = p_data->>'legal_name',business_details = p_data - ARRAY['gst_hst_account_number'],
        designated_owner_email = lower(btrim(p_data->>'owner_email')),subscription_plan = plan,
        subscription_billing_cycle = COALESCE(p_data->>'billing_cycle','monthly'),gst_hst_status = COALESCE(p_data->>'gst_hst_status','not_registered'),
        gst_hst_account_number = NULLIF(upper(regexp_replace(p_data->>'gst_hst_account_number','\s','','g')),''),tax_reviewed_at = NULL,tax_reviewed_by = NULL
        WHERE id = o.id RETURNING * INTO o;
      INSERT INTO public.store_features(store_id,feature,enabled,updated_by)
      SELECT s.id,f,COALESCE((p_data->'modules'->>f)::boolean,false),auth.uid() FROM public.stores s CROSS JOIN unnest(ARRAY['pawns_loans','collector_scanning']) f WHERE s.organization_id = o.id
      ON CONFLICT (store_id,feature) DO UPDATE SET enabled = EXCLUDED.enabled,updated_by = EXCLUDED.updated_by;
      UPDATE public.store_locations SET nordvik_tax_reviewed_at = NULL,nordvik_tax_reviewed_by = NULL
        WHERE store_id IN (SELECT id FROM public.stores WHERE organization_id = o.id);
      RETURN to_jsonb(o);
    END IF;
    INSERT INTO public.organizations(name,owner_user_id,business_details,designated_owner_email,subscription_plan,subscription_billing_cycle,gst_hst_status,gst_hst_account_number)
    VALUES (p_data->>'legal_name',auth.uid(),p_data - ARRAY['gst_hst_account_number'],lower(btrim(p_data->>'owner_email')),plan,COALESCE(p_data->>'billing_cycle','monthly'),COALESCE(p_data->>'gst_hst_status','not_registered'),NULLIF(upper(regexp_replace(p_data->>'gst_hst_account_number','\s','','g')),'')) RETURNING * INTO o;
    INSERT INTO public.stores(store_name,owner_user_id,organization_id,status)
    VALUES (p_data->>'store_name',o.owner_user_id,o.id,'setup') RETURNING id INTO sid;
    INSERT INTO public.store_locations(store_id,store_owner_id,location_name,street_address,city,province,postal_code,country,status,tax_rate_1,tax_rate_2,currency)
    VALUES (sid,o.owner_user_id,COALESCE(NULLIF(p_data->>'location_name',''),'Primary Location'),p_data->>'address',p_data->>'city',p_data->>'province',p_data->>'postal',COALESCE(p_data->>'country','Canada'),'active',0,0,'CAD');
    INSERT INTO public.store_settings(store_id,store_owner_id,store_name,store_public_profile_enabled,inventory_publicly_visible,enable_marketplace_listings)
    VALUES (sid,o.owner_user_id,p_data->>'store_name',false,false,false)
    ON CONFLICT (store_id) DO UPDATE SET store_public_profile_enabled = false,inventory_publicly_visible = false,enable_marketplace_listings = false;
    INSERT INTO public.store_features(store_id,feature,enabled,updated_by)
    SELECT sid,f,COALESCE((p_data->'modules'->>f)::boolean,false),auth.uid() FROM unnest(ARRAY['pawns_loans','collector_scanning']) f;
    RETURN to_jsonb(o);
  END IF;
  SELECT * INTO o FROM public.organizations WHERE id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organisation not found'; END IF;
  IF p_action = 'details' THEN
    RETURN jsonb_build_object('organization',to_jsonb(o),'stores',COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.stores s WHERE s.organization_id = o.id),'[]'),
      'locations',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM public.store_locations l JOIN public.stores s ON s.id = l.store_id WHERE s.organization_id = o.id),'[]'),
      'audit',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC,a.id) FROM public.org_audit_logs a WHERE a.organisation_id = o.id),'[]'));
  ELSIF p_action = 'status' THEN
    IF NULLIF(btrim(p_data->>'reason'),'') IS NULL THEN RAISE EXCEPTION 'An administrative decision note is required'; END IF;
    IF p_data->>'status' = 'approved' AND (o.designated_owner_email IS NULL OR o.subscription_plan IS NULL OR COALESCE(o.business_details->>'registration_number','') = '') THEN RAISE EXCEPTION 'Complete business and subscription details before approval'; END IF;
    UPDATE public.organizations SET onboarding_status = p_data->>'status',updated_at = now() WHERE id = o.id;
    IF p_data->>'status' = 'active' THEN
      UPDATE public.stores SET status = 'active' WHERE organization_id = o.id AND status IN ('setup','suspended');
      UPDATE public.profiles SET subscription_tier = o.subscription_plan,billing_cycle = o.subscription_billing_cycle,
        subscription_started_at = COALESCE(subscription_started_at,now()) WHERE id = o.owner_user_id AND subscription_tier::text <> 'platform_admin';
    END IF;
    INSERT INTO public.org_audit_logs(organisation_id,actor_user_id,action,after_data) VALUES (o.id,auth.uid(),'administrative_decision',p_data);
  ELSIF p_action = 'tax_review' THEN
    rate := (p_data->>'rate')::numeric;
    lid := (p_data->>'location_id')::uuid;
    IF lid IS NULL OR NOT EXISTS (SELECT 1 FROM public.store_locations l JOIN public.stores s ON s.id = l.store_id WHERE l.id = lid AND s.organization_id = o.id) THEN RAISE EXCEPTION 'Select a location belonging to this organisation'; END IF;
    IF rate IS NULL OR rate < 0 OR rate > 1 OR (o.gst_hst_status <> 'registered' AND rate <> 0) OR NULLIF(btrim(p_data->>'reason'),'') IS NULL THEN RAISE EXCEPTION 'Review note and a valid tax rate are required; unregistered businesses require zero GST/HST'; END IF;
    IF rate > 0 AND NULLIF(btrim(p_data->>'label'),'') IS NULL THEN RAISE EXCEPTION 'Tax label required'; END IF;
    UPDATE public.store_locations SET tax_rate_1 = rate,tax_label_1 = NULLIF(p_data->>'label',''),
      nordvik_tax_reviewed_at = now(),nordvik_tax_reviewed_by = auth.uid() WHERE id = lid;
    UPDATE public.organizations SET tax_reviewed_at = now(),tax_reviewed_by = auth.uid() WHERE id = o.id
      AND NOT EXISTS (SELECT 1 FROM public.store_locations l JOIN public.stores s ON s.id = l.store_id WHERE s.organization_id = o.id AND l.nordvik_tax_reviewed_at IS NULL);
    INSERT INTO public.org_audit_logs(organisation_id,actor_user_id,action,after_data) VALUES (o.id,auth.uid(),'tax_review',p_data);
  ELSIF p_action = 'invite_requested' THEN
    IF o.onboarding_status NOT IN ('approved','active') THEN RAISE EXCEPTION 'Approve the organisation before inviting its owner'; END IF;
    INSERT INTO public.org_audit_logs(organisation_id,actor_user_id,action,after_data) VALUES(o.id,auth.uid(),'owner_invite_requested',jsonb_build_object('email',o.designated_owner_email));
    RETURN jsonb_build_object('email',o.designated_owner_email,'linked',o.owner_linked);
  ELSIF p_action = 'invite_failed' THEN
    INSERT INTO public.org_audit_logs(organisation_id,actor_user_id,action,after_data) VALUES(o.id,auth.uid(),'owner_invite_failed',jsonb_build_object('error',p_data->>'error'));
  ELSIF p_action = 'link_owner' THEN
    IF o.onboarding_status NOT IN ('approved','active') THEN RAISE EXCEPTION 'Owner invitation requires approval'; END IF;
    owner_id := (p_data->>'user_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM auth.users u JOIN public.profiles p ON p.id = u.id WHERE u.id = owner_id AND lower(u.email) = o.designated_owner_email AND p.subscription_tier::text <> 'platform_admin') THEN RAISE EXCEPTION 'Invited account must match the designated owner email and be a retailer'; END IF;
    UPDATE public.organizations SET owner_user_id = owner_id,owner_linked = true,owner_invited_at = now() WHERE id = o.id;
    UPDATE public.stores SET owner_user_id = owner_id WHERE organization_id = o.id;
    UPDATE public.store_locations SET store_owner_id = owner_id WHERE store_id IN (SELECT id FROM public.stores WHERE organization_id = o.id);
    UPDATE public.store_settings SET store_owner_id = owner_id WHERE store_id IN (SELECT id FROM public.stores WHERE organization_id = o.id);
  ELSIF p_action = 'add_location' THEN
    sid := (p_data->>'store_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id = sid AND organization_id = o.id) THEN RAISE EXCEPTION 'Store does not belong to this organisation'; END IF;
    IF NULLIF(btrim(p_data->>'reason'),'') IS NULL OR NULLIF(btrim(p_data->>'name'),'') IS NULL OR NULLIF(btrim(p_data->>'address'),'') IS NULL THEN RAISE EXCEPTION 'Location name, address and approval note required'; END IF;
    INSERT INTO public.store_locations(store_id,store_owner_id,location_name,street_address,city,province,postal_code,country,status,tax_rate_1,tax_rate_2)
    VALUES(sid,o.owner_user_id,p_data->>'name',p_data->>'address',p_data->>'city',p_data->>'province',p_data->>'postal',COALESCE(p_data->>'country','Canada'),'active',0,0) RETURNING id INTO lid;
    UPDATE public.organizations SET tax_reviewed_at = NULL,tax_reviewed_by = NULL WHERE id = o.id;
    INSERT INTO public.org_audit_logs(organisation_id,actor_user_id,action,store_id,location_id,after_data) VALUES(o.id,auth.uid(),'location_approved',sid,lid,p_data);
  ELSE RAISE EXCEPTION 'Unknown administrative action'; END IF;
  RETURN jsonb_build_object('ok',true);
END $$;

-- Explicit ACLs: PostgreSQL grants function execution to PUBLIC by default.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('nordvik_is_admin','nordvik_profile_guard','nordvik_org_guard',
      'nordvik_provision_guard','nordvik_store_is_active','nordvik_can_manage_store','nordvik_tenant_write_guard',
      'nordvik_audit_change','nordvik_audit_immutable','nordvik_manage_store') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.sig);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.nordvik_is_admin(),public.nordvik_store_is_active(uuid),public.nordvik_manage_store(text,uuid,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.user_store_ids(),public.user_org_ids() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.user_store_ids(),public.user_org_ids() TO authenticated;
REVOKE ALL ON FUNCTION public.verify_organization_login(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.verify_organization_login(text),public.nordvik_store_is_active(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_organization_login(text) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
