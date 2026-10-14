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
- 🔴 [a rep who changes seat loses his list when his assignments predate the move](a-rep-who-changes-seat-loses-his-list-when-his-assignments-predate-the-move.md) - Mostafa Saied (B-177) had 0 customers and no Validate button after Anti-Infective -> Pedia on 1 Oct; not a team start. Fixed 14 Oct 2026 by closing his 183 rows at 30 Sep and reopening them from 1 Oct.

















- [the CNS line has its own identity, as a repo skill](cns-identity.md) - `.claude/skills/cns-identity/`, Tebofortin the hero, four named differences from anti-infective; its closing sheet carries three BUSINESS laws inside a design file - it reports and never computes, the units column is never totalled, and the white foot obeys the ink rule even though the green field does not.
- 🔴 [two customers with the same name on one seat are NOT duplicates](same-named-customers-on-one-seat-are-not-duplicates.md) - the owner confirmed namesakes on 2026-10-13 (two أحمد محمد الصباغ, two أحمد رمضان راضي); identity is the iReports360 contact id, brick and town, never the name, and a far visit is NEVER excused because a same-named row's door is nearer - that cleared 4 of 39 far visits wrongly.
- 🔴 [a mailbox window makes a series look YOUNGER than it is](a-mailbox-window-makes-a-series-look-younger-than-it-is.md) - the closing series looked like April 2025 because omar.anwar INBOX is a rolling 10,000-msg window; the CEO mailbox Sent holds it back to Jul 2020 and sell-out data to Jun 2015. Date a series from the DEEPEST mailbox Sent folder, and from whoever RECEIVED it.
- [a hard-coded 7-Zip path silently skipped every archive](a-hardcoded-7zip-path-silently-skipped-every-archive.md) - harvest.mjs named a 7z.exe that does not exist, so 21 archives never extracted and 2016 looked lost; use the scoop `7z` shim, decode registers as cp1256, and search bare-subject forwards the sales-term index misses.
- 🔴 [Sato 2015 sales sit in TWO statements](sato-2015-sales-sit-in-two-statements.md) - the June 2015 "حساب ساتو فارما" (59,937) is own-label Clerovate ONLY; promoted Marcyrl sales are the Sep 2015 commission sheet (283,029). Mid-2015 team = 28 reps (detailing plan divides targets by 28).
- 🔴 [Sato = THREE promoted lines; Head Office is not a line](sato-has-three-promoted-lines-head-office-is-not-a-line.md) - CNS, Anti Infective, Pedia; Lacto Basic, Satoslim, Royanoxicam are non-promoted products (owner, 13 Oct 2026). Never write "four lines".
- [branding pieces are charts, not paragraphs](branding-pieces-are-charts-not-paragraphs.md) - profile/deck/LinkedIn: graphs, charts, then-vs-now comparisons, catchy, little text (owner, 13 Oct 2026).
- 🔴 [the offer letter, the candidate and the employee are kept in step by FOUR doors](offer-letter-candidate-and-employee-are-kept-in-step-by-three-doors.md) - HR Add Employee from a letter, the joining form, "declined offer" on the Master, and a letter marked declined by hand; the candidate is found ONLY through the letter's pointer, never by name; the overview's candidate tiles count the POOL and Hired counts the Master, never the applications half (owner, 14 Oct 2026).
- [owner sets 2026 yearly sales at 850 M and top rep pay at 21,500](owner-sets-2026-yearly-sales-at-850m-and-top-rep-pay-at-21500.md) - profile figures: 700 M Lacto + 100 M Marcyrl (outsourced) + 50 M Sato products; does not reconcile with Phoenix January-September (52.8 M a month), so pages 4 and 5 still disagree until he chooses a basis (owner, 14 Oct 2026).
- [cost-cuts 14 Oct 2026: six decisions](cost-cuts-2026-10-14-six-decisions.md) - remote-check every-push REVERTED to new-test-file pushes only (his word; the CI-box reason was wrong, CI is hosted since 30 Sep); same-module PR hold C18; Staging Branch Sync deleted; Railway staging app retired; Synthetic one clock 6/day; Headwind heap -Xmx768m. Folding the sync saves ~$0 and remote-check is capped ~$28/mo — both corrected.
- [Pedia new-hire deck: company first, then Pedia policies, Two Parts pay only](new-hire-deck-is-company-first-then-pedia-policies-with-two-parts-pay-only.md) - nine slides: the full profile condensed into six, then salary, incentive rule and curve; never mention One Part or two pay modes (owner, 14 Oct 2026).
