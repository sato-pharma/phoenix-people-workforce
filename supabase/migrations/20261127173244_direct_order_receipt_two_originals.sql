-- direct_order_receipt_two_originals
--
-- WHAT THIS CHANGES (owner, 27 Nov 2026: every order has two originals and a copy, "Go, build it"):
--   1. public.direct_order_warehouse_exits — the day each approved direct order left the warehouse, recorded by
--      Finance (Ahmed El Maraghy). Both receipt deadlines count from the day after it:
--        Original 1 (the manager's custody page) within 3 calendar days;
--        Original 2 (the customer's delivery page) within 6 working days, Friday off.
--      One row per order; a correction overwrites it and is kept in the audit log.
--   2. direct_order_receipts gains the second photo — Original 2, the delivery page the customer signs and stamps.
--      The existing photo_* columns are Original 1, the custody page that claims the receipt. Original 2 is added
--      to a receipt already claimed for its order, once: only direct_order_release_receipt clears it.
--   3. direct_order_receipt_releases keeps the Original 2 photo a release took off, beside Original 1's.
--   4. direct_order_receipts_guard and direct_order_release_receipt are replaced to carry the second photo.
--   All service role only; nothing is readable with a browser key.
--
-- WHY: owner, 27 Nov 2026 — Original 1 is the manager's signed custody of the goods (uploaded within 3 days of the
-- goods leaving the warehouse, counted from the next day), Original 2 is the customer's delivery page with a
-- carbon copy torn off for the customer (uploaded within a working week); Finance records the warehouse exit.
--
-- ROLLBACK:
--   drop table public.direct_order_warehouse_exits;   -- loses the exit dates: export them first
--   alter table public.direct_order_receipt_releases drop column delivery_photo_storage_path,
--     drop column delivery_photo_content_type, drop column delivery_entered_by_hr_id, drop column delivery_entered_at;
--   alter table public.direct_order_receipts drop constraint direct_order_receipts_delivery,
--     drop column delivery_photo_storage_path, drop column delivery_photo_content_type,
--     drop column delivery_entered_by_hr_id, drop column delivery_entered_at;   -- loses every Original 2 photo
--   then re-run sections 2 and 5 of 20261127121951_direct_order_receipt_guards.sql to restore the old guard and release.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new empty table, four nullable columns on each of two tables (no receipt
-- has been used yet — every book is still in store), and two functions replaced. No row is changed.

begin;
set local lock_timeout = '5s';

-- 1. The warehouse exit, recorded by Finance.
create table if not exists public.direct_order_warehouse_exits (
  request_id uuid primary key references public.direct_order_requests (id),
  -- The Cairo calendar day the goods left the warehouse.
  exit_date date not null,
  recorded_by_hr_id text not null check (length(btrim(recorded_by_hr_id)) > 0),
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.direct_order_warehouse_exits is
  'The day each approved direct order left the warehouse, recorded by Finance (owner, 27 Nov 2026). The receipt deadlines count from the next day: Original 1 in 3 calendar days, Original 2 in 6 working days (Friday off). Service role only. See src/lib/direct-orders/receipt-rules.ts.';

alter table public.direct_order_warehouse_exits enable row level security;
drop policy if exists direct_order_warehouse_exits_service_role on public.direct_order_warehouse_exits;
create policy direct_order_warehouse_exits_service_role
  on public.direct_order_warehouse_exits for all to service_role using (true) with check (true);
revoke all on table public.direct_order_warehouse_exits from public, anon, authenticated;
grant all on table public.direct_order_warehouse_exits to service_role;

-- 2. Original 2 on the receipt.
alter table public.direct_order_receipts
  add column if not exists delivery_photo_storage_path text,
  add column if not exists delivery_photo_content_type text,
  add column if not exists delivery_entered_by_hr_id text,
  add column if not exists delivery_entered_at timestamptz;

alter table public.direct_order_receipts drop constraint if exists direct_order_receipts_delivery;
alter table public.direct_order_receipts add constraint direct_order_receipts_delivery check (
  (delivery_photo_storage_path is null and delivery_entered_at is null and delivery_entered_by_hr_id is null)
  or (state = 'used' and delivery_photo_storage_path is not null and delivery_entered_at is not null and delivery_entered_by_hr_id is not null)
);

comment on column public.direct_order_receipts.photo_storage_path is
  'Original 1 — the manager''s signed custody page, entered first; it claims the receipt for its order.';
comment on column public.direct_order_receipts.delivery_photo_storage_path is
  'Original 2 — the delivery page the customer signed and stamped (its carbon copy stays with the customer). Added once, after Original 1.';

-- 3. The release keeps both photos.
alter table public.direct_order_receipt_releases
  add column if not exists delivery_photo_storage_path text,
  add column if not exists delivery_photo_content_type text,
  add column if not exists delivery_entered_by_hr_id text,
  add column if not exists delivery_entered_at timestamptz;

-- 4. The receipt guard: as before, plus Original 2 is written once and cleared only by a release.
create or replace function public.direct_order_receipts_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_book_status text;
  v_releasing boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'A printed receipt is never deleted.' using errcode = 'P0001';
  end if;
  if new.serial is distinct from old.serial or new.book_no is distinct from old.book_no or new.check_code is distinct from old.check_code then
    raise exception 'A printed receipt''s serial, book and code never change.' using errcode = 'P0001';
  end if;
  if old.state = 'voided' and new.state is distinct from 'voided' then
    raise exception 'A cancelled receipt stays cancelled.' using errcode = 'P0001';
  end if;
  v_releasing := coalesce(current_setting('phoenix.receipt_release', true), '') = old.serial::text;
  if old.state = 'used' and (new.state is distinct from 'used' or new.request_id is distinct from old.request_id) then
    if not v_releasing then
      raise exception 'A used receipt is released from its order only through direct_order_release_receipt.' using errcode = 'P0001';
    end if;
  end if;
  if old.state = 'used' and new.state = 'used' and not v_releasing and (
    new.photo_storage_path is distinct from old.photo_storage_path
    or (old.delivery_photo_storage_path is not null and (
      new.delivery_photo_storage_path is distinct from old.delivery_photo_storage_path
      or new.delivery_entered_at is distinct from old.delivery_entered_at
      or new.delivery_entered_by_hr_id is distinct from old.delivery_entered_by_hr_id
    ))
  ) then
    raise exception 'An entered original is never replaced; Finance takes the receipt off the order to correct it.' using errcode = 'P0001';
  end if;
  if old.state = 'unused' and new.state = 'used' then
    -- FOR SHARE waits for a book being returned or recorded lost at this moment, then reads its new state.
    select status into v_book_status from public.direct_order_receipt_books where book_no = new.book_no for share;
    if v_book_status is distinct from 'issued' and v_book_status is distinct from 'returned' then
      raise exception 'Receipt book % is %, so none of its receipts can be used.', new.book_no, coalesce(v_book_status, 'missing')
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.direct_order_receipts_guard() from public, anon, authenticated;

-- 5. Release a used receipt from its order, and record both originals it carried — one transaction.
create or replace function public.direct_order_release_receipt(
  p_serial integer,
  p_request_id uuid,
  p_actor_hr_id text,
  p_reason text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_receipt public.direct_order_receipts%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Write why the receipt is released.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_actor_hr_id, ''))) = 0 then
    raise exception 'A release names who made it.' using errcode = '22023';
  end if;
  select * into v_receipt from public.direct_order_receipts r where r.serial = p_serial for update;
  if not found or v_receipt.state <> 'used' or v_receipt.request_id is distinct from p_request_id then
    return jsonb_build_object('released', false);
  end if;
  insert into public.direct_order_receipt_releases (
    serial, book_no, request_id, photo_storage_path, photo_content_type, used_by_hr_id, used_at,
    delivery_photo_storage_path, delivery_photo_content_type, delivery_entered_by_hr_id, delivery_entered_at,
    released_by_hr_id, reason
  ) values (
    v_receipt.serial, v_receipt.book_no, v_receipt.request_id, v_receipt.photo_storage_path, v_receipt.photo_content_type,
    v_receipt.used_by_hr_id, v_receipt.used_at,
    v_receipt.delivery_photo_storage_path, v_receipt.delivery_photo_content_type, v_receipt.delivery_entered_by_hr_id,
    v_receipt.delivery_entered_at,
    btrim(p_actor_hr_id), btrim(p_reason)
  );
  perform set_config('phoenix.receipt_release', p_serial::text, true);
  update public.direct_order_receipts r
     set state = 'unused', request_id = null, photo_storage_path = null, photo_content_type = null,
         used_by_hr_id = null, used_at = null,
         delivery_photo_storage_path = null, delivery_photo_content_type = null,
         delivery_entered_by_hr_id = null, delivery_entered_at = null,
         updated_at = now()
   where r.serial = p_serial;
  perform set_config('phoenix.receipt_release', '', true);
  return jsonb_build_object(
    'released', true,
    'serial', v_receipt.serial,
    'book_no', v_receipt.book_no,
    'photo_storage_path', v_receipt.photo_storage_path,
    'delivery_photo_storage_path', v_receipt.delivery_photo_storage_path,
    'used_by_hr_id', v_receipt.used_by_hr_id,
    'used_at', v_receipt.used_at
  );
end;
$$;

revoke execute on function public.direct_order_release_receipt(integer, uuid, text, text) from public, anon, authenticated;
grant execute on function public.direct_order_release_receipt(integer, uuid, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
