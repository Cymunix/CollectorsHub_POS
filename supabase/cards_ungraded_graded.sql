-- Cards are Ungraded or Graded (2026-10-20). Safe to run more than once.
--
-- Single cards no longer use a condition scale (Near Mint, Lightly Played…): a card in
-- store stock is 'Ungraded', or 'Graded' with its grading company, grade and cert number
-- in their own columns. This converts the store stock that's already there:
--   * a card with a grading company, cert or grade, or whose condition names a grader
--     ("PSA 10", "BGS 9.5", "Graded…"), becomes 'Graded';
--   * every other card becomes 'Ungraded'.
-- A grader written only in the condition ("PSA 10" with no grading company or grade
-- recorded) is moved into grading_company and grade first, so it isn't lost.
-- Only stock linked to a catalogue item in a card category is touched (LEGO, comics and
-- store items keep their conditions). Past sales keep what was recorded on them.

DO $migrate$
DECLARE
  v_grader   text := '^\s*(PSA|BGS|BECKETT|CGC|SGC|TAG|ACE|PCG|HGA|KSA|GMA)\y';
  -- The same, without capturing the grader (so substring() returns the grade).
  v_prefix   text := '^\s*(?:PSA|BGS|BECKETT|CGC|SGC|TAG|ACE|PCG|HGA|KSA|GMA)\y';
  v_grade_is_text boolean := (
    SELECT data_type IN ('text', 'character varying') FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'store_inventory' AND column_name = 'grade');
BEGIN
  -- 1. A grader written only in the condition: keep it in grading_company (and grade).
  UPDATE public.store_inventory si
     SET grading_company = upper(substring(si.condition FROM v_grader))
    FROM public.items i JOIN public.categories c ON c.category_id = i.category_id
   WHERE i.item_id = si.catalog_item_id AND c.name ILIKE '%card%'
     AND si.condition ~* v_grader
     AND NULLIF(btrim(si.grading_company), '') IS NULL;

  -- The website saved graded stock with no condition and the grader in the grade
  -- ("PSA 10"): keep the grader in grading_company too.
  UPDATE public.store_inventory si
     SET grading_company = upper(substring(si.grade::text FROM v_grader))
    FROM public.items i JOIN public.categories c ON c.category_id = i.category_id
   WHERE i.item_id = si.catalog_item_id AND c.name ILIKE '%card%'
     AND si.grade::text ~* v_grader
     AND NULLIF(btrim(si.grading_company), '') IS NULL;

  IF v_grade_is_text THEN
    EXECUTE format($sql$
      UPDATE public.store_inventory si
         SET grade = NULLIF(btrim(substring(si.condition FROM %L)), '')
        FROM public.items i JOIN public.categories c ON c.category_id = i.category_id
       WHERE i.item_id = si.catalog_item_id AND c.name ILIKE '%%card%%'
         AND si.condition ~* %L
         AND NULLIF(btrim(si.grade), '') IS NULL
    $sql$, v_prefix || '\s*(.*)$', v_grader);
  ELSE
    EXECUTE format($sql$
      UPDATE public.store_inventory si
         SET grade = substring(si.condition FROM %L)::numeric
        FROM public.items i JOIN public.categories c ON c.category_id = i.category_id
       WHERE i.item_id = si.catalog_item_id AND c.name ILIKE '%%card%%'
         AND si.condition ~* %L
         AND si.grade IS NULL
         AND substring(si.condition FROM %L) IS NOT NULL
    $sql$, v_prefix || '\s*([0-9]+(\.[0-9]+)?)', v_grader, v_prefix || '\s*([0-9]+(\.[0-9]+)?)');
  END IF;

  -- 2. Every card: Graded or Ungraded.
  UPDATE public.store_inventory si
     SET condition = CASE
           WHEN NULLIF(btrim(si.grading_company), '') IS NOT NULL
             OR NULLIF(btrim(si.cert_number), '') IS NOT NULL
             OR NULLIF(btrim(si.grade::text), '') IS NOT NULL
             OR si.condition ~* v_grader
             OR si.condition ~* '^\s*graded'
           THEN 'Graded' ELSE 'Ungraded' END
    FROM public.items i JOIN public.categories c ON c.category_id = i.category_id
   WHERE i.item_id = si.catalog_item_id AND c.name ILIKE '%card%'
     AND si.condition IS DISTINCT FROM (CASE
           WHEN NULLIF(btrim(si.grading_company), '') IS NOT NULL
             OR NULLIF(btrim(si.cert_number), '') IS NOT NULL
             OR NULLIF(btrim(si.grade::text), '') IS NOT NULL
             OR si.condition ~* v_grader
             OR si.condition ~* '^\s*graded'
           THEN 'Graded' ELSE 'Ungraded' END);
END $migrate$;

-- What's there now, per condition, for the card categories.
SELECT si.condition, count(*) AS stock_records
  FROM public.store_inventory si
  JOIN public.items i ON i.item_id = si.catalog_item_id
  JOIN public.categories c ON c.category_id = i.category_id
 WHERE c.name ILIKE '%card%'
 GROUP BY si.condition
 ORDER BY 2 DESC;
