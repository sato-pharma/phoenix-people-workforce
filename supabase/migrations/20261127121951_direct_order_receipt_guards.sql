-- direct_order_receipt_guards
--
-- WHAT THIS CHANGES (the receipt-books gap audit, owner 27 Nov 2026: "We are securing ourselves"):
--   1. direct_order_receipt_books_issued is replaced so a SPARE book still in store can be recorded lost. The old
--      check demanded a holder on every non-in-store book, so "Record lost" on an in-store book always failed.
--   2. A guard trigger on direct_order_receipts: a printed receipt's serial, book and code never change; a used
--      receipt goes back to unused ONLY through direct_order_release_receipt (below); a cancelled receipt stays
--      cancelled; a receipt can be claimed (unused -> used) only while its book is with a manager or returned —
--      the book row is locked FOR SHARE, so a book recorded lost while a photo uploads can no longer be claimed
--      from; and a receipt row is never deleted.
--   3. A guard trigger on direct_order_receipt_books: a book moves only in_store -> issued | lost and
--      issued -> returned | lost; its serial range never changes, and its holder and issue date never change once
--      it has left the store.
--   4. public.direct_order_receipt_releases — the append-only record of every receipt released from an order
--      (owner, 27 Nov 2026: "make an undo option"): who, when, why, and the photo and entry it replaced.
--   5. direct_order_release_receipt(...) — releases a used receipt from the order it was entered on and writes the
--      release row, in one transaction.
--   6. direct_order_close_receipt_book(...) — returns a book, or records it lost and cancels its unused receipts,
--      in one transaction (the two steps used to be separate calls, so a failure between them left the book lost,
--      its receipts unused and no audit row).
--   All service role only; nothing is readable with a browser key.
--
-- WHY: owner, 27 Nov 2026, after the gap audit of the receipt check — "Fix all in PR 829", "make an undo option".
--
-- ROLLBACK:
--   drop trigger direct_order_receipts_guard on public.direct_order_receipts;
--   drop trigger direct_order_receipt_books_guard on public.direct_order_receipt_books;
--   drop trigger direct_order_receipt_releases_append_only on public.direct_order_receipt_releases;
--   drop function public.direct_order_release_receipt(integer, uuid, text, text);
--   drop function public.direct_order_close_receipt_book(integer, text, text, text, text);
--   drop function public.direct_order_receipts_guard(); drop function public.direct_order_receipt_books_guard();
--   drop function public.direct_order_receipt_releases_append_only();
--   drop table public.direct_order_receipt_releases;   -- loses the release history: export it first
--   alter table public.direct_order_receipt_books drop constraint direct_order_receipt_books_issued,
--     add constraint direct_order_receipt_books_issued check (status = 'in_store' or (holder_hr_id is not null and issued_at is not null));
--   (the old check fails if a spare was recorded lost from the store in the meantime)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one check is replaced (all 16 books are in store, so it validates), one empty
-- table, two functions and three triggers are added. No row is changed.

begin;
set local lock_timeout = '5s';

-- 1. A spare book in store can be recorded lost: no holder, never issued.
alter table public.direct_order_receipt_books drop constraint if exists direct_order_receipt_books_issued;
alter table public.direct_order_receipt_books add constraint direct_order_receipt_books_issued check (
  status = 'in_store'
  or (holder_hr_id is not null and issued_at is not null)
  or (status = 'lost' and holder_hr_id is null and issued_at is null)
);

-- 4. The release record. Append-only: a release is never edited or deleted.
create table if not exists public.direct_order_receipt_releases (
  id bigint generated always as identity primary key,
  serial integer not null references public.direct_order_receipts (serial),
  book_no smallint not null references public.direct_order_receipt_books (book_no),
  -- The order the receipt had been entered on, and the entry that is being undone.
  request_id uuid not null references public.direct_order_requests (id),
  photo_storage_path text,
  photo_content_type text,
  used_by_hr_id text,
  used_at timestamptz,
  released_by_hr_id text not null,
  released_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) >= 3)
);

comment on table public.direct_order_receipt_releases is
  'Every delivery receipt released from the direct order it was entered on (owner, 27 Nov 2026: "make an undo option"): who, when, why, and the photo it carried. Append-only. Service role only. See src/lib/direct-orders/receipt-books.ts.';

create index if not exists direct_order_receipt_releases_request_idx on public.direct_order_receipt_releases (request_id);

alter table public.direct_order_receipt_releases enable row level security;
drop policy if exists direct_order_receipt_releases_service_role on public.direct_order_receipt_releases;
create policy direct_order_receipt_releases_service_role
  on public.direct_order_receipt_releases for all to service_role using (true) with check (true);
revoke all on table public.direct_order_receipt_releases from public, anon, authenticated;
grant all on table public.direct_order_receipt_releases to service_role;

create or replace function public.direct_order_receipt_releases_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'A receipt release is a record: it is never changed or deleted.' using errcode = 'P0001';
end;
$$;

drop trigger if exists direct_order_receipt_releases_append_only on public.direct_order_receipt_releases;
create trigger direct_order_receipt_releases_append_only
  before update or delete on public.direct_order_receipt_releases
  for each row execute function public.direct_order_receipt_releases_append_only();

-- 2. The receipt guard.
create or replace function public.direct_order_receipts_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_book_status text;
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
  if old.state = 'used' and (new.state is distinct from 'used' or new.request_id is distinct from old.request_id) then
    if coalesce(current_setting('phoenix.receipt_release', true), '') is distinct from old.serial::text then
      raise exception 'A used receipt is released from its order only through direct_order_release_receipt.' using errcode = 'P0001';
    end if;
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

drop trigger if exists direct_order_receipts_guard on public.direct_order_receipts;
create trigger direct_order_receipts_guard
  before update or delete on public.direct_order_receipts
  for each row execute function public.direct_order_receipts_guard();

-- 3. The book guard.
create or replace function public.direct_order_receipt_books_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A receipt book is never deleted.' using errcode = 'P0001';
  end if;
  if new.book_no is distinct from old.book_no or new.first_serial is distinct from old.first_serial or new.last_serial is distinct from old.last_serial then
    raise exception 'A printed book''s number and serial range never change.' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'in_store' and new.status in ('issued', 'lost'))
    or (old.status = 'issued' and new.status in ('returned', 'lost'))
  ) then
    raise exception 'Receipt book % cannot go from % to %.', old.book_no, old.status, new.status using errcode = 'P0001';
  end if;
  if old.status <> 'in_store' and (new.holder_hr_id is distinct from old.holder_hr_id or new.issued_at is distinct from old.issued_at) then
    raise exception 'Receipt book % has left the store: its holder and issue date never change.', old.book_no using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists direct_order_receipt_books_guard on public.direct_order_receipt_books;
create trigger direct_order_receipt_books_guard
  before update or delete on public.direct_order_receipt_books
  for each row execute function public.direct_order_receipt_books_guard();

-- 5. Release a used receipt from its order, and record it — one transaction.
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
    serial, book_no, request_id, photo_storage_path, photo_content_type, used_by_hr_id, used_at, released_by_hr_id, reason
  ) values (
    v_receipt.serial, v_receipt.book_no, v_receipt.request_id, v_receipt.photo_storage_path, v_receipt.photo_content_type,
    v_receipt.used_by_hr_id, v_receipt.used_at, btrim(p_actor_hr_id), btrim(p_reason)
  );
  perform set_config('phoenix.receipt_release', p_serial::text, true);
  update public.direct_order_receipts r
     set state = 'unused', request_id = null, photo_storage_path = null, photo_content_type = null,
         used_by_hr_id = null, used_at = null, updated_at = now()
   where r.serial = p_serial;
  perform set_config('phoenix.receipt_release', '', true);
  return jsonb_build_object(
    'released', true,
    'serial', v_receipt.serial,
    'book_no', v_receipt.book_no,
    'photo_storage_path', v_receipt.photo_storage_path,
    'used_by_hr_id', v_receipt.used_by_hr_id,
    'used_at', v_receipt.used_at
  );
end;
$$;

revoke execute on function public.direct_order_release_receipt(integer, uuid, text, text) from public, anon, authenticated;
grant execute on function public.direct_order_release_receipt(integer, uuid, text, text) to service_role;

-- 6. Return a book, or record it lost and cancel its unused receipts — one transaction.
create or replace function public.direct_order_close_receipt_book(
  p_book_no integer,
  p_kind text,
  p_expected_status text,
  p_actor_hr_id text,
  p_note text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_closed integer := 0;
  v_voided integer := 0;
begin
  if coalesce(p_kind, '') not in ('returned', 'lost') then
    raise exception 'A book is closed as returned or lost.' using errcode = '22023';
  end if;
  if (p_kind = 'returned' and coalesce(p_expected_status, '') <> 'issued')
     or (p_kind = 'lost' and coalesce(p_expected_status, '') not in ('issued', 'in_store')) then
    return jsonb_build_object('closed', false);
  end if;
  update public.direct_order_receipt_books b
     set status = p_kind, closed_at = v_now, closed_by_hr_id = p_actor_hr_id, note = p_note, updated_at = v_now
   where b.book_no = p_book_no and b.status = p_expected_status;
  get diagnostics v_closed = row_count;
  if v_closed = 0 then
    return jsonb_build_object('closed', false);
  end if;
  if p_kind = 'lost' then
    update public.direct_order_receipts r
       set state = 'voided', voided_reason = 'Book ' || p_book_no || ' reported lost', voided_by_hr_id = p_actor_hr_id,
           voided_at = v_now, updated_at = v_now
     where r.book_no = p_book_no and r.state = 'unused';
    get diagnostics v_voided = row_count;
  end if;
  return jsonb_build_object('closed', true, 'closed_at', v_now, 'voided', v_voided);
end;
$$;

revoke execute on function public.direct_order_close_receipt_book(integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.direct_order_close_receipt_book(integer, text, text, text, text) to service_role;

revoke execute on function public.direct_order_receipts_guard() from public, anon, authenticated;
revoke execute on function public.direct_order_receipt_books_guard() from public, anon, authenticated;
revoke execute on function public.direct_order_receipt_releases_append_only() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
