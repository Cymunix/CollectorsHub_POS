-- Corrects the release year of one Trading Cards set's catalogue items (e.g. placeholders that
-- were imported with the wrong year). Edit the set name and year, then run. Only items in that
-- set, in Trading Cards, are changed. Shows how many items were updated.
WITH target AS (
  SELECT 'Clone Wars Tactics'::text AS set_name, 2008 AS correct_year
), changed AS (
  UPDATE public.items i
     SET release_year = t.correct_year
    FROM target t
   WHERE i.subset_id IN (SELECT s.subset_id FROM public.subsets s WHERE s.name = t.set_name)
     AND i.category_id = (SELECT c.category_id FROM public.categories c WHERE c.name = 'Trading Cards')
     AND i.release_year IS DISTINCT FROM t.correct_year
  RETURNING i.item_id
)
SELECT count(*) AS items_updated FROM changed;
