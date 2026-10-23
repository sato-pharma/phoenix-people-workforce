-- unplanned_reviewer_on_the_visit_goes_to_sfe
--
-- WHAT THIS CHANGES:
--   1. A BEFORE INSERT trigger on phoenix_crm_unplanned_visits: an off-plan visit whose reviewing manager was ON
--      the visit (its manager, senior or product-manager slot) is born `sfe_pending`, never `manager_pending`.
--   2. The rows already stuck that way move to `sfe_pending` (production, 23 Oct 2026: three — two chain visits of
--      12 Oct and one double visit of 18 Oct), version bumped, exactly as the app writes a correctly routed one:
--      the manager-decision fields stay empty, because no manager decided anything.
-- WHY:
--   A manager cannot sign off his own visit, so the app routes such a visit straight to the SFE (the TS fence
--   `reviewerWasOnTheVisit` / `unplannedFirstStatus`). 43 visits since 13 Oct went that way; three did not, and sat
--   waiting on the very manager who was on them, so those double and chain visits never counted for him or the rep
--   (owner, 2026-10-23: "any record submitted by himself or a double visit with him, it must appear"). The 18 Oct
--   miss has no cause found in the app, so the rule is now held in the database too — a second fence, not a
--   replacement. The trigger's name sorts BEFORE `phoenix_crm_unplanned_waits_for_the_administrator`: Postgres
--   fires same-timing triggers by name, so a visit with a pending recording still goes to the administrator first,
--   and after him to the SFE.
-- ROLLBACK:
--   drop trigger if exists phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself on public.phoenix_crm_unplanned_visits;
--   drop function if exists public.phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself();
--   The three rows' move is not reversed by that: they would be put back by hand to 'manager_pending' (visit ids
--   6cdaac80-c130-4a58-b111-fbb0b5b995b8, 6955cded-525c-4615-8a22-bd992ab98f21, 722dfe84-4f23-43dc-a876-9ea92f6a5da8).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = 'manager_pending'
    and new.manager_hr_id is not null
    and exists (
      select 1 from public.phoenix_crm_visits v
      where v.id = new.visit_id
        and upper(btrim(new.manager_hr_id)) in (
          upper(btrim(coalesce(v.manager_hr_id, ''))),
          upper(btrim(coalesce(v.senior_hr_id, ''))),
          upper(btrim(coalesce(v.product_manager_hr_id, '')))
        )
    ) then
    new.status := 'sfe_pending';
  end if;
  return new;
end;
$function$;

revoke execute on function public.phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself() from public, anon, authenticated;
grant execute on function public.phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself() to service_role;

drop trigger if exists phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself on public.phoenix_crm_unplanned_visits;
create trigger phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself
  before insert on public.phoenix_crm_unplanned_visits
  for each row execute function public.phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself();

-- The rows already stuck. Repeatable: a second run finds none.
update public.phoenix_crm_unplanned_visits u
set status = 'sfe_pending',
    version = u.version + 1,
    updated_at = now()
from public.phoenix_crm_visits v
where v.id = u.visit_id
  and u.status = 'manager_pending'
  and u.manager_hr_id is not null
  and upper(btrim(u.manager_hr_id)) in (
    upper(btrim(coalesce(v.manager_hr_id, ''))),
    upper(btrim(coalesce(v.senior_hr_id, ''))),
    upper(btrim(coalesce(v.product_manager_hr_id, '')))
  );

commit;
