-- A Property (set) name is unique per Franchise AND Subfranchise (brand), not
-- per Franchise alone. Two brands can make a set of the same name, e.g.
-- NHL → Upper Deck → McDonald's and NHL → Pacific → McDonald's.
--
-- Replaces UNIQUE (franchise_id, name) with
-- UNIQUE NULLS NOT DISTINCT (franchise_id, subset_id, name). The new rule is
-- looser, so all existing rows still fit. Already applied to Nordvik.
-- Rerunnable.

BEGIN;

ALTER TABLE public.properties DROP CONSTRAINT IF EXISTS properties_franchise_id_name_key;
ALTER TABLE public.properties DROP CONSTRAINT IF EXISTS properties_franchise_subset_name_key;
ALTER TABLE public.properties
  ADD CONSTRAINT properties_franchise_subset_name_key
  UNIQUE NULLS NOT DISTINCT (franchise_id, subset_id, name);

COMMIT;
