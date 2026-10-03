-- Season for sports cards ---------------------------------------------------
-- A card's season ("2023-24" for hockey/basketball, "2024" for football and
-- baseball) becomes a core column, and Properties (sets) no longer carry the
-- year in their name ("2013-14 SP Authentic Hockey" -> "SP Authentic Hockey"
-- + season 2013-14), so the Property list stays one entry per set.
-- release_year stays (the season's start year) for sorting and the website.
--
-- Run the steps in order in the Supabase SQL editor. Each is safe to re-run.


-- STEP 1: the column ---------------------------------------------------------
alter table public.items add column if not exists season text;
create index if not exists items_season_idx on public.items (season);
notify pgrst, 'reload schema';


-- STEP 2 (preview, changes nothing): Properties named with a year/season, what
-- each becomes, which existing Property it merges into, and how many cards.
with named as (
  select property_id, name, franchise_id, subset_id,
         substring(name from '^((?:19|20)[0-9]{2}(?:-[0-9]{2,4})?)\s') as season,
         btrim(regexp_replace(name, '^(19|20)[0-9]{2}(-[0-9]{2,4})?\s+', '')) as new_name
  from public.properties
  where name ~ '^(19|20)[0-9]{2}(-[0-9]{2,4})?\s'
),
keeper as (
  -- One Property per (set name, franchise, product line): an existing
  -- year-less one if there is one, else the first of the year-named ones.
  select distinct on (lower(n.new_name), n.franchise_id, n.subset_id)
         lower(n.new_name) as key_name, n.franchise_id, n.subset_id,
         coalesce(plain.property_id, n.property_id) as keeper_id
  from named n
  left join public.properties plain
    on lower(plain.name) = lower(n.new_name)
   and plain.franchise_id is not distinct from n.franchise_id
   and plain.subset_id is not distinct from n.subset_id
  order by lower(n.new_name), n.franchise_id, n.subset_id, plain.property_id nulls last, n.property_id
)
select n.name as current_name, n.season, n.new_name,
       case when k.keeper_id = n.property_id then 'renamed' else 'merged into ' || k.keeper_id end as becomes,
       (select count(*) from public.item_properties ip where ip.property_id = n.property_id) as cards
from named n
join keeper k on k.key_name = lower(n.new_name) and k.franchise_id is not distinct from n.franchise_id and k.subset_id is not distinct from n.subset_id
order by n.new_name, n.season;


-- STEP 3: apply it (one transaction: all or nothing) --------------------------
begin;

create temporary table season_named on commit drop as
select property_id, name, franchise_id, subset_id,
       substring(name from '^((?:19|20)[0-9]{2}(?:-[0-9]{2,4})?)\s') as season,
       btrim(regexp_replace(name, '^(19|20)[0-9]{2}(-[0-9]{2,4})?\s+', '')) as new_name
from public.properties
where name ~ '^(19|20)[0-9]{2}(-[0-9]{2,4})?\s';

create temporary table season_keeper on commit drop as
select distinct on (lower(n.new_name), n.franchise_id, n.subset_id)
       lower(n.new_name) as key_name, n.franchise_id, n.subset_id, n.new_name,
       coalesce(plain.property_id, n.property_id) as keeper_id
from season_named n
left join public.properties plain
  on lower(plain.name) = lower(n.new_name)
 and plain.franchise_id is not distinct from n.franchise_id
 and plain.subset_id is not distinct from n.subset_id
order by lower(n.new_name), n.franchise_id, n.subset_id, plain.property_id nulls last, n.property_id;

-- a) Each card in a year-named Property gets that season.
update public.items i
set season = n.season
from public.item_properties ip
join season_named n on n.property_id = ip.property_id
where ip.item_id = i.item_id
  and (i.season is null or i.season = '');

-- b) Cards move to the kept Property (merged Properties).
insert into public.item_properties (item_id, property_id)
select ip.item_id, k.keeper_id
from public.item_properties ip
join season_named n on n.property_id = ip.property_id
join season_keeper k on k.key_name = lower(n.new_name) and k.franchise_id is not distinct from n.franchise_id and k.subset_id is not distinct from n.subset_id
where ip.property_id <> k.keeper_id
  and not exists (select 1 from public.item_properties x where x.item_id = ip.item_id and x.property_id = k.keeper_id);

delete from public.item_properties ip
using season_named n, season_keeper k
where ip.property_id = n.property_id
  and k.key_name = lower(n.new_name) and k.franchise_id is not distinct from n.franchise_id and k.subset_id is not distinct from n.subset_id
  and ip.property_id <> k.keeper_id;

-- c) The kept Properties lose the year; the merged ones are removed.
update public.properties p
set name = k.new_name
from season_keeper k
where p.property_id = k.keeper_id and p.name <> k.new_name;

delete from public.properties p
using season_named n, season_keeper k
where p.property_id = n.property_id
  and k.key_name = lower(n.new_name) and k.franchise_id is not distinct from n.franchise_id and k.subset_id is not distinct from n.subset_id
  and p.property_id <> k.keeper_id;

commit;


-- STEP 4: the season for every other sports card, from its release year -------
-- Single-year sports (football, baseball, soccer...): the season is the year.
update public.items i
set season = i.release_year::text
from public.categories c, public.subcategories s
where c.category_id = i.category_id and c.name = 'Sports Cards'
  and s.subcategory_id = i.subcategory_id and s.name not in ('Hockey', 'Basketball')
  and i.release_year is not null and (i.season is null or i.season = '');

-- STEP 5 (preview): hockey and basketball seasons span two years, so the
-- release year alone doesn't say which season ("1991" could be 1990-91 or
-- 1991-92). Suggested season = release year to the next year; check the list.
select i.item_id, i.name, i.card_number, i.release_year, s.name as sport,
       i.release_year::text || '-' || right((i.release_year + 1)::text, 2) as suggested_season
from public.items i
join public.categories c on c.category_id = i.category_id and c.name = 'Sports Cards'
join public.subcategories s on s.subcategory_id = i.subcategory_id and s.name in ('Hockey', 'Basketball')
where i.release_year is not null and (i.season is null or i.season = '')
order by s.name, i.release_year, i.name;

-- STEP 6 (only if the suggestions in step 5 look right): apply them.
-- update public.items i
-- set season = i.release_year::text || '-' || right((i.release_year + 1)::text, 2)
-- from public.categories c, public.subcategories s
-- where c.category_id = i.category_id and c.name = 'Sports Cards'
--   and s.subcategory_id = i.subcategory_id and s.name in ('Hockey', 'Basketball')
--   and i.release_year is not null and (i.season is null or i.season = '');
