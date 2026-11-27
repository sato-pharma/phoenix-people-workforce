-- direct_order_no_receipt_approvals
--
-- WHAT THIS CHANGES: public.direct_order_no_receipt_requests — an approved direct order that will never have a
-- delivery receipt stands without one only when the CEO approves it. Finance (Ahmed El Maraghy) asks on the order
-- with a written reason; the CEO approves or refuses it on his own screen. One row per ask:
--   - pending -> approved | refused, once. A decided row never changes again, and no row is ever deleted.
--   - At most one ask is open or approved per order at a time (a refused ask may be asked again, as a new row).
--   - The order, the reason and who asked never change.
--   Service role only; nothing is readable with a browser key.
--
-- WHY: owner, 27 Nov 2026: "صلاحيه عمل اى اوردر بدون ايصال هى صلاحيه انور فقط لاغير موافقه منه والتنفيذ من
-- خلال استاذ احمد" — making any order without a receipt is Dr Anwar's authority alone: his approval, carried out
-- through Ahmed. He chose "Anwar approves in Phoenix".
--
-- ROLLBACK:
--   drop trigger direct_order_no_receipt_requests_guard on public.direct_order_no_receipt_requests;
--   drop function public.direct_order_no_receipt_requests_guard();
--   drop table public.direct_order_no_receipt_requests;   -- loses every ask and decision: export it first
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one empty table, one function and one trigger are added. No row is changed.

begin;
set local lock_timeout = '5s';

create table if not exists public.direct_order_no_receipt_requests (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.direct_order_requests (id),
  reason text not null check (length(btrim(reason)) >= 3),
  asked_by_hr_id text not null,
  asked_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'refused')),
  decided_by_hr_id text,
  decided_at timestamptz,
  decision_note text,
  constraint direct_order_no_receipt_requests_decided check (
    (status = 'pending' and decided_by_hr_id is null and decided_at is null)
    or (status <> 'pending' and decided_by_hr_id is not null and decided_at is not null)
  )
);

comment on table public.direct_order_no_receipt_requests is
  'An approved direct order that will have no delivery receipt stands only with the CEO''s approval (owner, 27 Nov 2026): Finance asks with a reason, the CEO approves or refuses. pending -> approved | refused once; never edited after the decision, never deleted. Service role only. See src/lib/direct-orders/receipt-books.ts.';

-- One open or approved ask per order.
create unique index if not exists direct_order_no_receipt_requests_one_live
  on public.direct_order_no_receipt_requests (request_id) where status in ('pending', 'approved');
create index if not exists direct_order_no_receipt_requests_status_idx
  on public.direct_order_no_receipt_requests (status, asked_at);

alter table public.direct_order_no_receipt_requests enable row level security;
drop policy if exists direct_order_no_receipt_requests_service_role on public.direct_order_no_receipt_requests;
create policy direct_order_no_receipt_requests_service_role
  on public.direct_order_no_receipt_requests for all to service_role using (true) with check (true);
revoke all on table public.direct_order_no_receipt_requests from public, anon, authenticated;
grant all on table public.direct_order_no_receipt_requests to service_role;

create or replace function public.direct_order_no_receipt_requests_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A no-receipt request is a record: it is never deleted.' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id or new.request_id is distinct from old.request_id or new.reason is distinct from old.reason
     or new.asked_by_hr_id is distinct from old.asked_by_hr_id or new.asked_at is distinct from old.asked_at then
    raise exception 'A no-receipt request''s order, reason and asker never change.' using errcode = 'P0001';
  end if;
  if old.status <> 'pending' then
    raise exception 'A decided no-receipt request never changes.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists direct_order_no_receipt_requests_guard on public.direct_order_no_receipt_requests;
create trigger direct_order_no_receipt_requests_guard
  before update or delete on public.direct_order_no_receipt_requests
  for each row execute function public.direct_order_no_receipt_requests_guard();

commit;
