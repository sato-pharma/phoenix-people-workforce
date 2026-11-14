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
- 🔴 Email: [NEVER bulk/test sends](never-fire-bulk-emails-ever.md)·[both cuts LIVE](email-inventory-audit-2026-08-13.md) - probation email OFF **except Day 30/60/75 → B-10 ALONE, no CC (since 2026-10-20; `.claude/rules/probation.md`)**·[every automated email ALSO pings his Telegram](every-automated-email-also-mirrors-to-the-admin-telegram.md) - a test send reaches him.

## Owner's rules (don't "fix" back)
- 🔴 [the Next step box is NOT a notepad](the-next-step-box-must-not-manufacture-the-next-task.md) - he SENDS what is in it. Never a task Claude invented; a shipped feature is DONE.
- 🔴 [hand HIM PowerShell, never bash](commands-handed-to-the-owner-must-be-powershell.md) - his Terminal rejects `&&` before anything runs.
- 🔴 [fix means fix - no unrequested work](fix-means-fix-no-unrequested-work.md)
- 🔴 [NEVER approve for the CEO](never-approve-for-the-ceo.md) - he INTERRUPTED his own "approve them both". The work up to the decision is mine; the decision is his.

## Traps that bite any session
- 🔴 **Never re-add a module fact here or to `AGENTS.md`** - it goes in that module's `.claude/rules/<module>.md`; session traps live in §2.1's clusters.


## Inbox — new notes land here
- [CRM validation audit: his four decisions](crm-validation-audit-owner-decisions-2026-11-14.md) - 14 Nov 2026: approve-after-all stops and says why; validated at his own clinic he stays in; the night re-read records only; three clean-ups run, pre-image in `phoenix_crm_backup_20261114`.
- [DR-02 one plan store = Phoenix CRM](dr-02-phoenix-crm-is-the-one-plan-store.md) - owner 14 Nov 2026: the older weekly Plans tab (employee_plan_*) becomes read-only history; every plan reader goes through Phoenix CRM plans.
- [the secrets sync put the old GitHub dispatch token back](the-secrets-sync-put-the-old-github-dispatch-token-back.md) - 13 Nov 2026: the sync copied a stale GitHub secret over production, stranding the workflow watch and synthetic journeys. GitHub's 403 lifetime message was a symptom; check the sync run first.
- [Maps Static cap = 300 a day](maps-static-daily-cap-is-300-on-phoenix-hr-2026.md) - set 14 Nov 2026 on Google project phoenix-hr-2026 (his choice); no longer "his click"; read it back with gcloud.
- [Groq Inference Zero Data Retention is ON](groq-inference-zero-data-retention-is-on.md) - turned on 14 Nov 2026 on the account holding `phoenix-crm-voice` (his choice); Global, Batch and Fine-tuning left as they were; the integrations list still says "Not verified".
- [the spare laptop changes address, it is not off](the-spare-laptop-changes-address-it-is-not-off.md) - `.53` ↔ `.60` (8 and 14 Nov 2026); the spare scripts now find it themselves (`~/.claude/scripts/spare-address.ps1`, by host key); never write its address anywhere, and "it is off" is only true when the finder exits 1.
- [the worker follows the website; phoenix-cron holds a dead secret](worker-follows-the-website-and-phoenix-cron-holds-a-dead-secret.md) - 14 Nov 2026 (his choices): the worker's 26 plain copies became links, only its role and poller switch are its own; `phoenix-cron`'s `CRON_SECRET` is a placeholder on purpose, never set a variable there without `--skip-deploys`.


















Put each new memory note's pointer here, one line. The fold (`node scripts/module-memory/fold.mjs --apply`, three times a day — 09:00, 15:00 and 21:00 Cairo) files it under its module in ONE PR; once that merges, the next fold removes the line.




























