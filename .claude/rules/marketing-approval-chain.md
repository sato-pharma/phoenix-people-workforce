---
paths:
  - "src/lib/marketing-requests/{cancel,reopen-rule}*"
  - "src/lib/marketing-requests/product-watchers*"
  - "app/employee-portals/marketing-requests/watching/**"
  - "src/components/marketing-requests/marketing-watched-requests*"
  - "tests/*marketing-product-watchers*"
  - "tests/*{marketing-cancel-request,marketing-reject-terminalises,marketing-reopen-rejected-request,marketing-finance-requirement-on-approval,direct-orders-and-marketing-atomic}*"
  - "supabase/migrations/*{marketing_decide,marketing_reject_terminalises,marketing_reopen_rejected,marketing_resubmit_atomic,marketing_refuse_self_approval,marketing_finance_requirement_on_approval}*"
---

# Module memory — Marketing approval chain — deciding, cancelling, reopening and resubmitting a request

**Scope:** The database functions that move a marketing request through its approval rungs (phx_decide_marketing_request_step, phx_cancel_marketing_request, the reopen and the resubmit) and the locks and status guards that keep two of them from overwriting each other.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔴 **A MARKETING DECISION LOCKS THE REQUEST AND REFUSES UNLESS IT IS STILL `pending_approval`; CANCEL CLOSES THE OPEN RUNGS IN THE SAME TRANSACTION** (enterprise audit F-MKT-006, 2026-11-13; migration `20261113161619`). `phx_decide_marketing_request_step` takes `marketing_requests … FOR UPDATE` first and both of its request UPDATEs carry `AND status = 'pending_approval'`; the refusal `marketing_request_not_pending` maps to the pre-check’s own 409. `cancelMarketingRequest` goes through `phx_cancel_marketing_request` (compare-and-set on the status read, then every `current`/`pending` non-CC rung → `skipped`, then — since 19 Nov 2026, the 5-argument form in `20261119145916` — its audit row, in the same transaction). A re-definition of the decide function copies the latest body and keeps both guards. Pinned by `tests/direct-orders-and-marketing-atomic.test.ts`.
- 🔒 **A PRODUCT WATCHER FOLLOWS EVERY REQUEST FOR HIS NAMED PRODUCTS WITH NO RUNG — HE READS, IS TOLD AND COMMENTS, AND NEVER DECIDES** (owner, 2026-11-19: Ahmed SharafEldeen, Guamusin and Ivyronc only — "he can not approve or reject but he can comment"). The list is `MARKETING_PRODUCT_WATCHERS` in `src/lib/marketing-requests/product-watchers.ts`, BY HR ID, never his product scope (that holds two more codes) and never a role. He gets the full Case File (arm `product_watcher`, conversation mounted), every assigned/returned/approved/rejected/completed move as an in-app, Telegram and push notice in watcher wording (never "needs your approval", never the due-date or overdue reminders, never email), every conversation message, and Watched Products (`/employee-portals/marketing-requests/watching`, drafts excluded, history included). Never give a watcher an approval step to "fix" his access. Pinned by `tests/marketing-product-watchers.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
