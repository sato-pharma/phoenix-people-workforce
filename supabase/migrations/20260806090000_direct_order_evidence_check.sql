-- Direct Orders — read the storefront evidence and keep the verdict (spec E2)
--
-- A Super Admin deciding a pharmacy validation sees the claimed name, a GPS distance and a photo,
-- and has to judge the photo themselves: is this a pharmacy at all, and does the sign say what the
-- rep claimed. On 2026-08-05 twelve pharmacies were ruled false and that evidence was assembled by
-- hand. This column holds an answer read once, when the validation is filed, so it is already there
-- when the desk is opened.
--
-- ONE jsonb column, not five typed ones, following this table's own precedent (`suggestions_shown`
-- is already jsonb): the shape is advisory detail read by one screen, not something any query
-- filters or joins on, and keeping it in one column means the rollback is a single DROP.
--
-- NULL is a first-class value and means "no answer", never "passed". It is null before the check
-- runs, and it stays null when the check could not run at all — an OpenAI outage, a rate limit, an
-- unreadable frame. The reader deliberately cannot fail a filing (see evidence-check.ts), so this
-- column being null must never be read as approval.
--
-- Shape:
--   {
--     "isPharmacy":       true | false | null,   -- null = could not tell, NOT "no"
--     "signText":         "…" | null,            -- what the sign actually reads, verbatim
--     "signMatchesClaim": true | false | null,   -- vs the rep's claimed_pharmacy_name
--     "similarity":       0.0–1.0 | null,        -- from the existing pharmacy matcher
--     "note":             "…" | null,            -- one sentence for the admin
--     "checkedAt":        "2026-08-06T…Z"
--   }
--
-- This is a FLAG, exactly like gps_inside_requester_area. Nothing in the decide path reads it, and
-- a regression test asserts that stays true. A hard gate on a photographed shop sign would refuse
-- real pharmacies — handwritten signs, Arabic-only signs, a sign behind a parked truck — which is
-- the "the new system blocked everything" failure this module exists to avoid.

alter table public.direct_order_pharmacy_validations
  add column if not exists evidence_check jsonb;

comment on column public.direct_order_pharmacy_validations.evidence_check is
  'Spec E2: advisory read of the storefront photo, taken once at filing. NULL means no answer '
  '(not yet run, or could not run) and must never be rendered or treated as a pass. Never gates a '
  'decision — the Super Admin decides.';
