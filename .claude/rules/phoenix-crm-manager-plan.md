---
paths:
  - "src/lib/phoenix-crm/manager-plan-rules.ts"
  - "src/lib/phoenix-crm/server/manager-*.ts"
  - "src/components/phoenix-crm/manager-*.tsx"
  - "src/components/approvals-hub/manager-plan-*.tsx"
  - "src/lib/workforce/plan-second-approver.ts"
  - "app/api/phoenix-crm/manager-plans/**"
  - "supabase/migrations/*phoenix_crm_manager_plan*"
  - "tests/phoenix-crm-manager-plan*"
---

# Module memory — Phoenix CRM — the district manager's weekly plan

**Scope:** The district manager's own week in Phoenix CRM: with a rep, Admin or a single visit per half-day, Manager's own list, his single visits, the RSM/NSM approval in the Approvals Hub, the actual-versus-planned report, and the switch that retires his legacy Weekly Plan.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Every ruling below is the owner's, given in chat on 2026-10-16 across five rounds. Account: `docs/phoenix-crm-manager-plan.md`.

- 🔒 **A DISTRICT MANAGER'S WEEK IS ITS OWN TABLE FAMILY — NEVER A ROW IN `phoenix_crm_plans`.** Seven `phoenix_crm_manager_*` tables (`20261017000000`). Every rep-plan reader scans by seat or week (`crm_plan_entries_unified`, the reports, the expiry passes, the visit save's sent-plan check), and `phoenix_crm_save_plan` refuses a seat that owns no customers. A rep-plan reader that starts reading these tables is the bug.
- 🔴 **TICKING A REP IS NOT A DOUBLE VISIT** — the actual of a with-a-rep half-day is only the double or chain visit the REP logs naming him, per customer (`phoenix_crm_countable_visits` + `countsAsManagersDoubleVisit`; `phoenix_crm_report_manager_visits` has no customer in it); a single-visit half-day is judged by his own `phoenix_crm_manager_visits`; an Admin half-day is not checkable. Only a SENT week is judged (`isManagerPlanSent`). Unplanned visits are listed apart. No calendar or report calls a with-a-rep half-day a Double Visit — it reads Field.
- 🔒 **HIS OWN SINGLE VISITS COUNT IN HIS OWN REPORT ONLY** — nothing reads `phoenix_crm_manager_visits` into `phoenix_crm_countable_visits`, `crm_visits_unified` or any KPI. The old "My own visit" is CLOSED for a DM or acting-DM seat holder once he plans here (`managerOwnVisitClosedNow` — seat AND switch, unreadable = open; refused in `saveVisit`, hidden in the visit form); the 25 already logged stay as they are. Location optional, NO photo, products and comment optional.
- 🔒 **THE REP NEVER SEES ANY OF IT** — no screen, no notice, no flag. Notices go in-app, Telegram and phone, never email, behind the live-team gate on the DM seat.
- 🔴 **THE APPROVER IS HIS RSM OR NSM (`territoryReviewer`); HANY SAAD'S DMs THEN GO TO ALI MOHAMED ALI** (`src/lib/workforce/plan-second-approver.ts`). No HR acknowledgement, no SFE step. Decided in the portal Approvals Hub — Approve, Return the week, Return one day. The Administrator may act in place of any holder at any stage, recorded and shown as "by the Administrator".
- 🔴 **THE HUB COUNTS A MANAGER PLAN ONCE — through `getPlanApprovalsForResponder` and nothing else.** That one merge feeds the badge, Needs You, the overdue check and the bell's `plan` domain; adding it to `countPhoenixCrmWeeklyPlansWaitingForYou` or `overview.waitingForYou` counts it twice. Its notices register under the `plan` domain — `phoenixCrmPlan` reads only `phoenix_crm_plans` and would archive them on first read.
- 🔒 **TWO LISTS, NEVER MERGED — HIS REPS' LISTS AND "MANAGER'S OWN LIST".** A typed name matching an existing customer is OFFERED first, never refused (namesakes are real); there is no validation step ("they are managers"); A/B/C and potential grade both required; Capture location optional. Removing one from his own list needs his RSM/NSM's approval in the Hub.
- 🔴 **A REP'S DRAFT CUSTOMERS SHOW AS "not sent", A REP WITH NO PLAN IS SKIPPED, AND A CUSTOMER THE REP LATER DROPS KEEPS THE DM'S ROW FLAGGED "no longer on the rep's day"** — worked out when READING. There is deliberately no foreign key to `phoenix_crm_plan_items`: the rep's own save rewrites those rows. A rep who sends after the DM: the DM asks to edit and his RSM/NSM approves the reopening.
- 🔴 **ONE WEEK ONLY — THE COMING SATURDAY'S, DUE THURSDAY 23:55 CAIRO; A LATE SEND IS ACCEPTED AND STAMPED LATE.** Saturday–Wednesday AM and PM, Thursday AM only, never Friday, a holiday holds nothing.
- 🔒 **THE LEGACY WEEKLY PLAN SWITCHES OFF PER DM, ONLY ONCE HIS OWN TEAM IS LIVE** (`dmPlansInPhoenixCrm`) — and never for a title that still owes it (`owesAWeeklyPlan`, the no-weekly-plan charge's own reading). A switched DM is refused by `createEmployeePlan`/`updateEmployeePlan`, loses the Plans tab, keeps the Planning Calendar, and `/employee-portals/plans` without `?plan=` sends him to the Phoenix CRM Plan tab. Mohamed Alaa Eleiwa stays on the old form until his team starts. Nosiba Salah files BOTH her rep week and her manager week.
- 🔴 **SCREENS OUTSIDE PHOENIX CRM READ HIS WEEK THROUGH `server/manager-plan-readers.ts` ONLY** — the Planning Calendar, the landing plan card, both calendars, Decided for me and the visit report. It imports no notice sender: going through `notifications/in-app.ts` closes an import cycle.
- 🔴 **THE REPORT IS READ BY HIM, HIS RSM, HIS NSM, THE SFE MANAGER, THE CEO AND THE ADMINISTRATOR — NEVER A REP** (`resolveManagerPlanReader`).
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
