---
paths:
  - "src/lib/notifications/{policy,role-recipients,recipients,vacant-seat}.ts"
  - "app/**/notification-recipients/**"
  - "tests/{named-recipients-never-widen,vacant-seat-recipients,notification-role-recipients}.test.ts"
---

# Module memory — Notifications — who a notice reaches

**Scope:** Who a notice is addressed to: the policy table's recipient strategies, the admin-editable role lists and their on/off switch, named-recipient lists a sender passes, and the vacant-seat stand-in.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Split out of `notifications` on 2026-11-19 (its pointer reached 3,976 of 4,000 bytes); `notifications` still loads beside this file for every recipients path.

- 🔒 **WHILE NOBODY HOLDS THE HR GENERALIST SEAT (`HR Operations`), EVERY NOTICE ADDRESSED TO IT GOES TO THE SUPER ADMIN — AND A FAILED READ IS NEVER AN EMPTY SEAT** (owner, 2026-10-20, when its holder moved to the HR Operations Specialist seat: "Both to you until the hire"). `VACANT_SEAT_STAND_INS` in `src/lib/notifications/vacant-seat.ts` is the map; `resolveNotificationRoleRecipients` puts every policy's roles through `withVacantSeatStandIns`, so all role-addressed senders inherit it, and a sender addressing the seat directly (vacation informed, business-card requests) calls `resolveSeatOrStandInHrIds`. A stand-in already listed costs no read and adds no copy; an unreadable seat keeps today's audience with a warning. The stand-in drops out by itself the day somebody is seated — never write a person's HR id in its place. Pinned by `tests/vacant-seat-recipients.test.ts`.
- 🔴 **A NOTICE THAT NAMES ITS RECIPIENTS GOES TO THEM OR TO NOBODY — NEVER TO EVERY HOLDER OF THE PERMISSION** (owner, 19 Nov 2026). A sender that passes `moduleOwnerHrIds` / `permissionRecipientHrIds` (the resignation alert, both payroll alerts, the employee-import and attendance-stall alerts) gets exactly those people; an EMPTY or unresolvable list now resolves to nobody (`notificationNamesItsRecipients` in `policy.ts`), the skip is recorded with `named_recipients_unresolved`. Before, `permissionBasedRecipients` fell back to every active login, so a failed read — or the list switched OFF on the recipients screen — told the CEO, the Finance Manager and HR Operations about a resignation. Only a notice that names nobody keeps the fallback. Pinned by `tests/named-recipients-never-widen.test.ts`. Account: `docs/notifications-phase-2.md`, section 2b.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
