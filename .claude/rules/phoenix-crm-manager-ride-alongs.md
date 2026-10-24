---
paths:
  - "src/lib/phoenix-crm/manager-plan-rules.ts"
  - "src/lib/phoenix-crm/server/manager-plans.ts"
  - "src/lib/phoenix-crm/server/manager-plan-report.ts"
  - "src/components/phoenix-crm/manager-plan-board.tsx"
  - "src/components/approvals-hub/manager-plan-request-detail.tsx"
  - "supabase/migrations/*phoenix_crm_manager_plan_with_*"
  - "tests/phoenix-crm-manager-plan*"
---

# Module memory — Phoenix CRM — a manager's half-day with another manager

**Scope:** The half-days a manager spends with another manager rather than a rep: a regional, national or product manager's With a district manager (`with_dm`), and a district manager's With my manager or product manager (`with_senior`), its organogram picker, the areas ticked, Done by a chain visit, and how the Approvals Hub shows them.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Moved out of `phoenix-crm-manager-plan` on 2026-10-23 so its injected pointer stays under the 4,000-byte margin. Every ruling below is the owner's of 2026-10-23.

- 🔴 **`with_dm` IS NEVER A DM'S HALF-DAY** — "With a district manager", a fourth kind for the regional, national and product managers only (owner, 2026-10-23: *"add an option for him to visit with DM … then all his areas including vacant appear"*, *"also GPM or PM"*; asked: tick one or more areas, Done if a chain visit names him). Kind `with_dm`: the district manager picked as the scope (never "Any rep in the line"), then one or more of his areas, vacant ones by name; no customers. Stored in `dm_visit` (`20261023233000`), the joined area names in `area_name`. Offered by `managerSlotKinds`, refused for `'dm'` by `managerSlotScopeError` and the database. Each ticked area is one report row, Done when a rep on that area logs a visit that day naming the DM and him (`countsAsPlannersVisitWithDm`), counted once per day and area (`managerEvidenceKey`). Pinned by `tests/phoenix-crm-manager-plan.test.ts`.
- 🔴 **`with_senior` IS ONLY A DM'S HALF-DAY, AND ITS PICKER IS THE ORGANOGRAM** — "With my manager or product manager" (owner, 2026-10-23: *"in district managers account make them able to put the pm/gpm w regional manager dr hany fi pedia … but anti infective district manager to national sales manager … follow organogram"*; confirmed: a weekly-plan half-day, Done when a chain visit names both). The picker is `managerSeniorOffers`: `managerChain` above HIS seat (the RSM where the line has one, then the NSM; the NSM alone where none) and `loadLineProductManagers` — the people a rep's chain visit offers; the save refuses anyone else. Then one or more areas of his district, vacant ones by name; no customers. Stored in `senior_visit` (`20261023233002`). Each area is one report row, Done when a chain visit there that day names him as manager and the pick as senior or product manager (`countsAsDmsVisitWithSenior`). The Approvals Hub shows the kind, the person and each area as a chip, vacant marked.
- 🔴 **THE PERSON A DISTRICT MANAGER PICKS SEES THE HALF-DAY ON HIS CALENDAR AND IS TOLD WHEN THE WEEK IS APPROVED — HIS OWN PLAN BOARD IS NEVER TOUCHED** (owner, 2026-10-24: "Calendar + notice"; the national board stays as #6399 merged it). `ManagerPlanHalfDay.seniorHrId` carries the pick: the shared planning calendar shows it to him whatever the role rules hide (`withHrId` in `isPlanItemVisibleToViewer` — the CNS Marketing Manager sees no district manager's plan otherwise), and his personal calendar lists it as "With <district manager> (district manager)". On approval `transitionManagerPlan` sends one `with_you` notice per picked person (`managerPlanWithYou`, never the DM himself), event `manager_plan_with_you`, never email, opening `/employee-portals/plans/calendar`. Pinned by `tests/phoenix-crm-manager-plan.test.ts` and `tests/weekly-plan-calendar-owner-scope.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
