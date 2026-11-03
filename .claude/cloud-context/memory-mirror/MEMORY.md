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
- [Salma Sabry's record made from her letter, 2026-11-03](salma-sabry-record-made-from-the-letter-2026-11-03.md) - his choice; identity and pay blank on purpose, her joining form is closed.
- [The customer merge keeps refusing different lines, 2026-11-03](customer-merge-keeps-refusing-different-lines.md) - his choice by multiple choice; never offer to widen it without a real pair from him.
- [Visit retry: post-deploy reads owed, 3 Nov 2026](visit-retry-post-deploy-reads-owed-2026-11-03.md) - first-day resend log, reminders heartbeat, new flag count; the real-browser press ran on staging and pull request 34 carries its two fixes.
- [A real-browser press can run on a GitHub runner](a-real-browser-press-can-run-on-a-github-runner.md) - one-off job on a throwaway branch, staging only, when the laptop's memory floor stops a dev server.
- [Stand-ins and the cache server declined, 2026-11-03](stand-ins-and-cache-server-declined-2026-11-03.md) - his decision in plain-word questions; never offer either again without a new measured need.
- [ROI customer double count measured at zero, 2026-11-03](roi-customer-double-count-measured-zero-2026-11-03.md) - EGP 0 of 88,051.56 inflated; request_count cannot detect it, count one row_id per customer.
- [Staging's demo identities replaced with real data, 2026-11-03](staging-employees-hold-demo-identities-2026-11-03.md) - his choice; pre-images in `staging_reconcile_backup_20261103`; a later drift alert is a real HR change and refreshing stays his decision.
- [The home's open times on Small, 2026-11-03](portal-home-speed-on-small-before-medium-2026-11-03.md) - the figures to beat after Medium: 2.69 s median, 41% over 3 s, the slow tail unchanged; how to count an open.
- [A hire date's history survives only in probation reminders, 2026-11-03](hire-date-history-survives-only-in-probation-reminders.md) - saves leave no audit row; Medical Reps only; a date moved away and back leaves no live reminders.
- [A held pull request must be a draft](a-held-pull-request-must-be-a-draft.md) - a hold said in one chat cannot stop another session's box offering the merge; 54 merged that way on 3 Nov.
- [A seat starts on the job offer's date, 2026-11-03](seat-start-follows-the-job-offer-2026-11-03.md) - his ruling; 40 rows corrected with a backup; Toka Zaki and Mahmoud Khaled still owed from 8 Nov, when moving them changes no credit.
- [A runner press must wait for hydration before it clicks](a-runner-press-must-wait-for-hydration-before-it-clicks.md) - a click with no request in the server log and no page error means the press beat the script, not that the feature is broken.
- [Archive refs did not move to the new repository, 2026-11-03](archive-refs-did-not-move-to-the-new-repository-2026-11-03.md) - 1,721 refs and 3,167 commits exist on this one disk only; 131 tips are not accounted for on main; pushing them is his word.


















Put each new memory note's pointer here, one line. The fold (`node scripts/module-memory/fold.mjs --apply`, three times a day — 09:00, 15:00 and 21:00 Cairo) files it under its module in ONE PR; once that merges, the next fold removes the line.




























