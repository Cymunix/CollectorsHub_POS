-- Targeted repair for the pre-existing NORDVIK test organisation. Run after
-- store_management.sql and store_applications.sql as the migration owner.
-- Restores only Draft ORG-0001 when ALL of its existing stores are active test
-- stores. It never reopens a suspension or approves a production retailer.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- This is trusted maintenance DDL, not an API privilege. ALTER TABLE holds a
-- table lock until COMMIT, so no concurrent client can skip the guard. PostgreSQL
-- rolls back both the data repair and trigger state if any statement fails.
ALTER TABLE public.organizations DISABLE TRIGGER nordvik_org_guard;
DO $$
DECLARE o record;
BEGIN
  FOR o IN SELECT * FROM public.organizations x
    WHERE x.org_code = 'ORG-0001' AND x.onboarding_status = 'draft'
      AND EXISTS (SELECT 1 FROM public.stores s WHERE s.organization_id = x.id)
      AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.organization_id = x.id
        AND (NOT COALESCE(s.is_test_store,false) OR s.status IS DISTINCT FROM 'active'))
    FOR UPDATE
  LOOP
    UPDATE public.organizations SET onboarding_status = 'active',updated_at = now() WHERE id = o.id;
    INSERT INTO public.org_audit_logs(organisation_id,actor_user_id,action,before_data,after_data)
    VALUES(o.id,NULL,'existing_test_organization_restored',to_jsonb(o),
      jsonb_build_object('onboarding_status','active','org_code',o.org_code,'database_role',session_user,
        'reason','Restore the pre-existing NORDVIK test organisation after the onboarding default incorrectly classified it as Draft. No production approval, owner invitation or tax review is implied.'));
  END LOOP;
END $$;
ALTER TABLE public.organizations ENABLE TRIGGER nordvik_org_guard;

-- Environment metadata comes from the existing store flags; no duplicate test
-- organisation directory and no new auth exemption for ordinary test retailers.
CREATE OR REPLACE FUNCTION public.nordvik_test_organization_ids()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.nordvik_is_admin() THEN RAISE EXCEPTION 'NORDVIK administrator required' USING ERRCODE='42501'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(o.id) FROM public.organizations o
    WHERE EXISTS (SELECT 1 FROM public.stores s WHERE s.organization_id=o.id)
      AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.organization_id=o.id AND NOT COALESCE(s.is_test_store,false))),'[]');
END $$;
REVOKE ALL ON FUNCTION public.nordvik_test_organization_ids() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.nordvik_test_organization_ids() TO authenticated;

-- Retailers must not be able to turn production stores into test environments.
CREATE OR REPLACE FUNCTION public.nordvik_provision_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Store and location records must be retained'; END IF;
  IF TG_OP = 'INSERT' AND NOT public.nordvik_is_admin() THEN RAISE EXCEPTION 'New stores and locations require NORDVIK approval'; END IF;
  IF TG_OP = 'UPDATE' AND NOT public.nordvik_is_admin() THEN
    IF TG_TABLE_NAME = 'stores' THEN
      IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.status IS DISTINCT FROM OLD.status OR NEW.is_test_store IS DISTINCT FROM OLD.is_test_store THEN
        RAISE EXCEPTION 'Only NORDVIK administrators may change store ownership, status or test designation';
      END IF;
    ELSIF TG_TABLE_NAME = 'store_locations' THEN
      IF NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.store_owner_id IS DISTINCT FROM OLD.store_owner_id
        OR NEW.tax_rate_1 IS DISTINCT FROM OLD.tax_rate_1 OR NEW.tax_rate_2 IS DISTINCT FROM OLD.tax_rate_2
        OR NEW.tax_label_1 IS DISTINCT FROM OLD.tax_label_1 OR NEW.tax_label_2 IS DISTINCT FROM OLD.tax_label_2
        OR NEW.nordvik_tax_reviewed_at IS DISTINCT FROM OLD.nordvik_tax_reviewed_at
        OR NEW.nordvik_tax_reviewed_by IS DISTINCT FROM OLD.nordvik_tax_reviewed_by THEN
        RAISE EXCEPTION 'Location ownership and tax settings require NORDVIK review';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
