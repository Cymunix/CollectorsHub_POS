-- Cloud review queue for scanned cards (CollectorsHub POS admin console).
--
-- The scanning PC uploads each analysed card (AI result + a JPEG of each
-- side) so the review queue can be worked from any machine signed in as a
-- platform admin. Run once in the Supabase SQL editor; safe to re-run.

-- 1. Who may use the queue: signed-in platform admins (the same rule the
--    desktop app's admin sign-in uses).
create or replace function public.is_scan_review_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.subscription_tier = 'platform_admin'
  )
$$;

revoke all on function public.is_scan_review_admin() from public;
grant execute on function public.is_scan_review_admin() to authenticated;

-- 2. One row per scanned card. `data` is the review draft (AI result, match,
--    review edits, status); images live in the scan-review bucket.
--    `version` increases on every update so two machines can't silently
--    overwrite each other.
create table if not exists public.scan_review_drafts (
  id text primary key,
  status text,
  data jsonb not null default '{}'::jsonb,
  front_image_path text,
  back_image_path text,
  version integer not null default 1,
  created_by uuid default auth.uid(),
  updated_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scan_review_drafts_updated_at_idx
  on public.scan_review_drafts (updated_at);

create or replace function public.scan_review_drafts_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end
$$;

drop trigger if exists scan_review_drafts_touch on public.scan_review_drafts;
create trigger scan_review_drafts_touch
  before update on public.scan_review_drafts
  for each row execute function public.scan_review_drafts_touch();

alter table public.scan_review_drafts enable row level security;

revoke all on public.scan_review_drafts from anon;
grant select, insert, update, delete on public.scan_review_drafts to authenticated;

drop policy if exists "Platform admins manage the scan review queue" on public.scan_review_drafts;
create policy "Platform admins manage the scan review queue"
  on public.scan_review_drafts
  for all
  to authenticated
  using (public.is_scan_review_admin())
  with check (public.is_scan_review_admin());

-- 3. Private image bucket for the queue's scans.
insert into storage.buckets (id, name, public)
values ('scan-review', 'scan-review', false)
on conflict (id) do nothing;

drop policy if exists "Platform admins read scan review images" on storage.objects;
create policy "Platform admins read scan review images"
  on storage.objects for select to authenticated
  using (bucket_id = 'scan-review' and public.is_scan_review_admin());

drop policy if exists "Platform admins upload scan review images" on storage.objects;
create policy "Platform admins upload scan review images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'scan-review' and public.is_scan_review_admin());

drop policy if exists "Platform admins update scan review images" on storage.objects;
create policy "Platform admins update scan review images"
  on storage.objects for update to authenticated
  using (bucket_id = 'scan-review' and public.is_scan_review_admin());

drop policy if exists "Platform admins delete scan review images" on storage.objects;
create policy "Platform admins delete scan review images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'scan-review' and public.is_scan_review_admin());
