-- place_check_system_advice
--
-- WHAT THIS CHANGES: four nullable columns on public.phoenix_crm_validation_reviews and two on
--   public.phoenix_crm_shared_places, with their CHECK constraints and one partial index.
--   - system_advice_at_decision       what the system recommended when the decision was made:
--                                     approve | reject | look
--   - system_advice_code_at_decision  the kind of that advice (place-check-advice.ts `code`), e.g.
--                                     sign_other_name, timetable_missing, google_sign_match
--   - system_approved_rule            reviews only: the rule under which the SYSTEM approved the place
--                                     itself. One value today: sign_wins
--   - system_approved_at              reviews only: when it did
--   No backfill, no data change: every existing row keeps NULL in all of them.
-- WHY: the Place checks rebuild (owner, 23 Nov 2026: "REBUILD FROM SCRATCH"). The page said Reject on
--   evidence he mostly approved, and nothing kept what the system had said when he decided, so nobody
--   could count how often it was right. These columns keep it, and the page reads its own 30-day
--   agreement from them. `system_approved_rule` marks the one group the system now approves itself
--   (his word the same day: "Yes, the sign wins"), so a take-back of one can be counted and the rule
--   can switch itself off.
-- ROLLBACK:
--   alter table public.phoenix_crm_validation_reviews
--     drop column if exists system_advice_at_decision, drop column if exists system_advice_code_at_decision,
--     drop column if exists system_approved_rule, drop column if exists system_approved_at;
--   alter table public.phoenix_crm_shared_places
--     drop column if exists system_advice_at_decision, drop column if exists system_advice_code_at_decision;
--   (the constraints and the index go with their columns)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: columns are added empty and no row is rewritten.

begin;

alter table public.phoenix_crm_validation_reviews
  add column if not exists system_advice_at_decision text,
  add column if not exists system_advice_code_at_decision text,
  add column if not exists system_approved_rule text,
  add column if not exists system_approved_at timestamptz;

alter table public.phoenix_crm_validation_reviews
  drop constraint if exists phoenix_crm_validation_reviews_system_advice_check,
  add constraint phoenix_crm_validation_reviews_system_advice_check
    check (system_advice_at_decision is null or system_advice_at_decision in ('approve', 'reject', 'look'));

alter table public.phoenix_crm_validation_reviews
  drop constraint if exists phoenix_crm_validation_reviews_system_rule_check,
  add constraint phoenix_crm_validation_reviews_system_rule_check
    check (
      (system_approved_rule is null and system_approved_at is null)
      or (system_approved_rule in ('sign_wins') and system_approved_at is not null)
    );

comment on column public.phoenix_crm_validation_reviews.system_advice_at_decision is
  'What the system recommended when this review was first decided: approve, reject or look. NULL on a review decided before 23 Nov 2026 or still waiting.';
comment on column public.phoenix_crm_validation_reviews.system_advice_code_at_decision is
  'The kind of that advice (place-check-advice.ts code), which the page counts agreement by.';
comment on column public.phoenix_crm_validation_reviews.system_approved_rule is
  'The rule under which the SYSTEM approved this place itself. sign_wins: only the Google check held it and its sign names the customer.';
comment on column public.phoenix_crm_validation_reviews.system_approved_at is
  'When the system approved it under system_approved_rule. Kept when the Super Admin takes the approval back, which is how a take-back is counted.';

-- The 30-day switch reads the rule's approvals and its take-backs: a handful of rows, read hourly.
create index if not exists phoenix_crm_validation_reviews_system_rule_idx
  on public.phoenix_crm_validation_reviews (system_approved_at)
  where system_approved_rule is not null;

alter table public.phoenix_crm_shared_places
  add column if not exists system_advice_at_decision text,
  add column if not exists system_advice_code_at_decision text;

alter table public.phoenix_crm_shared_places
  drop constraint if exists phoenix_crm_shared_places_system_advice_check,
  add constraint phoenix_crm_shared_places_system_advice_check
    check (system_advice_at_decision is null or system_advice_at_decision in ('approve', 'reject', 'look'));

comment on column public.phoenix_crm_shared_places.system_advice_at_decision is
  'What the system recommended on this building when it was first decided: approve, reject or look.';
comment on column public.phoenix_crm_shared_places.system_advice_code_at_decision is
  'The kind of that advice (place-check-advice.ts code, with the building_ prefix).';

commit;
