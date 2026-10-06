-- MyHR settings, per organization: which MyHR sections its stores' staff see,
-- and the org's orientation material (a link the My Orientation tile opens).
-- Stores not in an organization see every section.

CREATE TABLE IF NOT EXISTS public.organization_myhr_settings (
  organization_id  uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled_sections text[] NOT NULL DEFAULT ARRAY[
    'orientation','pay','benefits','learning','performance','job',
    'engagement','safety','absences','travel','departure','contacts'
  ],
  orientation_url  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid DEFAULT auth.uid()
);

ALTER TABLE public.organization_myhr_settings ENABLE ROW LEVEL SECURITY;

-- The org owner manages their org's settings directly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='organization_myhr_settings' AND policyname='myhr_settings_org_owner') THEN
    CREATE POLICY myhr_settings_org_owner ON public.organization_myhr_settings
      FOR ALL TO authenticated
      USING (organization_id IN (SELECT public.user_org_ids()))
      WITH CHECK (organization_id IN (SELECT public.user_org_ids()));
  END IF;
END $$;

-- What a store's staff see in MyHR (any signed-in staff of that store, or the
-- org owner). can_edit: the caller owns the store's organization.
CREATE OR REPLACE FUNCTION public.store_myhr_settings(p_store_id uuid)
RETURNS TABLE (organization_id uuid, organization_name text, enabled_sections text[], orientation_url text, can_edit boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id,
         o.name,
         m.enabled_sections,
         m.orientation_url,
         (o.owner_user_id = auth.uid())
    FROM public.stores s
    LEFT JOIN public.organizations o ON o.id = s.organization_id
    LEFT JOIN public.organization_myhr_settings m ON m.organization_id = o.id
   WHERE s.id = p_store_id
     AND (p_store_id IN (SELECT public.user_store_ids()) OR o.owner_user_id = auth.uid())
$$;
GRANT EXECUTE ON FUNCTION public.store_myhr_settings(uuid) TO authenticated;

-- The org owner saves the sections shown and the orientation link.
CREATE OR REPLACE FUNCTION public.set_organization_myhr_settings(p_org_id uuid, p_sections text[], p_orientation_url text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can change MyHR.';
  END IF;
  INSERT INTO public.organization_myhr_settings (organization_id, enabled_sections, orientation_url, updated_at, updated_by)
  VALUES (p_org_id, COALESCE(p_sections, ARRAY[]::text[]), NULLIF(btrim(p_orientation_url), ''), now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE
    SET enabled_sections = EXCLUDED.enabled_sections,
        orientation_url  = EXCLUDED.orientation_url,
        updated_at       = now(),
        updated_by       = auth.uid();
END $$;
GRANT EXECUTE ON FUNCTION public.set_organization_myhr_settings(uuid, text[], text) TO authenticated;
