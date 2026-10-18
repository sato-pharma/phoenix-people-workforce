---
paths:
  - "src/lib/weekly-planning/**"
  - "src/components/employee-portal/plans-{workspace,history}.tsx"
  - "tests/{plan-workweek-linkage,plan-slot-merge,weekly-plan-*,weekly-planning-*,weekly-plans-*}*"
---

# Module memory — Weekly and Monthly Plan — the Plans tab form

**Scope:** The legacy Weekly / Monthly Plan form in the portal Plans tab: each role's workweek, which days and halves must be planned before submit, week keys and deadlines, and its approval chain.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Moved out of `crm` on 2026-10-18 so its injected pointer stays under the 4,000-byte margin `tests/module-memory.test.ts` enforces. **`crm` keeps every glob it had**, so a session working on these files loads BOTH files.

### Week keys

- 🔴 **A WEEK KEY NAMES THE ISO WEEK THAT ENDS ON ITS SUNDAY, SO `sundayFromWeekKey` IS Monday(W) + 6 — NEVER Monday − 1.** `buildWeekKey` is the convention's only authority: `employee_plan_headers.period_key` and `phoenix_crm_plans` already hold keys it produced, and production has 2026-W41 running 11–15 October 2026 (read live 2026-10-12), which is its answer. Reading the Sunday as the day before the ISO Monday made `submissionDeadlineForWeek`, `managerApprovalDeadlineForWeek` and `ceoApprovalDeadlineForWeek` fire a WHOLE WEEK early — W41's submission deadline landed on Thursday 1 October, ten days before the week it gates — and the foundation test pinned that wrong direction ("Sunday of W24 = 2026-06-07" when `buildWeekKey` answers `2026-W23`). Fixed 2026-10-12. Never move `buildWeekKey` to meet a helper; the stored keys decide. `planDeductionGraceDeadlineForMonday` takes a Monday DATE deliberately and stays as it is. Pinned by block 9b of `tests/weekly-planning-foundation.test.ts` — a 427-day round trip against `getSundayOfWeek`.

### Which days and halves must be planned

- 🔴 **THE GROUP PRODUCT MANAGER — AND ONLY SHE — MAY PLAN A WORKING DAY AS AM ONLY OR PM ONLY; SHE NEVER HAS TO SUBMIT A FULL DAY** (owner, 2026-10-18: *"only the group product manager make her okay to work only AM or only PM … doesn't have to submit a full day"*). `resolvePlanWorkweek` gives her `GROUP_PRODUCT_MANAGER_WORKWEEK` (Sunday–Thursday, every day `"half"`); every working day still needs one half. `planDayGapText` is the one completeness rule the form's banner and `assertSubmissionComplete` both read, and the form shows her "AM only" / "PM only" beside "Full day" and "AM / PM". A Product Manager, the Marketing Manager and everyone else keep full days. Pinned by `tests/plan-workweek-linkage.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
