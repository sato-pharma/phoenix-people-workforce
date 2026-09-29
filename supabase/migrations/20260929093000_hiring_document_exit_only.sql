-- Hiring documents: five of the fifteen checklist items only ever apply when somebody LEAVES.
--
-- Owner ruling, 2026-09-29: "mark the five exit documents so they only count for leavers".
--
-- WHY IT MATTERED ENOUGH TO CHANGE THE SCHEMA. The checklist is one flat list, so a resignation
-- request and a clearance were counted as outstanding against every active employee. On Pedia that
-- was 160 of its 464 untouched slots — paperwork nobody should ever chase, on people who have not
-- resigned — and while those slots are counted, no active employee can reach 100% no matter what
-- they hand in. A readiness figure that cannot reach 100% is not a readiness figure.
--
-- The flag rather than a name list in code: HR adds and retires checklist items from the screen, so
-- a hard-coded list of five names would silently stop covering a sixth the day one is added, and
-- would break outright on a rename. The column travels with the row.
--
-- FORM 6 IS AN EXIT DOCUMENT AND FORM 1 IS NOT, which is not obvious from the names: نموذج ١ tells
-- the insurance authority somebody has STARTED and نموذج ٦ tells it somebody has STOPPED. They are
-- the two ends of one file (see src/lib/hiring-pack/form6-layout.ts). "Social insurance form" —
-- Form 1 — therefore stays an onboarding document and is deliberately NOT flagged here.

alter table public.hiring_document_definitions
  add column if not exists is_exit_document boolean not null default false;

comment on column public.hiring_document_definitions.is_exit_document is
  'True when this document only applies once somebody leaves (clearances, resignation, Form 6). '
  'Such a document is not counted against an employee whose lifecycle status is active or on_leave.';

-- Matched by NAME because that is what the rows carry — the ids are generated uuids and differ
-- between staging and production, so a hard-coded id list would apply to one and silently no-op on
-- the other. Idempotent, and it touches only rows that are not already flagged.
update public.hiring_document_definitions
set is_exit_document = true,
    updated_at = now()
where is_exit_document = false
  and name in (
    'Signed resignation request',
    'Signed mutual termination agreement',
    'Signed employee clearance',
    'Signed company clearance',
    'Signed social insurance Form 6'
  );
