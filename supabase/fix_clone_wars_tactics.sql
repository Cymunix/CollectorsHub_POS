-- Star Wars PocketModel TCG › Clone Wars Tactics: corrects the catalogue against the official
-- 1-60 game-card list (2026-10-20).
--   * Checklist placeholders (no photo yet) whose name is wrong for their number are renamed.
--   * The scanned "Medical Station" (read as #39) is moved to #49, its number on the list, and
--     the placeholder that was at #49 becomes #39 Listening Post.
--   * Every card gets its rarity (Common / Uncommon / Rare).
-- Scanned items keep their own names (e.g. "Clankers!"); only their rarity is added.
-- Nothing is deleted. Run the whole file; the last query shows the set after the fix.
BEGIN;

CREATE TEMP TABLE cwt_list (num int PRIMARY KEY, name text NOT NULL, rarity text NOT NULL) ON COMMIT DROP;
INSERT INTO cwt_list (num, name, rarity) VALUES
  (1, 'Ambush', 'Common'), (2, 'Clankers', 'Common'), (3, 'Elusive Target', 'Common'),
  (4, 'EMP Grenade', 'Common'), (5, 'Entrenched Position', 'Common'), (6, 'Fighter Squadron', 'Common'),
  (7, 'Jar Jar''s Luck', 'Common'), (8, 'Jedi Deflection', 'Common'), (9, 'King Katuunko', 'Common'),
  (10, 'Last Stand', 'Common'), (11, 'Nimble Craft', 'Common'), (12, 'Onaconda Farr', 'Common'),
  (13, 'Retail Droid', 'Common'), (14, 'Senate Guard', 'Common'), (15, 'Stick-Tinnies', 'Common'),
  (16, 'Strike Team', 'Common'), (17, 'Weapons Platform', 'Common'), (18, 'Captured Senator', 'Common'),
  (19, 'Captured Separatist', 'Common'), (20, 'Explosive Charges', 'Common'),
  (21, 'C-3PO', 'Uncommon'), (22, 'Denal', 'Uncommon'), (23, 'Hyperspace Ring', 'Uncommon'),
  (24, 'Infiltration', 'Uncommon'), (25, 'Intimidating Target', 'Uncommon'), (26, 'Jedi Valor', 'Uncommon'),
  (27, 'Jek', 'Uncommon'), (28, 'Laser Beak', 'Uncommon'), (29, 'Lieutenant Hawk', 'Uncommon'),
  (30, 'Lieutenant Thire', 'Uncommon'), (31, 'Missile Launcher', 'Uncommon'), (32, 'Missile Strike', 'Uncommon'),
  (33, 'Obi-Wan Kenobi', 'Uncommon'), (34, 'Rolling Death Balls', 'Uncommon'), (35, 'Rys', 'Uncommon'),
  (36, 'Spotting Team', 'Uncommon'), (37, 'TB-2', 'Uncommon'), (38, 'Critical Information', 'Uncommon'),
  (39, 'Listening Post', 'Uncommon'), (40, 'Military Secrets', 'Uncommon'),
  (41, 'Captain Argyus', 'Rare'), (42, 'Clone Commander Cody', 'Rare'), (43, 'Commander Gree', 'Rare'),
  (44, 'General Loathsom', 'Rare'), (45, 'Gha Nachkt', 'Rare'), (46, 'R2-D2', 'Rare'),
  (47, 'Yoda', 'Rare'), (48, 'Energy Shield', 'Rare'), (49, 'Medical Station', 'Rare'),
  (50, 'Orders: Artillery Strike', 'Rare'), (51, 'Orders: Reconnaissance', 'Rare'), (52, 'Solar Storm', 'Rare'),
  (53, 'Ahsoka', 'Rare'), (54, 'Anakin Skywalker', 'Rare'), (55, 'Asajj Ventress', 'Rare'),
  (56, 'Luminara Unduli', 'Rare'), (57, 'Captain Rex', 'Rare'), (58, 'Darth Sidious', 'Rare'),
  (59, 'General Grievous', 'Rare'), (60, 'Padmé Amidala', 'Rare');

-- The set's items (Clone Wars Tactics under Star Wars PocketModel TCG).
CREATE TEMP TABLE cwt_items ON COMMIT DROP AS
SELECT i.item_id, i.card_number, i.name,
       (i.image_path IS NULL OR i.image_path = '') AND i.dynamic_fields->>'source' = 'Set checklist' AS placeholder
  FROM public.items i
 WHERE i.subset_id = '98473d09-ee56-4c8d-8b4e-5cffc7945626'
   AND i.franchise_id = '1c8ad196-a908-4a6c-b3ae-fa197657da86';

-- 1. Swap #39 / #49 in three steps (never two items on one number at the same moment).
UPDATE public.items SET card_number = '39-moving'
 WHERE item_id IN (SELECT item_id FROM cwt_items WHERE placeholder AND card_number = '49');
UPDATE public.items SET card_number = '49'
 WHERE item_id IN (SELECT item_id FROM cwt_items WHERE NOT placeholder AND card_number = '39' AND name = 'Medical Station');
UPDATE public.items SET card_number = '39'
 WHERE item_id IN (SELECT item_id FROM cwt_items WHERE placeholder) AND card_number = '39-moving';

-- Keep the numeric copy of the card number in step, if it is an ordinary (not generated) column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'items' AND column_name = 'card_number_int' AND is_generated = 'NEVER'
  ) THEN
    UPDATE public.items i SET card_number_int = i.card_number::int
      FROM cwt_items c
     WHERE i.item_id = c.item_id AND i.card_number ~ '^[0-9]+$';
  END IF;
END
$$;

-- 2. Placeholders take the right name for their number.
UPDATE public.items i
   SET name = l.name, subject = l.name
  FROM cwt_items c, cwt_list l
 WHERE i.item_id = c.item_id AND c.placeholder
   AND i.card_number = l.num::text
   AND i.name IS DISTINCT FROM l.name;

-- 3. Rarity on every card in the set.
UPDATE public.items i
   SET dynamic_fields = COALESCE(i.dynamic_fields, '{}'::jsonb) || jsonb_build_object('rarity', l.rarity)
  FROM cwt_items c, cwt_list l
 WHERE i.item_id = c.item_id
   AND i.card_number = l.num::text;

-- The set after the fix: "check" is blank when the catalogue name agrees with the list.
SELECT l.num, l.name AS official_name, i.name AS catalogue_name, i.dynamic_fields->>'rarity' AS rarity,
       CASE WHEN i.item_id IS NULL THEN 'MISSING'
            WHEN lower(regexp_replace(i.name, '[^a-zA-Z0-9]', '', 'g')) <> lower(regexp_replace(l.name, '[^a-zA-Z0-9]', '', 'g')) THEN 'name differs (scanned item)'
            ELSE '' END AS "check",
       CASE WHEN i.image_path IS NULL OR i.image_path = '' THEN 'placeholder' ELSE 'scanned' END AS kind
  FROM cwt_list l
  LEFT JOIN public.items i
    ON i.subset_id = '98473d09-ee56-4c8d-8b4e-5cffc7945626' AND i.card_number = l.num::text
 ORDER BY l.num;

COMMIT;
