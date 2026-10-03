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
- [NEVER close a dev server until he says](never-stop-a-dev-server-at-all-until-he-says.md) - owner 2026-10-03 WITHDRAWS the "I may stop one I started myself" carve-out; a background one still dies at its own timeout, so SAY SO and restart rather than let him think a session closed it.
- [the delete guard reads a variable named RM as `rm`](the-delete-guard-reads-a-variable-named-rm-as-rm.md) - script text with `RM` + a .pdf path in one Bash command is refused as a delete; write scripts with Write, run with a bare call, and save a new PDF version under a NEW name.
- [Oct 2026 slowness = thinking level + model, NOT memory](desktop-slowness-oct-2026-is-thinking-level-and-model-not-memory.md) - Max is 4-5 min per instruction (slowest quarter 10-13 min); per step Opus 5.5 4.3 s, Opus 5 6.1 s, Opus 4.8 10.1 s. Rules are 26k tokens, smaller than mid-Sep. The 800k window was the USAGE drain (+35-60% per instruction); he set it to 400k and new chats to Opus 5 + High on 3 Oct.
- [the pulsing alarm badges cost a CPU core — the glow is a box-shadow](the-pulsing-alarm-badges-cost-a-cpu-core-because-the-glow-is-a-box-shadow.md) - idle tab ~1 core; measured 116-137% vs 14-17% still, 26-52% if the glow moves to transform+opacity. The continuous pulse is HIS decision: change how it is drawn, never stop it.
- [a pharmacy needs NO validation; its visit is logged normally](a-pharmacy-check-in-counts-as-the-pharmacy-visit.md) - owner 2026-10-03: no plan, reason or approval, and a pharmacy named on a doctor visit counts as its visit. 11 backfilled. Both migrations (20261003174346, 20261003175653) are on staging AND production; the linked visit is single with no stock answers. Code: PR #5257.
- [a PM (doctor) validation can NEVER be held, so rejecting one is by hand](a-pm-validation-can-never-be-held-so-rejecting-one-is-by-hand.md) - the Google check is AM-only, so no review row exists: insert one, then `phoenix_crm_decide_validation_review`, then restamp the visits yourself (the RPC does not).
- [a REFUSED CRM save is traceable ONLY in the upload slot](a-refused-crm-save-is-traceable-only-in-the-upload-slot.md) - `location_integrity` is written only on a SAVE, so "nothing recorded since X" is wrong: read `phoenix_crm_photo_uploads`/`_voice_uploads` with `used_at` NULL + bytes in `storage.objects`. Bytes prove camera/mic/upload/network/session all worked, so the refusal is SERVER-side. B-130 left 18 such rows 16:12-18:47 on 2026-10-03; cause was #5234's 100 m gate merging 11:24, 14 min after her last save.
- [a CRM validation is checked against GOOGLE MAPS, never iReports360](a-phoenix-crm-validation-is-checked-against-google-maps-never-ireports360.md) - owner 2026-10-03: step 1 confirm the Google listing is the SAME account, step 2 compare the point to its pin; "forget the ireport data, never compare with it now". A name can be stale (Al-Menshawy → new Tanta General, Sibirai).
