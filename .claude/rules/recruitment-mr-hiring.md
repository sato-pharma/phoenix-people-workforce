---
paths:
  - "src/lib/recruitment/mr-hiring/**"
  - "src/components/recruitment/mr-hiring/**"
  - "app/**/mr-hiring/**"
  - "tests/*mr-hiring*"
  - "supabase/migrations/*mr_hiring*"
---

# Module memory — Recruitment — Medical Rep hiring, the 8 November 2026 workflow

**Scope:** The Medical Rep hiring workflow from the WhatsApp CV to the offer: the derived step, the held CVs, the interview rounds (HR, DSM, RSM, HR Manager, NSM, joint final), step results, the NSM's recommendation and its hidden salary, the final decision, the Medical Rep Hiring page and the managers' "My Medical Rep interviews".

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

### The 8 November 2026 workflow — account: `docs/recruitment-mr-hiring-workflow.md`

- 🔴 **CVs FROM 7 NOV ONLY — A CV RECEIVED BEFORE 7 NOV 2026 00:00 CAIRO IS NOT IN THE WORKFLOW** (owner, 7 Nov 2026: "New CVs only", then "all the cvs recieved starting from 7 nov") — `MR_LIST_FROM`; the one-channel hold still starts at `MR_WORKFLOW_START` (8 Nov), so an email CV of the 7th is listed, never held. `isInMrWorkflow` in `loadMrCandidates` leaves it off the page, out of the journey and out of every write, and the workspace draws no step line on it; it finishes in the workspace as before. Never read the old flow's shortlisted or sent-to-manager status into a step. Pinned by `tests/recruitment-mr-hiring-stage.test.ts`.
- 🔴 **THE CV AND THE APPLICATION ARE ON THE HIRING JOURNEY AT EVERY STEP, FOR EVERYONE WHO OPENS IT** (owner, 7 Nov 2026: "the cv and application must appear and be appearing in all steps for every one") — `MrCvApplication` in `mr-journey-drawer.tsx` (beside the journey on a wide screen, under the current step on a narrow one), read from `/api/recruitment/mr-hiring/[candidateId]/cv`, which admits exactly the journey's readers (`readableMrRecord` → `mayReadMrJourney`). A manager's feedback, evaluation and recommendation open in that sheet, never in a form away from the CV. A manager reads the CV with the phone numbers masked and no download; HR and the CEO in full. Each question is said ONCE — the row names it and the chip carries `withLabel={false}`, as in the workspace's opened CV (owner, 7 Nov 2026: "remove the duplicated question label in both places"). Pinned by `tests/recruitment-mr-hiring-access.test.ts`.
- 🔴 **THE STEP IS DERIVED, NEVER STORED** — `mrHiringStage` reads status, bookings, step results, the recommendation and the offer every time, so the workspace's reject, the offer sync and Mark as hired move it with no second write. Never add a stored "stage" column. Pinned by `tests/recruitment-mr-hiring-stage.test.ts`.
- 🔴 **THE FINAL DECISION IS THE HR MANAGER'S ALONE** (owner, 7 Nov 2026) — `recruitmentManageRoles`; Talent Acquisition, the NSM and the CEO never record `final_decision`. Pinned by `tests/recruitment-mr-hiring-access.test.ts`.
- 🔴 **THE PROPOSED SALARY LEAVES THE SERVER ONLY FOR THE HR MANAGER, TALENT ACQUISITION AND THE NSM WHO WROTE IT** (owner, 7 Nov 2026) — `redactFactsFor` strips it before any row or journey is returned; never hide it in the browser. The joining date is not money and stays visible.
- 🔴 **HR MAY DECIDE WITHOUT DSM FEEDBACK ANY TIME AFTER THE DSM INTERVIEW HAS ENDED — NO DEADLINE, AND ONLY AT THE DSM STEP** (owner, 7 Nov 2026). Once the DSM has answered, HR does not overrule him through that path.
- 🔴 **BOTH COMPANY WHATSAPP LINES ARE OFFICIAL; A CV FROM 8 NOV 00:00 CAIRO ON ANY OTHER CHANNEL IS HELD** (owner, 7 Nov 2026: 01159888247 and 01098500699). Never hold a CV from before the start.
- 🔴 **THE RSM INTERVIEW IS "IF APPLICABLE" = HR BOOKED IT** (owner's added section, 7 Nov 2026; every Medical Rep area exists on all three lines, so the Pedia line cannot be derived). Offered after the DSM passes until the 3rd interview is booked; unbooked it is skipped; booked, its evaluation is mandatory. Its booking notifies the RSM and never re-sends the CV away from the DSM.
- 🔴 **A ROUND IS BOOKED ONLY FROM THE MEDICAL REP HIRING PAGE, NEVER CHOSEN ON THE INTERVIEW CALENDAR** — the calendar takes the location only, so the step checks, the DSM's CV send and the notices cannot be skipped.
- 🔴 **THE NOTICES NEVER EMAIL AND NEVER REACH THE CANDIDATE** — each has its own `recruitment.<event>` policy row, and the idempotency key carries the seat (`mr-interview-booked:<booking>:<seat>`) because a group of one recipient is not suffixed per recipient. Pinned by `tests/recruitment-mr-hiring-booking.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
