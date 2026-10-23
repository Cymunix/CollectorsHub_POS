-- Apply after store_management.sql and the existing organization_applications
-- migration. Public applications never create or activate an organisation.
BEGIN;
ALTER TABLE public.organization_applications
  ADD COLUMN IF NOT EXISTS business_details jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS application_source text NOT NULL DEFAULT 'legacy';
UPDATE public.subscription_plans SET is_public = false WHERE tier::text = 'store_pro';

CREATE OR REPLACE FUNCTION public.nordvik_application_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.nordvik_is_admin() THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Only NORDVIK administrators may review applications'; END IF;
    IF NEW.applicant_user_id IS DISTINCT FROM auth.uid() OR NEW.status <> 'pending' OR NEW.organization_id IS NOT NULL
      OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_notes IS NOT NULL THEN
      RAISE EXCEPTION 'Applicants may only submit their own pending application'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Application history must be retained'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nordvik_application_guard ON public.organization_applications;
CREATE TRIGGER nordvik_application_guard BEFORE INSERT OR UPDATE OR DELETE ON public.organization_applications FOR EACH ROW EXECUTE FUNCTION public.nordvik_application_guard();
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.organization_applications FROM anon,authenticated;
ALTER TABLE public.organization_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nordvik_application_read ON public.organization_applications;
CREATE POLICY nordvik_application_read ON public.organization_applications AS RESTRICTIVE FOR SELECT TO authenticated
  USING (applicant_user_id = auth.uid() OR public.nordvik_is_admin());
-- Reviewers can open private supporting documents through short-lived URLs.
DO $$ BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS nordvik_application_documents ON storage.objects';
    EXECUTE 'CREATE POLICY nordvik_application_documents ON storage.objects FOR SELECT TO authenticated USING (bucket_id = ''support-documents'' AND public.nordvik_is_admin())';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.submit_store_application(p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE payload jsonb := '{}'; k text; aid uuid; document_path text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to apply for Store' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text) > 65536 THEN RAISE EXCEPTION 'Invalid application'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  IF EXISTS (SELECT 1 FROM public.organization_applications WHERE applicant_user_id=auth.uid() AND status='pending') THEN RAISE EXCEPTION 'You already have an application pending NORDVIK review'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['legal_name','registration_number','registration_jurisdiction','contact_name','contact_email','phone','owner_name','owner_email','store_name','address','city','province','postal','country']) key WHERE NULLIF(btrim(p_data->>key),'') IS NULL) THEN
    RAISE EXCEPTION 'Complete business, registration, contact, owner and primary location details'; END IF;
  IF p_data->>'contact_email' !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR p_data->>'owner_email' !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RAISE EXCEPTION 'Valid contact and owner emails required'; END IF;
  IF COALESCE(p_data->>'gst_hst_status','') NOT IN ('registered','not_registered','not_required') THEN RAISE EXCEPTION 'Select GST/HST registration status'; END IF;
  IF p_data->>'gst_hst_status'='registered' AND COALESCE(upper(regexp_replace(p_data->>'gst_hst_account_number','\s','','g')),'') !~ '^[0-9]{9}RT[0-9]{4}$' THEN RAISE EXCEPTION 'A valid GST/HST account number is required'; END IF;
  IF COALESCE(p_data->>'billing_cycle','monthly') NOT IN ('monthly','annual') THEN RAISE EXCEPTION 'Invalid billing cycle'; END IF;
  FOREACH k IN ARRAY ARRAY['legal_name','trading_name','registration_number','registration_jurisdiction','business_number','gst_hst_status','contact_name','contact_email','phone','owner_name','owner_email','store_name','location_name','address','city','province','postal','country','billing_cycle','business_type','business_hours','certificate_details','additional_info','certificate_scan_path','proof_of_address_path'] LOOP
    IF length(COALESCE(p_data->>k,'')) > 4000 THEN RAISE EXCEPTION 'Application field too long'; END IF;
    payload := payload || jsonb_build_object(k,btrim(COALESCE(p_data->>k,'')));
  END LOOP;
  FOREACH k IN ARRAY ARRAY['certificate_scan_path','proof_of_address_path'] LOOP
    document_path := payload->>k;
    IF document_path <> '' AND (split_part(document_path,'/',1) <> auth.uid()::text OR document_path LIKE '%..%') THEN RAISE EXCEPTION 'Supporting documents must belong to the applicant'; END IF;
  END LOOP;
  payload := payload || jsonb_build_object('subscription_plan','store','billing_cycle',COALESCE(NULLIF(payload->>'billing_cycle',''),'monthly'),
    'gst_hst_account_number',CASE WHEN payload->>'gst_hst_status'='registered' THEN upper(regexp_replace(p_data->>'gst_hst_account_number','\s','','g')) ELSE '' END,
    'modules',jsonb_build_object('pawns_loans',COALESCE((p_data->'modules'->>'pawns_loans')::boolean,false),'collector_scanning',COALESCE((p_data->'modules'->>'collector_scanning')::boolean,false)));
  INSERT INTO public.organization_applications(applicant_user_id,name,details,business_details,application_source)
    VALUES(auth.uid(),payload->>'legal_name',payload->>'additional_info',payload,'store_subscription') RETURNING id INTO aid;
  INSERT INTO public.org_audit_logs(actor_user_id,action,after_data)
    VALUES(auth.uid(),'store_application_submitted',jsonb_build_object('application_id',aid,'business_details',payload));
  RETURN jsonb_build_object('id',aid,'status','pending');
END $$;

CREATE OR REPLACE FUNCTION public.my_store_application()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id',a.id,'name',a.name,'status',a.status,'review_notes',a.review_notes,'created_at',a.created_at,
    'organization_status',o.onboarding_status) FROM public.organization_applications a LEFT JOIN public.organizations o ON o.id=a.organization_id
    WHERE a.applicant_user_id=auth.uid() ORDER BY a.created_at DESC LIMIT 1
$$;
CREATE OR REPLACE FUNCTION public.nordvik_store_applications()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.nordvik_is_admin() THEN RAISE EXCEPTION 'NORDVIK administrator required' USING ERRCODE='42501'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC) FROM public.organization_applications a),'[]');
END $$;
CREATE OR REPLACE FUNCTION public.nordvik_review_store_application(p_application_id uuid,p_decision text,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.organization_applications; org jsonb; oid uuid;
BEGIN
  IF NOT public.nordvik_is_admin() THEN RAISE EXCEPTION 'NORDVIK administrator required' USING ERRCODE='42501'; END IF;
  IF NULLIF(btrim(p_note),'') IS NULL THEN RAISE EXCEPTION 'An administrative review note is required'; END IF;
  SELECT * INTO a FROM public.organization_applications WHERE id=p_application_id FOR UPDATE;
  IF NOT FOUND OR a.status <> 'pending' THEN RAISE EXCEPTION 'Application not found or already reviewed'; END IF;
  IF p_decision='approved' THEN
    IF a.application_source <> 'store_subscription' THEN RAISE EXCEPTION 'Legacy application requires a completed Store application before approval'; END IF;
    -- Reuse the central provisioning and approval rules; activation stays separate.
    org := public.nordvik_manage_store('create',NULL,a.business_details || jsonb_build_object('subscription_plan','store'));
    oid := (org->>'id')::uuid;
    PERFORM public.nordvik_manage_store('status',oid,jsonb_build_object('status','pending_verification','reason',p_note));
    PERFORM public.nordvik_manage_store('status',oid,jsonb_build_object('status','approved','reason',p_note));
  ELSIF p_decision <> 'rejected' THEN RAISE EXCEPTION 'Invalid review decision'; END IF;
  UPDATE public.organization_applications SET status=p_decision,review_notes=btrim(p_note),reviewed_by=auth.uid(),reviewed_at=now(),organization_id=oid,updated_at=now() WHERE id=a.id;
  INSERT INTO public.org_audit_logs(organisation_id,actor_user_id,action,before_data,after_data)
    VALUES(oid,auth.uid(),'store_application_' || p_decision,to_jsonb(a),jsonb_build_object('application_id',a.id,'review_note',p_note,'organization_id',oid));
  RETURN jsonb_build_object('organization_id',oid,'status',p_decision);
END $$;

-- Old endpoints cannot create an incomplete organisation outside this workflow.
CREATE OR REPLACE FUNCTION public.submit_organization_application(p_name text,p_details text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'Choose Store in Subscriptions and complete the retailer application form'; END $$;
CREATE OR REPLACE FUNCTION public.approve_organization_application(p_app_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'Review this application in Store Management with an administrative decision note'; END $$;
CREATE OR REPLACE FUNCTION public.reject_organization_application(p_app_id uuid,p_notes text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN PERFORM public.nordvik_review_store_application(p_app_id,'rejected',p_notes); END $$;

CREATE OR REPLACE FUNCTION public.nordvik_retail_tier_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.subscription_tier::text IN ('store','store_pro') AND (TG_OP='INSERT' OR NEW.subscription_tier IS DISTINCT FROM OLD.subscription_tier)
    AND NOT public.nordvik_is_admin() AND COALESCE(auth.role(),'') <> 'service_role' THEN
    RAISE EXCEPTION 'Store subscriptions require NORDVIK approval and activation'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nordvik_retail_tier_guard ON public.profiles;
CREATE TRIGGER nordvik_retail_tier_guard BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.nordvik_retail_tier_guard();

REVOKE ALL ON FUNCTION public.submit_store_application(jsonb),public.my_store_application(),public.nordvik_store_applications(),public.nordvik_review_store_application(uuid,text,text),public.nordvik_application_guard(),public.nordvik_retail_tier_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.submit_store_application(jsonb),public.my_store_application(),public.nordvik_store_applications(),public.nordvik_review_store_application(uuid,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.submit_organization_application(text,text),public.approve_organization_application(uuid),public.reject_organization_application(uuid,text) FROM PUBLIC,anon;
NOTIFY pgrst,'reload schema';
COMMIT;
