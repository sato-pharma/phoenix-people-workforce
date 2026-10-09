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
- [EPDA-BULK is allocated like Office on Pedia from September 2026](epda-bulk-is-allocated-like-office-on-pedia-from-september-2026.md) — his 2026-10-09 rule: spread by each area's share of the OTHER distributors' sales, read-time, Pedia only.
- [Office allocation goes stale when a batch is re-mapped after it](office-allocation-goes-stale-when-a-batch-is-remapped-after-it.md) — upload-time shares put 6,834 of August CNS's 109,719 Office packs (6.23%) in the wrong area; FIXED as a read-time respread from October (PR #5676) and DETECTED on the stored rows by #5679 (merged 17:40 Cairo, 3,698 units / 3.37% at the batch) — two true numbers, never reconciled.
- [EPDA-BULK merged into EPDA-Pharmacies from July 2026](epda-bulk-merged-into-epda-pharmacies-from-july-2026.md) — July/August absence is CORRECT; the 24.16M EGP banner hole is FIXED (#5671, #5674) and September is a real outstanding file.
- [A dot-path after a git `rev:` is mangled by MSYS](a-dot-path-after-a-git-rev-colon-is-mangled-by-msys.md) — git answers "not a valid object" for `origin/main:.claude/...`, which reads as a MISSING FILE and refuses a worktree retirement whose files all landed; export MSYS_NO_PATHCONV=1.
- [The `_wt-reconcile-deductions` folder WAS load-bearing — resolved 9 Oct 2026](the-retired-reconcile-deductions-folder-is-load-bearing.md) — its 68 links are re-pointed at the primary's own `.pnpm` and the folder is gone; keep it for the trap shape, not as a live do-not-delete, and repo-doctor proves the question itself since PR 5672.
- [July 2026 is CLOSED — its three "over-charges" are his OWN inline-typed figures](july-2026-has-three-over-charges-nobody-approved.md) — proven from the audit log (p2_vacation saved inline 8 Aug 02:03, 11 rows, 7,362.08 matching the sheet); the nine Finger Print rows are all already adjudicated in docs/, and Sameh is a held row, not a shortfall.
- [Prove a husk's junction is not load-bearing BEFORE deleting it](prove-a-husks-junction-is-not-load-bearing-before-deleting-it.md) — scan the primary's 68 package links for the folder's name in their TARGET and assert broken=0; an entry count reads 64/1,000 unchanged while every target dangles.
- [A rule that moves 0.00 EGP may just have no upload yet](a-closing-rule-that-moves-zero-may-simply-have-no-upload-yet.md) — Pedia September 2026 was mid-upload with six books missing (Marcyrl, epda, EPDA-Pharmacies, Ibn sina, mec, Direct), so the EPDA-BULK spread had no input, not no effect.
- [Publishing ONE line freezes the whole period's store-split net](publishing-one-line-freezes-the-whole-periods-store-split-net.md) — deliberate per PR 4848; 2026-09 is 1,030,551.19 EGP out of date (CNS 221,712.21) with Anti Infective alone published, the units-based drift check cannot see any of it, and his "rebuild the September store split when Marcyrl's Office book lands" authorises it on an upload — five books (`MC`, `Office`, `DIRECT`, `EP`, `EP-PHS`) are still out.
- [A failed read that returns null looks like a row that never existed](a-failed-read-that-returns-null-looks-like-a-row-that-never-existed.md) — a timeout came back as `null`, the same value a missing publication row returns, so the board row rendered one sentence shorter and nothing went amber.
- [A source-reading test sliced to the registry measures its neighbours](a-source-reading-test-sliced-to-the-registry-measures-its-neighbours.md) — the phoenix-crm needs-you test counted 7 guards instead of 6 because an unrelated adapter was appended inside its window.
