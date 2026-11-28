-- direct_order_receipt_hand_entries
--
-- WHAT THIS CHANGES:
--   1. public.direct_order_receipt_hand_entries — one row for every original (Original 1 or Original 2) of a
--      delivery receipt entered WITHOUT Phoenix reading its QR in the photo (the number and code were typed).
--      pending -> approved | rejected, once. A decided row never changes, and no row is ever deleted.
--      At most one pending row per receipt and original. Service role only.
--   2. public.direct_order_receipts_guard() — unchanged, except that Original 2 may be CLEARED (all four delivery
--      columns back to null) inside direct_order_decide_hand_entry, when its hand entry is rejected.
--   3. public.direct_order_decide_hand_entry(...) — approves or rejects one pending hand entry under row locks.
--      Rejecting Original 1 releases the whole receipt through direct_order_release_receipt (append-only release
--      record, the receipt back to unused); rejecting Original 2 clears only Original 2. Who may decide is the
--      app's rule (src/lib/direct-orders/receipt-books.ts): Finance decides a manager's entry, the Super Admin
--      decides Finance's own.
--
-- WHY: owner, 28 Nov 2026: Phoenix reads each receipt's QR from a live photo, red until it reads and green when
-- it does; when the QR is damaged "المدير يدخله مانوال بس يروح للريفيو، ما يدخلش اوتوماتيك … والماليه تدخله …
-- بس هو بيروح للريفيو الاول". He chose: Finance reviews, and he reviews when Finance entered it.
--
-- ROLLBACK:
--   drop function public.direct_order_decide_hand_entry(uuid, text, text, text);
--   drop trigger direct_order_receipt_hand_entries_guard on public.direct_order_receipt_hand_entries;
--   drop function public.direct_order_receipt_hand_entries_guard();
--   drop table public.direct_order_receipt_hand_entries;   -- loses every hand entry and its review: export it first
--   then re-create public.direct_order_receipts_guard() from 20261127173244_direct_order_receipt_two_originals.sql.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one empty table, three functions and one trigger. No row is changed.

begin;
set local lock_timeout = '5s';

create table if not exists public.direct_order_receipt_hand_entries (
  id uuid primary key default gen_random_uuid(),
  serial integer not null references public.direct_order_receipts (serial),
  request_id uuid not null references public.direct_order_requests (id),
  original text not null check (original in ('custody', 'delivery')),
  photo_storage_path text not null,
  entered_by_hr_id text not null,
  entered_by_finance boolean not null,
  entered_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by_hr_id text,
  reviewed_at timestamptz,
  review_note text,
  constraint direct_order_receipt_hand_entries_reviewed check (
    (status = 'pending' and reviewed_by_hr_id is null and reviewed_at is null)
    or (status <> 'pending' and reviewed_by_hr_id is not null and reviewed_at is not null)
  ),
  constraint direct_order_receipt_hand_entries_reject_note check (
    status <> 'rejected' or length(btrim(coalesce(review_note, ''))) >= 3
  )
);

comment on table public.direct_order_receipt_hand_entries is
  'An original of a delivery receipt entered with its number and code typed, because Phoenix could not read its QR in the photo (owner, 28 Nov 2026). It waits for review: Finance decides a manager''s entry, the Super Admin decides Finance''s. pending -> approved | rejected once; never edited after the decision, never deleted. Service role only. See src/lib/direct-orders/receipt-books.ts.';

create unique index if not exists direct_order_receipt_hand_entries_one_pending
  on public.direct_order_receipt_hand_entries (serial, original) where status = 'pending';
create index if not exists direct_order_receipt_hand_entries_status_idx
  on public.direct_order_receipt_hand_entries (status, entered_at);
create index if not exists direct_order_receipt_hand_entries_request_idx
  on public.direct_order_receipt_hand_entries (request_id);

alter table public.direct_order_receipt_hand_entries enable row level security;
do $p$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'direct_order_receipt_hand_entries'
                 and policyname = 'direct_order_receipt_hand_entries_service_role') then
    create policy direct_order_receipt_hand_entries_service_role
      on public.direct_order_receipt_hand_entries for all to service_role using (true) with check (true);
  end if;
end;
$p$;
revoke all on table public.direct_order_receipt_hand_entries from public, anon, authenticated;
grant all on table public.direct_order_receipt_hand_entries to service_role;

create or replace function public.direct_order_receipt_hand_entries_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A hand-entered receipt is a record: it is never deleted.' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id or new.serial is distinct from old.serial or new.request_id is distinct from old.request_id
     or new.original is distinct from old.original or new.photo_storage_path is distinct from old.photo_storage_path
     or new.entered_by_hr_id is distinct from old.entered_by_hr_id or new.entered_by_finance is distinct from old.entered_by_finance
     or new.entered_at is distinct from old.entered_at then
    raise exception 'A hand-entered receipt''s receipt, order, photo and who entered it never change.' using errcode = 'P0001';
  end if;
  if old.status <> 'pending' then
    raise exception 'A reviewed hand-entered receipt never changes.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.direct_order_receipt_hand_entries_guard() from public, anon, authenticated;

create or replace trigger direct_order_receipt_hand_entries_guard
  before update or delete on public.direct_order_receipt_hand_entries
  for each row execute function public.direct_order_receipt_hand_entries_guard();

-- The receipts guard, as in 20261127173244, plus one door: Original 2 cleared by a rejected hand entry.
create or replace function public.direct_order_receipts_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_book_status text;
  v_releasing boolean;
  v_clearing_delivery boolean;
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
  v_clearing_delivery := coalesce(current_setting('phoenix.receipt_delivery_clear', true), '') = old.serial::text
    and new.delivery_photo_storage_path is null and new.delivery_photo_content_type is null
    and new.delivery_entered_by_hr_id is null and new.delivery_entered_at is null;
  if old.state = 'used' and (new.state is distinct from 'used' or new.request_id is distinct from old.request_id) then
    if not v_releasing then
      raise exception 'A used receipt is released from its order only through direct_order_release_receipt.' using errcode = 'P0001';
    end if;
  end if;
  if old.state = 'used' and new.state = 'used' and not v_releasing and (
    new.photo_storage_path is distinct from old.photo_storage_path
    or (old.delivery_photo_storage_path is not null and not v_clearing_delivery and (
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

create or replace function public.direct_order_decide_hand_entry(
  p_entry_id uuid,
  p_actor_hr_id text,
  p_decision text,
  p_note text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_entry public.direct_order_receipt_hand_entries%rowtype;
  v_receipt public.direct_order_receipts%rowtype;
  v_released jsonb;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'A hand-entered receipt is approved or rejected.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_actor_hr_id, ''))) = 0 then
    raise exception 'A review names who made it.' using errcode = '22023';
  end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'Write why the hand-entered receipt is rejected.' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_order_receipt_hand_entries e where e.id = p_entry_id for update;
  if not found or v_entry.status <> 'pending' then
    return jsonb_build_object('decided', false);
  end if;
  select * into v_receipt from public.direct_order_receipts r where r.serial = v_entry.serial for update;

  if p_decision = 'rejected' then
    if v_entry.original = 'custody' then
      v_released := public.direct_order_release_receipt(
        v_entry.serial, v_entry.request_id, btrim(p_actor_hr_id), 'Hand-entered Original 1 rejected: ' || btrim(p_note)
      );
      -- Original 2 went with the receipt: a hand entry waiting on it has nothing left to review.
      update public.direct_order_receipt_hand_entries e
         set status = 'rejected', reviewed_by_hr_id = btrim(p_actor_hr_id), reviewed_at = now(),
             review_note = 'Original 1 was rejected, so the receipt was taken off the order.'
       where e.serial = v_entry.serial and e.request_id = v_entry.request_id and e.status = 'pending' and e.id <> v_entry.id;
    elsif v_receipt.state = 'used' and v_receipt.request_id = v_entry.request_id
          and v_receipt.delivery_photo_storage_path = v_entry.photo_storage_path then
      perform set_config('phoenix.receipt_delivery_clear', v_entry.serial::text, true);
      update public.direct_order_receipts r
         set delivery_photo_storage_path = null, delivery_photo_content_type = null,
             delivery_entered_by_hr_id = null, delivery_entered_at = null, updated_at = now()
       where r.serial = v_entry.serial;
      perform set_config('phoenix.receipt_delivery_clear', '', true);
    end if;
  end if;

  update public.direct_order_receipt_hand_entries e
     set status = p_decision, reviewed_by_hr_id = btrim(p_actor_hr_id), reviewed_at = now(),
         review_note = nullif(btrim(coalesce(p_note, '')), '')
   where e.id = v_entry.id;

  return jsonb_build_object(
    'decided', true,
    'serial', v_entry.serial,
    'request_id', v_entry.request_id,
    'original', v_entry.original,
    'decision', p_decision,
    'released', coalesce((v_released ->> 'released')::boolean, false)
  );
end;
$$;

revoke execute on function public.direct_order_decide_hand_entry(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.direct_order_decide_hand_entry(uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
