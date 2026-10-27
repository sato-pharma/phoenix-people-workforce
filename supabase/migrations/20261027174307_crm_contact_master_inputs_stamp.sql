-- The contact-master refresh skips a tick when nothing it reads has changed (owner, 2026-10-27: "Top two
-- plus the touch trail" — the afternoon stalls are a 2 GB box swapping under daytime load).
--
-- crm_contact_master_refresh ran 417 times in the 52 hours after the 25 Oct boot — 1.1 s mean, 7.2 s max,
-- 370k disk blocks, the heaviest daytime statement on production — about eight times an hour against a
-- fifteen-minute timer, because every production process ran its own copy of that timer. The doctor list
-- itself changed in 47 of the last 96 quarter-hours. The housekeeping timer now holds a job lease (one
-- process) and asks this stamp first: the same answer as at its last successful refresh means the refresh
-- would rewrite nothing, so the tick skips it.
--
-- WHAT THE STAMP COVERS — every input the refresh reads, plus the clock it reads:
--   * the Cairo date — the refresh's v_today drives last_seen_on, the counted_from/counted_until windows,
--     the cutover compare and every least(…, v_today), so a new day always refreshes;
--   * crm_cutover — the cutover date and the vendor stand-down;
--   * phoenix_crm_customers — count and the newest created_at / updated_at / status_changed_at, so an
--     add, an edit, a status change and a net delete each move it;
--   * phoenix_crm_doctor_list_reps() — the started and list-only reps, hashed row by row;
--   * ireports360_contacts and the two brick-resolution tables — count and newest updated_at.
-- crm_contacts and crm_contact_assignments are the refresh's own OUTPUTS and are deliberately left out.
-- The timer still refreshes at least every two hours whatever the stamp says (CRM_CONTACT_MASTER_FORCE_
-- REFRESH_MS), so an input this list missed costs at most two hours, never a day.
--
-- Measured on production 2026-10-27 ~21:00 Cairo: under 1 ms. Read-only; safe in both orders — the code
-- treats a missing function as "changed" and refreshes exactly as before.

create or replace function public.crm_contact_master_inputs_stamp()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select md5(concat_ws('|',
    (now() at time zone 'Africa/Cairo')::date,
    (select string_agg(concat_ws(',', c.cutover_date, c.vendor_sync_retired_at, c.updated_at), ';')
       from public.crm_cutover c),
    (select concat_ws(',', count(*), max(p.created_at), max(p.updated_at), max(p.status_changed_at))
       from public.phoenix_crm_customers p),
    (select md5(coalesce(string_agg(concat_ws(',', r.seat_id, r.hr_id, r.agent_crm_id, r.counted_from, r.counted_until),
                                    ';' order by r.seat_id, r.hr_id, r.agent_crm_id), ''))
       from public.phoenix_crm_doctor_list_reps() r),
    (select concat_ws(',', count(*), max(m.updated_at)) from public.ireports360_contacts m),
    (select concat_ws(',', count(*), max(b.updated_at)) from public.ireports360_crm_customer_brick_resolutions b),
    (select concat_ws(',', count(*), max(g.updated_at)) from public.ireports360_crm_region_brick_resolutions g)
  ));
$$;

revoke execute on function public.crm_contact_master_inputs_stamp() from public, anon, authenticated;
grant execute on function public.crm_contact_master_inputs_stamp() to service_role;

comment on function public.crm_contact_master_inputs_stamp() is
  'A fingerprint of every input crm_contact_master_refresh reads, plus the Cairo date. The housekeeping timer skips a refresh whose stamp matches its last successful one (at most two hours old).';
