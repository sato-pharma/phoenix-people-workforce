---
paths:
  - "src/lib/resignations/**"
  - "src/components/resignations/**"
  - "app/**/resignations/**"
  - "tests/*resignation*"
  - "supabase/migrations/*resignation*"
---

# Module memory — Resignations — completing an exit and the seat it frees

**Scope:** The resignation workflow's own mechanics: the order Complete runs in and what a failed step leaves, the date a resigner's seat falls vacant, and the clearance checklist a resignation no longer opens.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Split out of `employees` on 2026-11-13 (its pointer passed the 4,000-byte margin); `employees` still loads beside this file for every resignation path.

- 🔴 **A RESIGNATION VACATES THE AU SEAT ON `last working day + 1`, NEVER ON THE LAST WORKING DAY ITSELF** — `au.occupancy_history` is read half-open (`effective_from <= d < effective_to`), so the date handed to `au.resign_occupant` is the first day the person is NOT in the seat, exactly as the hire and transfer writers already treat it. All three resignation writers (`public.phx_resign_employee_and_open_vacancy`, `public.phx_vacate_au_seats_for_employee`, `public.phx_decline_offer_and_open_vacancy`) passed the last worked day until 20261012142941, which put that day inside the VACANT span — invisible until it is a MONTH END, because achievement resolves each seat as of the period end and then credits the whole month to nobody. A null date still means "vacate from today", never tomorrow. Pinned by `tests/au-resignation-vacates-day-after-last-working-day.test.ts`. The 51 boundaries written before it were CORRECTED on production 2026-10-12 on his word — pre-image `au_backup_20261012.occupancy_resign_boundary` — moving 10 (seat, period) pairs from nobody to the person who worked the month.

- 🔴 **COMPLETING A RESIGNATION ENDS THE EMPLOYEE FIRST AND STAMPS "COMPLETED" LAST** (REC-028, 2026-11-13). `completeResignationInOrder` re-checks the row is still Approved, then runs lifecycle → sign-in → vacancy link → seat, then the optimistic-locked stamp. A failed step leaves it **Approved**, answers HR with a 409 naming the step, logs `resignation_complete_step_failed`, and **pressing Complete again is safe** — every step is a re-assertion. The steps tolerate only their own schema object being absent (`isMissingTableError` / `isMissingColumnOfTable` / `isMissingFunctionError`), never an error that merely mentions it; the vacancy link must not bump `updated_at` (the stamp's lock). Never stamp first again. Pinned by `tests/resignation-complete-order.test.ts`.

- 🔴 **A RESIGNATION OPENS NO CLEARANCE CHECKLIST ANY MORE — THE CLEARANCE MODULE WAS REMOVED ON 2026-09-01 AND ITS TRIGGER ON 2026-10-19** (owner, 2026-10-19: "Stop the trigger"). The 34 checklists it opened in between (238 pending items, none ever ready or released) stay as history and say NOTHING about a leaver's settlement; clearance is the signed paper (HR Forms, إخلاء طرف موظف). Never read an open `hr_clearance_checklists` row as an unsettled leaver, and never recreate the trigger without a screen that closes what it opens. Migration `20261019153000_resignation_stops_opening_a_clearance_checklist.sql`, pinned in `tests/hr-retention-register.test.ts` (6b).
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
