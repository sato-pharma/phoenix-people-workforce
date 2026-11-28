-- direct_order_receipt_hand_entry_review_fixes
--
-- WHAT THIS CHANGES (two functions replaced; no table, no row):
--   1. public.direct_order_release_receipt(...) — as in 20261127173244, plus, in the same transaction, every hand
--      entry still waiting on that receipt and order is closed with the note
--      'Not reviewed: the receipt was taken off the order.' A release no longer leaves a review pending, which kept
--      the paper blocked (one pending review per receipt and original) and sat on Finance's desk for good.
--   2. public.direct_order_decide_hand_entry(...) — as in 20261128134224, except:
--      - the receipt row is locked BEFORE the hand entry, the same order as every other function touching both, so two
--        reviewers deciding Original 1 and Original 2 of one receipt at once never deadlock;
--      - the decision is written first;
--      - rejecting Original 1 releases the receipt ONLY when that entry's photo is still Original 1 on the receipt of its
--        order. A stale entry (the receipt was taken off and entered again) is only marked rejected — it never takes a
--        newer, QR-read original off the order.
--
-- WHY: the code review of PR 858 (28 Nov 2026) found both: a release left the review pending, and rejecting that
-- stale review released the receipt entered again after it.
--
-- ROLLBACK: re-create direct_order_decide_hand_entry from 20261128134224_direct_order_receipt_hand_entries.sql and
-- direct_order_release_receipt from 20261127173244_direct_order_receipt_two_originals.sql. Nothing is lost: no row is
-- changed by this migration.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk.

begin;
set local lock_timeout = '5s';

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
  -- The originals left with the receipt: a review still waiting on them has nothing left to check.
  update public.direct_order_receipt_hand_entries e
     set status = 'rejected', reviewed_by_hr_id = btrim(p_actor_hr_id), reviewed_at = now(),
         review_note = 'Not reviewed: the receipt was taken off the order.'
   where e.serial = p_serial and e.request_id = p_request_id and e.status = 'pending';
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
  v_serial integer;
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
  -- The receipt first, then the hand entry: the lock order of every function that touches both.
  select e.serial into v_serial from public.direct_order_receipt_hand_entries e where e.id = p_entry_id;
  if not found then
    return jsonb_build_object('decided', false);
  end if;
  select * into v_receipt from public.direct_order_receipts r where r.serial = v_serial for update;
  select * into v_entry from public.direct_order_receipt_hand_entries e where e.id = p_entry_id for update;
  if not found or v_entry.status <> 'pending' then
    return jsonb_build_object('decided', false);
  end if;

  update public.direct_order_receipt_hand_entries e
     set status = p_decision, reviewed_by_hr_id = btrim(p_actor_hr_id), reviewed_at = now(),
         review_note = nullif(btrim(coalesce(p_note, '')), '')
   where e.id = v_entry.id;

  if p_decision = 'rejected' then
    if v_entry.original = 'custody' then
      -- Only the Original 1 this entry photographed: a stale entry never takes a newer original off the order.
      if v_receipt.state = 'used' and v_receipt.request_id = v_entry.request_id
         and v_receipt.photo_storage_path = v_entry.photo_storage_path then
        -- Original 2 goes with the receipt: a hand entry waiting on it has nothing left to review.
        update public.direct_order_receipt_hand_entries e
           set status = 'rejected', reviewed_by_hr_id = btrim(p_actor_hr_id), reviewed_at = now(),
               review_note = 'Original 1 was rejected, so the receipt was taken off the order.'
         where e.serial = v_entry.serial and e.request_id = v_entry.request_id and e.status = 'pending' and e.id <> v_entry.id;
        v_released := public.direct_order_release_receipt(
          v_entry.serial, v_entry.request_id, btrim(p_actor_hr_id), 'Hand-entered Original 1 rejected: ' || btrim(p_note)
        );
      end if;
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
