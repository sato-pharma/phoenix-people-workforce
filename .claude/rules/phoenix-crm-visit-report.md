---
paths:
  - "src/lib/phoenix-crm/{visit-report-*,server/visit-report*}.ts"
  - "src/components/phoenix-crm/visit-report/**"
  - "app/**/phoenix-crm/visit-report/**"
  - "app/employee-portals/visit-report/**"
  - "tests/phoenix-crm-visit-report*"
---

# Module memory — Phoenix CRM — the Visit Report generator

**Scope:** The Visit Report: who may run it and for whom (a rep, a district or a manager), the fields each reader tier may see, the participants filter, and a manager's own visits listed but counted nowhere.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Moved out of `phoenix-crm-boards` on 2026-10-20 so its injected pointer stays under the 4,000-byte margin `tests/module-memory.test.ts` enforces. **`phoenix-crm-boards` keeps every glob it had**, so a session working on these files loads both modules and nothing that used to arrive stops arriving.

- 🔒 **THE VISIT REPORT GENERATOR IS THE SUPER ADMIN'S AND THE SFE MANAGER'S ACROSS THE COMPANY AND THE DISTRICT MANAGER'S ACROSS HIS OWN TEAM, A PAGE OF ITS OWN (`/admin/phoenix-crm/visit-report`, `/employee-portals/visit-report` for a district manager), NEVER A TAB OF `PhoenixCrmApp`, AND THE SFE MANAGER NEVER RECEIVES THE MOCK-LOCATION EVIDENCE** (owner, 2026-10-15). `canReadVisitReport` gates both pages, both routes and the loader. **THREE SIGHTS in `visit-report-fields.ts` — `manager` (the default), `sfe`, `superAdmin`:** the district manager is offered 97 of 115 fields and never the 17 `sfe`-sight ones nor `mockDevice` (**keep the two rulings**, owner 2026-10-15 — never widen them without his word); a field with no sight is a district manager's. One loader feeds the screen, dashboard and one-tab workbook; the result filters narrow screen and file alike, the file always leads with date, who visited and customer, and saved views are their owner's only (2026-10-16). A row names `personOnTheVisit`, never the seat occupant; a DM reads a weak reading as at the place. Pinned by `tests/phoenix-crm-visit-report.test.ts`; account: `docs/phoenix-crm-visit-report.md`.
- 🔒 **THE VISIT REPORT RUNS FOR A REP, A DISTRICT OR A MANAGER, AND "WHO VISITED" MATCHES EVERYONE ON THE VISIT** (owner, 2026-10-20). The manager choice is `managersInScope` plus the lines' product managers (`loadScopeProductManagers`), never upward; a manager not on the picker gets a 404, and the manager kind keeps the 31-day cap. It reads his visits by `manager_hr_id`, `senior_hr_id` and `product_manager_hr_id` on readable territories, and adds his OWN single visits as `ownVisit` rows under his name — no distance, flag, position or photo asked of them, and every tile and panel leaves them out (the Visits tile says so in words). An all-vacant district is no longer hidden. Measured by the Role Coverage audit (`phoenix-crm-visit-report-managers`). Pinned by `tests/phoenix-crm-visit-report.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
