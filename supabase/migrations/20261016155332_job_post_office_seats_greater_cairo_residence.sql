-- job_post_office_seats_greater_cairo_residence
--
-- WHAT THIS CHANGES: the residence requirement on the three Sheraton office seats of
-- public.ats_job_post_titles — HR Section Head, Office Coordinator and Talent Acquisition Specialist —
-- reads "Greater Cairo resident / able to commute to Sheraton" instead of "Cairo-based / able to
-- commute to Sheraton". Three rows; `needs` and `updated_at`. Every other requirement, every duty and
-- every headline is untouched, and no other title holds that line (read off production 2026-10-16:
-- only these three, plus Product Manager, whose line was already corrected by 20261016145415).
-- WHY: the owner's standing wording rule — the residence line always reads "Greater Cairo", never
-- plain Cairo ("no cairo residnece without great"). The seed 20261015223405 wrote all three in the
-- older spelling.
-- WHAT IT DELIBERATELY DOES NOT DO: it does NOT make the residence a preference. On Product Manager
-- the owner asked for "preferred" (20261016145415) because that seat travels; these three sit in the
-- Sheraton office every working day, so residence stays a requirement. Softening it is his call, not
-- a consistency tidy-up.
-- GUARDED: position-independent — it rewrites only an element that still reads exactly
-- {"lead": "Cairo-based", "rest": "/ able to commute to Sheraton"}, keeps the list's order, and fires
-- only on a row that still contains that element. So a requirement edited on the Job Posts page is
-- never overwritten, and re-running it is a no-op.
-- ROLLBACK: the same statement with the two objects swapped — rewrite
-- {"lead": "Greater Cairo resident", "rest": "/ able to commute to Sheraton"} back to
-- {"lead": "Cairo-based", "rest": "/ able to commute to Sheraton"} on the same three titles; or edit
-- the line on the Job Posts page.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one requirement line on three rows, and only while that line still reads as seeded.

begin;

update public.ats_job_post_titles as t
set
  needs = (
    select jsonb_agg(
             case
               when line = '{"lead": "Cairo-based", "rest": "/ able to commute to Sheraton"}'::jsonb
                 then '{"lead": "Greater Cairo resident", "rest": "/ able to commute to Sheraton"}'::jsonb
               else line
             end
             order by idx
           )
    from jsonb_array_elements(t.needs) with ordinality as e(line, idx)
  ),
  updated_at = now()
where lower(btrim(t.title)) in ('hr section head', 'office coordinator', 'talent acquisition specialist')
  and t.needs @> '[{"lead": "Cairo-based", "rest": "/ able to commute to Sheraton"}]'::jsonb;

commit;
