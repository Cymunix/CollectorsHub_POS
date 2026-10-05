-- Store favourites ----------------------------------------------------------
-- Cards a store always wants in stock. A favourite is a catalogue card (not
-- one stock record), so it stays on the Inventory screen at 0 and covers new
-- copies bought later. The POS alerts when a favourite's available stock is
-- at or below its low-stock level, and when it's at 0.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.store_favorite_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  catalog_item_id uuid not null references public.items(item_id) on delete cascade,
  low_stock_threshold integer not null default 1 check (low_stock_threshold >= 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, catalog_item_id)
);

create index if not exists store_favorite_items_store_idx on public.store_favorite_items (store_id);

alter table public.store_favorite_items enable row level security;

-- Staff and owners of the store (public.user_store_ids(), as the checkout
-- functions use) can see and manage its favourites; nobody else can.
drop policy if exists "store favourites: read" on public.store_favorite_items;
create policy "store favourites: read" on public.store_favorite_items
  for select using (store_id in (select public.user_store_ids()));

drop policy if exists "store favourites: add" on public.store_favorite_items;
create policy "store favourites: add" on public.store_favorite_items
  for insert with check (store_id in (select public.user_store_ids()));

drop policy if exists "store favourites: change" on public.store_favorite_items;
create policy "store favourites: change" on public.store_favorite_items
  for update using (store_id in (select public.user_store_ids()))
  with check (store_id in (select public.user_store_ids()));

drop policy if exists "store favourites: remove" on public.store_favorite_items;
create policy "store favourites: remove" on public.store_favorite_items
  for delete using (store_id in (select public.user_store_ids()));

notify pgrst, 'reload schema';
