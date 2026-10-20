-- Star Wars PocketModel TCG › Clone Wars Tactics: corrects the catalogue against the official
-- 1-60 game-card list (2026-10-20). The set checklist that was imported had the wrong names from
-- #31 on.
--   * Checklist placeholders (no photo yet) whose name is wrong for their number are renamed.
--   * Every card gets its rarity (Common / Uncommon / Rare).
-- Card numbers are not changed, scanned items keep their names, and nothing is deleted.
-- Safe to run more than once. The result lists the set after the fix.
WITH official (num, name, rarity) AS (
  VALUES
  ('1', 'Ambush', 'Common'), ('2', 'Clankers', 'Common'), ('3', 'Elusive Target', 'Common'),
  ('4', 'EMP Grenade', 'Common'), ('5', 'Entrenched Position', 'Common'), ('6', 'Fighter Squadron', 'Common'),
  ('7', 'Jar Jar''s Luck', 'Common'), ('8', 'Jedi Deflection', 'Common'), ('9', 'King Katuunko', 'Common'),
  ('10', 'Last Stand', 'Common'), ('11', 'Nimble Craft', 'Common'), ('12', 'Onaconda Farr', 'Common'),
  ('13', 'Retail Droid', 'Common'), ('14', 'Senate Guard', 'Common'), ('15', 'Stick-Tinnies', 'Common'),
  ('16', 'Strike Team', 'Common'), ('17', 'Weapons Platform', 'Common'), ('18', 'Captured Senator', 'Common'),
  ('19', 'Captured Separatist', 'Common'), ('20', 'Explosive Charges', 'Common'),
  ('21', 'C-3PO', 'Uncommon'), ('22', 'Denal', 'Uncommon'), ('23', 'Hyperspace Ring', 'Uncommon'),
  ('24', 'Infiltration', 'Uncommon'), ('25', 'Intimidating Target', 'Uncommon'), ('26', 'Jedi Valor', 'Uncommon'),
  ('27', 'Jek', 'Uncommon'), ('28', 'Laser Beak', 'Uncommon'), ('29', 'Lieutenant Hawk', 'Uncommon'),
  ('30', 'Lieutenant Thire', 'Uncommon'), ('31', 'Missile Launcher', 'Uncommon'), ('32', 'Missile Strike', 'Uncommon'),
  ('33', 'Obi-Wan Kenobi', 'Uncommon'), ('34', 'Rolling Death Balls', 'Uncommon'), ('35', 'Rys', 'Uncommon'),
  ('36', 'Spotting Team', 'Uncommon'), ('37', 'TB-2', 'Uncommon'), ('38', 'Critical Information', 'Uncommon'),
  ('39', 'Listening Post', 'Uncommon'), ('40', 'Military Secrets', 'Uncommon'),
  ('41', 'Captain Argyus', 'Rare'), ('42', 'Clone Commander Cody', 'Rare'), ('43', 'Commander Gree', 'Rare'),
  ('44', 'General Loathsom', 'Rare'), ('45', 'Gha Nachkt', 'Rare'), ('46', 'R2-D2', 'Rare'),
  ('47', 'Yoda', 'Rare'), ('48', 'Energy Shield', 'Rare'), ('49', 'Medical Station', 'Rare'),
  ('50', 'Orders: Artillery Strike', 'Rare'), ('51', 'Orders: Reconnaissance', 'Rare'), ('52', 'Solar Storm', 'Rare'),
  ('53', 'Ahsoka', 'Rare'), ('54', 'Anakin Skywalker', 'Rare'), ('55', 'Asajj Ventress', 'Rare'),
  ('56', 'Luminara Unduli', 'Rare'), ('57', 'Captain Rex', 'Rare'), ('58', 'Darth Sidious', 'Rare'),
  ('59', 'General Grievous', 'Rare'), ('60', 'Padmé Amidala', 'Rare')
),
changed AS (
  UPDATE public.items i
     SET name = CASE WHEN (i.image_path IS NULL OR i.image_path = '') AND i.dynamic_fields->>'source' = 'Set checklist'
                     THEN o.name ELSE i.name END,
         subject = CASE WHEN (i.image_path IS NULL OR i.image_path = '') AND i.dynamic_fields->>'source' = 'Set checklist'
                        THEN o.name ELSE i.subject END,
         dynamic_fields = COALESCE(i.dynamic_fields, '{}'::jsonb) || jsonb_build_object('rarity', o.rarity)
    FROM official o
   WHERE i.subset_id = '98473d09-ee56-4c8d-8b4e-5cffc7945626'      -- Clone Wars Tactics
     AND i.franchise_id = '1c8ad196-a908-4a6c-b3ae-fa197657da86'   -- Star Wars PocketModel TCG
     AND btrim(i.card_number) = o.num
  RETURNING i.item_id, i.card_number, i.name, i.image_path
)
SELECT o.num::int AS num, o.name AS official_name, c.name AS catalogue_name, o.rarity,
       CASE WHEN c.item_id IS NULL THEN 'MISSING'
            WHEN lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g')) <> lower(regexp_replace(o.name, '[^a-zA-Z0-9]', '', 'g'))
            THEN 'name differs (scanned item)'
            ELSE '' END AS "check",
       CASE WHEN c.image_path IS NULL OR c.image_path = '' THEN 'placeholder' ELSE 'scanned' END AS kind
  FROM official o
  LEFT JOIN changed c ON btrim(c.card_number) = o.num
 ORDER BY o.num::int;
