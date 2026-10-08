# Memory Index

**Module memory holds everything module-specific** — `.claude/rules/<module>.md` in the repo, loaded when a session works in that module (AGENTS.md §2.2, docs/module-memory.md). This index holds what is true everywhere, plus the inbox. Nothing is trimmed from it any more.

**Hooks only - the FILE is the fact. Rules: `AGENTS.md` §2.2.**
- [ARCHIVE](MEMORY-ARCHIVE.md) - the pre-2026-10-02 archive; every note in it is now filed in a module.

## 🥇 RULE #1 - never trim, never forget
- 🔴 [**`B-10` is the OWNER himself**](b-10-is-the-owner-himself.md) - sole Super Admin, so EVERY `decided_by` is his. Never advise him to "tell B-10" or notify him of his own decisions.
- 🔴 [**Monthly Closing** = the ONLY sales+target truth](sos-monthly-closing-is-the-only-sales-truth.md) - every surface reads ITS sales AND target (targets confirmed 2026-09-27); Weekly excluded; Marketing ROI the ONE exception.
- 🔒 [Head Office is in NEITHER weekly NOR monthly - unmapped is CORRECT](head-office-products-are-not-tracked-weekly-golden-rule.md) - tracked = **CNS · Anti Infective · Pedia** ONLY; HO is **90% of weekly VALUE**. NEVER flag or map it; ALWAYS filter before quoting a number.
- 🔒 [Lacto: family NAMES split; family_code still shared](lacto-advanced-and-basic-share-family-and-family-code.md) - `Lacto Advanced` (Pedia) + `Lacto Basic` (HO); no bare `Lacto`. **Both keep family_code=`LA` DELIBERATELY** - the direct-order basket allow-list; tidying it un-combines the order.
- 🔴 [NEVER add units of different products/concentrations](units-of-different-products-are-never-added.md) - a unit total is valid for ONE product_code only; above that aggregate by **VALUE**. Same for TARGET units.
- 🔴 [Head Office is ABSENT from `phx_monthly_achievement`](head-office-sales-are-absent-from-phx-monthly-achievement.md) - no rows ≠ zero: it rendered real July units as 0. Royanoxicam DOES return (line NULL), Lacto Basic and Satoslim do not. `direct_value` is NOT the sales value; HO has NO price, units only.
- 🔴 Pre-July: [reconcile per customer×product](closing-reconcile-per-customer-product-not-area-pre-july.md)·[CURRENT price + backfill targets](closing-pre-july-revalue-and-backfill-targets-at-phoenix-price.md)
- 🔴 [a price fix RESTATES every published month](a-price-fix-silently-restates-every-published-closing.md) - INTENDED; drift sees VALUE now, price outside the lock. **July AI stays as published (owner).**·🔒 [the matrix can NEVER fit; summary ships BESIDE it](monthly-closing-matrix-cannot-fit.md) - leave the scroll.

## In flight
- 🔴 Email: [NEVER bulk/test sends](never-fire-bulk-emails-ever.md)·[both cuts LIVE](email-inventory-audit-2026-08-13.md) - probation email OFF **except Day 30/60/75 → Yasmeena, cc B-10**·[every automated email ALSO pings his Telegram](every-automated-email-also-mirrors-to-the-admin-telegram.md) - a test send reaches him.

## Owner's rules (don't "fix" back)
- 🔴 [the Next step box is NOT a notepad](the-next-step-box-must-not-manufacture-the-next-task.md) - he SENDS what is in it. Never a task Claude invented; a shipped feature is DONE.
- 🔴 [hand HIM PowerShell, never bash](commands-handed-to-the-owner-must-be-powershell.md) - his Terminal rejects `&&` before anything runs.
- 🔴 [fix means fix - no unrequested work](fix-means-fix-no-unrequested-work.md)
- 🔴 [NEVER approve for the CEO](never-approve-for-the-ceo.md) - he INTERRUPTED his own "approve them both". The work up to the decision is mine; the decision is his.

## Traps that bite any session
- 🔴 **Never re-add a module fact here or to `AGENTS.md`** - it goes in that module's `.claude/rules/<module>.md`; session traps live in §2.1's clusters.


## Inbox — new notes land here



Put each new memory note's pointer here, one line. The fold (`node scripts/module-memory/fold.mjs --apply`, three times a day — 09:00, 15:00 and 21:00 Cairo) files it under its module in ONE PR; once that merges, the next fold removes the line.
- [`employee_hr_id_compact` is LOWERCASE, so an `upper()` join to `salary_records` matches nothing](employee-hr-id-compact-is-lowercase-so-upper-joins-nothing.md) — every payslip value then reads null, which looks exactly like "not one EGP was paid"; prove a money join on a row you know was paid.
- [Another session's roll-up can CLOSE your open PR as superseded](another-sessions-rollup-can-close-your-open-pr-as-superseded.md) — `state: CLOSED` with a null merge commit, yet the work shipped inside its roll-up; verify by file CONTENT against `origin/main` and never re-open or re-merge.
- [A 95%-idle disk does NOT mean the box is not paging](disk-idle-is-not-evidence-against-paging.md) — `Memory\Pages Input/sec` is the only test and read 9,447/sec while the disk reported idle; this corrects the 2026-09-17 inference. `node scripts/slow-audit.mjs`.
- [A skipped CI step is `0001-01-01`, not null](a-skipped-ci-step-is-0001-01-01-not-null.md) — subtracting it yields ~63 billion seconds, so max-by-duration names the step that never ran as the job's dominant one; guard jobs as well as steps.
- [Run the AFFECTED tests directly, one node process](run-the-affected-tests-directly-instead-of-paying-a-ci-run-per-red.md) — the suite stops at the first throw, so one CI run names one stale pinned list; `git grep -l <file> -- tests/` is the blast radius.
- [A lagging checkout INVENTS memory orphans](a-lagging-checkout-invents-memory-orphans.md) — `repo-doctor` resolves module reachability from the working tree, and only `AGENTS.md` gets an origin/main rescue; read `git rev-list --count HEAD..origin/main` before believing any ORPHAN line.
- [A declined Supabase MCP apply is not a no](a-declined-supabase-mcp-apply-is-not-a-no.md) — the decline is the TOOL LAYER, not his answer, so do not hammer it; but the direct-SQL fallback `scripts/apply-sql-file.mjs` is NOT one of the two paths AGENTS.md §8 pre-authorizes (MCP servers, `supabase` CLI), so a PRODUCTION run through it needs his explicit word for that migration — and the ledger insert goes INSIDE the SQL file, so one apply does both.
- [Unupstreamed commits can be SUPERSEDED, not missing](unupstreamed-commits-can-be-superseded-not-missing.md) — the doctor asks whether a branch's history is on main, never whether its work is still wanted; read what main does instead before PRing the gap.
