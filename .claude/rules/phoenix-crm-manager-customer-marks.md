---
paths:
  - "src/lib/phoenix-crm/manager-customer-marks-rules.ts"
  - "src/lib/phoenix-crm/server/manager-customer-marks.ts"
  - "src/components/phoenix-crm/manager-customer-marks.tsx"
  - "app/api/phoenix-crm/manager-plans/customers/insight/**"
  - "tests/phoenix-crm-manager-customer-marks*"
  - "src/lib/phoenix-crm/visit-times-rules.ts"
  - "src/lib/phoenix-crm/server/manager-visit-times.ts"
  - "src/components/phoenix-crm/visit-times.tsx"
  - "app/api/phoenix-crm/manager-plans/customers/visit-times/**"
  - "tests/phoenix-crm-visit-times*"
---

# Module memory — Phoenix CRM — the marks on each customer of a manager's plan board

**Scope:** What a manager sees on each customer while he plans his week: the grade edge, the rep's visits this month against the grade's number, his own visits, a live marketing request, the groups the shown customers share, and Go first.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Moved out of `phoenix-crm-manager-plan` on 2026-10-23 so its injected pointer stays under the 4,000-byte margin. Every ruling below is the owner's of 2026-10-23. Account: `docs/phoenix-crm-manager-plan.md`, "The marks on each customer while he plans".

- 🔴 **EVERY CUSTOMER ON HIS PLAN BOARD WEARS ITS MARKS — GRADE EDGE, THE REP'S VISITS AS PIPS, HIS OWN VISITS, A LIVE MARKETING REQUEST, AND THE GROUPS THEY SHARE.** `server/manager-customer-marks.ts` (his own territories only) and the pure `manager-customer-marks-rules.ts`. The visits are `phoenix_crm_countable_visits`, the rep List's own count; over the number is drawn apart, never a bonus; "Go first" never names a customer for his grade alone. A marketing request matches by the stored link, else by a name UNIQUE on the requester's own list — never an ambiguous one. The rep never sees any of it. Account: `docs/phoenix-crm-manager-plan.md`, "The marks on each customer while he plans". Pinned by `tests/phoenix-crm-manager-customer-marks.test.ts`.
- 🔴 **"SHOW VISIT TIMES" IS A SWITCH, OFF BY DEFAULT — OFF, THE BOARD IS EXACTLY AS IT WAS AND NOTHING IS READ** (owner, 2026-11-05). On: each customer shows the place's saved days and hours, the rep's last visit with its time and whether he was on it, and his own last visit. One switch (`visit-times.tsx`, this browser) for the manager board and the rep's day. An iReports360 copy has no clock — its day only. 🔴 **The rep's time is labelled as SAVED — "Tue 3 Nov, saved 11:31 AM"** (owner, 2026-11-07: *"label the rep's last visit time as saved on the plan boards"*): it is `captured_at`, when he saved the visit, never when he was at the door (`phoenix-crm-boards`); `visitMomentText(…, { saved: true })` on the board's rep line only. His own visits are read in TypeScript, never in `phoenix_crm_customer_last_visits`. Pinned by `tests/phoenix-crm-visit-times.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
