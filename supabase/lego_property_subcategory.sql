-- LEGO Properties (Star Wars, Harry Potter, Ninjago…) belong to a
-- Subcategory, not a Franchise. Every other category's Property stays under
-- its Franchise, unchanged.
--
-- Adds properties.subcategory_id (optional) and fills it in for existing LEGO
-- properties without touching their franchise link:
--   1. from the items linked to the property, when they are all in one LEGO
--      subcategory;
--   2. for a property with no items yet, from its franchise, when that
--      franchise belongs to one subcategory only and it is a LEGO one.
-- Properties it can't decide are left alone and listed by the final SELECT.
-- Changes no items or item links. Rerunnable.

BEGIN;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS subcategory_id uuid REFERENCES public.subcategories(subcategory_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_properties_subcategory ON public.properties (subcategory_id);
-- One Property of a name per Subcategory (the LEGO rule; franchise-based
-- properties keep UNIQUE (franchise_id, name)).
CREATE UNIQUE INDEX IF NOT EXISTS properties_subcategory_name_key
  ON public.properties (subcategory_id, lower(name)) WHERE subcategory_id IS NOT NULL AND franchise_id IS NULL;

COMMENT ON COLUMN public.properties.subcategory_id IS
  'LEGO / Building Blocks: the Subcategory this Property belongs to (its franchise is optional). Other categories use franchise_id.';

WITH lego_subcategories AS (
  SELECT sc.subcategory_id FROM public.subcategories sc JOIN public.categories c ON c.category_id = sc.category_id
   WHERE c.name ~* '(lego|building block)'
),
-- Every item on the property is in one subcategory, and it's a LEGO one.
from_items AS (
  SELECT ip.property_id, min(i.subcategory_id::text)::uuid AS subcategory_id
    FROM public.item_properties ip JOIN public.items i ON i.item_id = ip.item_id
   GROUP BY ip.property_id
  HAVING count(DISTINCT i.subcategory_id) = 1 AND count(*) = count(i.subcategory_id)
     AND min(i.subcategory_id::text)::uuid IN (SELECT subcategory_id FROM lego_subcategories)
),
-- Properties with no items yet: the franchise belongs to one subcategory
-- only, and it's a LEGO one (a franchise shared with cards, e.g. Star Wars,
-- is never used to decide).
from_franchise AS (
  SELECT p.property_id, min(fs.subcategory_id::text)::uuid AS subcategory_id
    FROM public.properties p JOIN public.franchise_subcategory fs ON fs.franchise_id = p.franchise_id
   WHERE NOT EXISTS (SELECT 1 FROM public.item_properties ip WHERE ip.property_id = p.property_id)
   GROUP BY p.property_id
  HAVING count(DISTINCT fs.subcategory_id) = 1
     AND min(fs.subcategory_id::text)::uuid IN (SELECT subcategory_id FROM lego_subcategories)
)
UPDATE public.properties p
   SET subcategory_id = coalesce(fi.subcategory_id, ff.subcategory_id)
  FROM public.properties p2
  LEFT JOIN from_items fi ON fi.property_id = p2.property_id
  LEFT JOIN from_franchise ff ON ff.property_id = p2.property_id
 WHERE p.property_id = p2.property_id AND p.subcategory_id IS NULL
   AND coalesce(fi.subcategory_id, ff.subcategory_id) IS NOT NULL;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- LEGO properties still without a Subcategory (their items or franchise point
-- to more than one LEGO subcategory, or to none). Set these by hand.
SELECT p.property_id, p.name, f.name AS franchise
  FROM public.properties p LEFT JOIN public.franchises f ON f.franchise_id = p.franchise_id
 WHERE p.subcategory_id IS NULL
   AND (EXISTS (SELECT 1 FROM public.item_properties ip JOIN public.items i ON i.item_id = ip.item_id JOIN public.categories c ON c.category_id = i.category_id
                 WHERE ip.property_id = p.property_id AND c.name ~* '(lego|building block)')
     OR (NOT EXISTS (SELECT 1 FROM public.item_properties ip WHERE ip.property_id = p.property_id)
         AND EXISTS (SELECT 1 FROM public.franchise_subcategory fs JOIN public.subcategories sc ON sc.subcategory_id = fs.subcategory_id JOIN public.categories c ON c.category_id = sc.category_id
                      WHERE fs.franchise_id = p.franchise_id AND c.name ~* '(lego|building block)')))
 ORDER BY f.name, p.name;
