-- Optional features per store, decided by the organization (head office).
-- Features: 'pawns_loans' (the POS "Pawns & Loans" tab) and 'collector_scanning'
-- (Scan Centre -> Collector Collection). Stores without a
-- row have the feature off. Rerunnable.

CREATE TABLE IF NOT EXISTS public.store_features (
  store_id   uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  feature    text NOT NULL,
  enabled    boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, feature)
);
-- The allowed features (rerunnable when new ones are added).
ALTER TABLE public.store_features DROP CONSTRAINT IF EXISTS store_features_feature_check;
ALTER TABLE public.store_features ADD CONSTRAINT store_features_feature_check CHECK (feature IN ('pawns_loans', 'collector_scanning'));
ALTER TABLE public.store_features ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_features FROM anon, authenticated;

-- POS: which optional features this store has on.
CREATE OR REPLACE FUNCTION public.store_feature_flags(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_store_id NOT IN (SELECT public.user_store_ids()) THEN RAISE EXCEPTION 'not authorised for this store'; END IF;
  RETURN COALESCE((SELECT jsonb_object_agg(f.feature, f.enabled) FROM public.store_features f WHERE f.store_id = p_store_id), '{}'::jsonb);
END $$;

-- Head office: every store's features.
CREATE OR REPLACE FUNCTION public.org_store_features(p_org_id uuid)
RETURNS TABLE (store_id uuid, feature text, enabled boolean, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN RAISE EXCEPTION 'not authorised for this organization'; END IF;
  RETURN QUERY SELECT f.store_id, f.feature, f.enabled, f.updated_at
    FROM public.store_features f JOIN public.stores s ON s.id = f.store_id
   WHERE s.organization_id = p_org_id;
END $$;

-- Head office: turn a feature on or off for one of its stores.
CREATE OR REPLACE FUNCTION public.org_set_store_feature(p_org_id uuid, p_store_id uuid, p_feature text, p_enabled boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN RAISE EXCEPTION 'not authorised for this organization'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id AND s.organization_id = p_org_id) THEN RAISE EXCEPTION 'That store isn''t in this organization.'; END IF;
  IF p_feature NOT IN ('pawns_loans', 'collector_scanning') THEN RAISE EXCEPTION 'Unknown feature.'; END IF;
  INSERT INTO public.store_features (store_id, feature, enabled, updated_by, updated_at)
  VALUES (p_store_id, p_feature, COALESCE(p_enabled, false), auth.uid(), now())
  ON CONFLICT (store_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;

GRANT EXECUTE ON FUNCTION public.store_feature_flags(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_store_features(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.org_set_store_feature(uuid, uuid, text, boolean) TO authenticated;

-- Make the new functions available to the app straight away.
NOTIFY pgrst, 'reload schema';
