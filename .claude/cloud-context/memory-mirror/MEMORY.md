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
- [A customer-map re-resolve stales a pre-respread Office spread](a-customer-map-re-resolve-stales-a-pre-october-office-spread.md) — `computeOfficeAllocation` is reached only from the Office commit path and `refreshBatchRollups` never calls it, so for a month the respread does NOT cover (August 2026 and earlier, after he moved `OFFICE_RESPREAD_START_PERIOD` to `2026-09`) a re-map fixes the own-sales half and leaves the Office credit stamped on the pre-remap shares; the published-closing drift check cannot see it by construction.
- [epda and mec file nothing in September 2026](epda-and-mec-file-nothing-in-september-2026.md) — his "ebda and mec are not comming this month" (2026-10-09), so September is COMPLETE with 15 books; declared in `SOURCE_QUIET_PERIODS` (PR 5696), period-scoped so October expects both again, the data outvotes it, and the audit banner still counts them absent on purpose.
- [`rollup-prs.mjs` calls a protected file by filename PREFIX](rollup-prs-protected-file-test-is-a-filename-prefix.md) — `startsWith('src/lib/sales/office-allocation')` labelled PR 5694 "protected: the Office golden rule" with the locked file untouched, and a peer was about to tell him so; check the changed-file list against the EXACT path before repeating that label.
- [A new source-pinning test must use the shared comment lexer](a-new-source-pinning-test-must-use-the-shared-comment-lexer.md) — a line-wise comment strip (`.split("\n").filter(...)`) is refused by `tests/comment-strip-ratchet.test.ts` in the required `validate` job, which named both sites on PR 5700 after burning 5m34s at the END of a 977-test shard; call `stripComments` from `tests/support/comment-strip.ts`, then re-break each pin to prove it still fires.
- [A dotAll regex flag is refused by the ES2017 target](a-dotall-regex-flag-is-refused-by-the-es2017-target.md) — `/…/s` is `error TS1501` against `tsconfig.json`'s `"target": "ES2017"` and reddens `checks` in ~80s, which no local run can warn you about since a local typecheck is denied; write `[\s\S]` or a class that already crosses newlines, and never raise the target.
- [Zeroing `is_bonus` turns free goods into sales](zeroing-is-bonus-turns-free-goods-into-sales.md) — the mechanism (a cleared flag column passes silently and makes free goods sales), and his 2026-10-09 ruling "neglect th bonus coloumn": September EPDA-BULK is FINAL at 11,398 units / Ivyronc 6,736 — never fix it back to 9,723, and the free-goods rule still holds everywhere else.
- [A line-scoped re-resolve leaves the other lines' contradictions behind](a-line-scoped-re-resolve-leaves-the-other-lines-contradictions.md) — `--line=cns` selects only pairs wrong on CNS, so September read 0 CNS contradictions while the same repaired batch still held 91 Pedia rows (29,230.88 EGP) and 58 Anti Infective (10,955.80); re-ask the count grouped by `official_line`, and note `validation_state` is `'valid'`, not `'validated'`.
