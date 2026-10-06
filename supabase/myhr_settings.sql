-- MyHR, per organization: which MyHR sections its stores' staff see, and the
-- org's own page for each section (intro, notice, a main button such as the
-- payroll portal, and groups of links to forms/guides). Orientation is just
-- the org's "orientation" page. Stores not in an organization see every
-- section (empty until content exists).
--
-- section_content: { "<section key>": {
--   "intro": text, "notice": text,
--   "button": { "label": text, "url": "https://…" },
--   "groups": [ { "title": text, "text": text,
--                 "links": [ { "label": text, "url": "https://…" } ] } ] } }

CREATE TABLE IF NOT EXISTS public.organization_myhr_settings (
  organization_id  uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled_sections text[] NOT NULL DEFAULT ARRAY[
    'orientation','pay','benefits','learning','performance','job',
    'engagement','safety','absences','travel','departure','contacts'
  ],
  section_content  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid DEFAULT auth.uid()
);
ALTER TABLE public.organization_myhr_settings
  ADD COLUMN IF NOT EXISTS section_content jsonb NOT NULL DEFAULT '{}'::jsonb;

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
DROP FUNCTION IF EXISTS public.store_myhr_settings(uuid);
CREATE FUNCTION public.store_myhr_settings(p_store_id uuid)
RETURNS TABLE (organization_id uuid, organization_name text, enabled_sections text[], section_content jsonb, can_edit boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id,
         o.name,
         m.enabled_sections,
         COALESCE(m.section_content, '{}'::jsonb),
         (o.owner_user_id = auth.uid())
    FROM public.stores s
    LEFT JOIN public.organizations o ON o.id = s.organization_id
    LEFT JOIN public.organization_myhr_settings m ON m.organization_id = o.id
   WHERE s.id = p_store_id
     AND (p_store_id IN (SELECT public.user_store_ids()) OR o.owner_user_id = auth.uid())
$$;
GRANT EXECUTE ON FUNCTION public.store_myhr_settings(uuid) TO authenticated;

-- The org owner chooses which sections show.
DROP FUNCTION IF EXISTS public.set_organization_myhr_settings(uuid, text[], text);
CREATE OR REPLACE FUNCTION public.set_organization_myhr_sections(p_org_id uuid, p_sections text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can change MyHR.';
  END IF;
  INSERT INTO public.organization_myhr_settings (organization_id, enabled_sections, updated_at, updated_by)
  VALUES (p_org_id, COALESCE(p_sections, ARRAY[]::text[]), now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE
    SET enabled_sections = EXCLUDED.enabled_sections, updated_at = now(), updated_by = auth.uid();
END $$;
GRANT EXECUTE ON FUNCTION public.set_organization_myhr_sections(uuid, text[]) TO authenticated;

-- The org owner saves one section's page (null/empty clears it).
CREATE OR REPLACE FUNCTION public.set_organization_myhr_page(p_org_id uuid, p_section text, p_content jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_org_id IS NULL OR p_org_id NOT IN (SELECT public.user_org_ids()) THEN
    RAISE EXCEPTION 'Only the organization''s owner can change MyHR.';
  END IF;
  IF COALESCE(btrim(p_section), '') = '' THEN RAISE EXCEPTION 'Missing section.'; END IF;
  INSERT INTO public.organization_myhr_settings (organization_id, updated_at, updated_by)
  VALUES (p_org_id, now(), auth.uid())
  ON CONFLICT (organization_id) DO NOTHING;
  UPDATE public.organization_myhr_settings
     SET section_content = CASE
           WHEN p_content IS NULL OR p_content = '{}'::jsonb THEN section_content - p_section
           ELSE jsonb_set(section_content, ARRAY[p_section], p_content, true)
         END,
         updated_at = now(),
         updated_by = auth.uid()
   WHERE organization_id = p_org_id;
END $$;
GRANT EXECUTE ON FUNCTION public.set_organization_myhr_page(uuid, text, jsonb) TO authenticated;
