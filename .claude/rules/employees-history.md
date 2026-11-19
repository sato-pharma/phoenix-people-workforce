---
paths:
  - "src/lib/employees/change-history*.ts"
  - "src/components/employees/employee-change-history-card.tsx"
  - "app/api/employees/*/change-history/**"
  - "tests/{employee-change-history,employee-and-deduction-history}*"
  - "supabase/migrations/*change_log*"
---

# Module memory — Employees — the change history: the two logs and the panel that reads them

**Scope:** The employee record's and the salary's append-only change logs, the views that name who changed what and how it arrived, and the Employee Master's Change History panel.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Moved out of `employees` on 19 Nov 2026 so its pointer stays under the margin. The rule that every database write names the signed-in person for these logs stays in `employees`, because it binds every write.

- 🔒 **Every change to an employee record is kept by a database trigger since 2026-11-13** (`public.employee_change_log`, `20261113151738`): which columns changed, before and after, who (the `x-phoenix-actor-*` headers `upsertEmployee` already sends; none = `unattributed`). Salary figures and personal identifiers are named in `masked_fields` and never stored — since `20261114020715` that includes the address parts, birth place, the Kaab Elamaal issuer/date/refund and the CV and photo paths, and since `20261114024807` `exit_reason` and `bank_name`; the view turns a login-only actor into a name through `app_auth_users`, never by reading the login id as an hr id. Append-only by `ENABLE ALWAYS` refusal trigger (the salary log's since `20261119072427`), service role only; read it through `v_employee_change_log`, never write it from code. Since `20261119035258` it and `employee_salary_change_log` record how a write arrived: `write_channel` (`api`/`database_job`/`direct_sql`), `write_db_user`, `write_application`, `write_api_role`, `write_api_path` — never a header value; NULL = before 19 Nov. Pinned by `tests/employee-and-deduction-history.test.ts`.
- 🔒 **THE PANEL'S CHANGE HISTORY: THE DIRECTORY'S DOOR, AND NO PAY (NOT EVEN THAT IT MOVED) WHERE THE MASTER HIDES PAY** (owner, 19 Nov 2026: "Build the screen"). `GET /api/employees/:hrId/change-history`: signed in, `employees` read, then `canSeeEmployee`. `changeHistoryIncludesMoney` follows `isSalaryRedactedForViewer` and shuts HR Advisory outright; without pay the salary log is never read and pay fields leave the record log. A masked field reads "Changed, value not kept"; ids leave as names. Read-only. `src/lib/employees/change-history*.ts`, card `employee-change-history-card.tsx`. Pinned by `tests/employee-change-history.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
