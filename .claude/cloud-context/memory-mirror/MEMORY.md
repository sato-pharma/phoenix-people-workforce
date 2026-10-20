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




























- [employee laptops are controlled from MeshCentral on the Alienware](meshcentral-laptop-control-server-on-the-alienware.md) - self-hosted at `C:\Program Files\Open Source\MeshCentral`, admin `it.satopharma`, group Laptops; public at https://mesh.satopharma.com through the `cloudflared-mesh` Cloudflare tunnel since 19 Oct 2026. 🔴 A `lanonly` server writes `MeshServer=local` into the installer, so that agent can NEVER be reached off its own subnet — only a new installer fixes it (Yasmeena's HP EliteBook was stranded that way). Claude cannot restart Windows services here.
- [heavy production checks wait until after 17:00 Cairo](heavy-production-checks-wait-until-after-17-cairo.md) - owner 2026-10-19: a multi-second query, parity view or temp-view check on production runs after 17:00 (or before 09:00); on 19 Oct 15:19-15:27 Cairo every Supabase call timed out in three waves while the CRM entry-days checks ran, and the failed app_error_events insert was a casualty, not the cause.
- [the Training Manager chair reports to the CEO](the-training-manager-chair-reports-to-the-ceo.md) - owner 2026-10-19: open vacancy 394, the open requisition and the offer job title all moved A-9 / Marketing Manager -> AA / Chief Executive Officer (Anwar Gaweesh); they must move together or the hire never auto-fills the vacancy; two offers sent earlier that day still say Marketing Manager / General Manager and were not edited.
- [the release gate lets Railway build while CI runs](the-release-gate-lets-railway-build-while-ci-runs.md) - owner 2026-10-19 "speed up the Railway deploy ... faster and costs less": `/api/readyz` answers 503 until ci.yml's `release-gate` job records the commit in `release_gates`; Wait for CI is OFF on the APP only since 19 Oct (the worker has no healthcheck, so it is not gated and stays ON); never both gates off, `PHOENIX_RELEASE_GATE=off` is the emergency word, image-in-CI refused.
- [the Hetzner CI box is retired; CI is GitHub-hosted and parallel](the-hetzner-ci-box-is-retired-ci-is-github-hosted-and-parallel.md) - owner 2026-10-19 (PR 6163): six parallel ci.yml jobs, remote-check reads the PR run, pre-push remote-check test gone, phx-live/phx-preview dead, runner deregistered; never route CI to our own machine or pitch hardware.
- [GitHub Actions status can freeze while the jobs actually run](github-actions-status-can-freeze-while-the-jobs-actually-run.md) - 2026-10-19 incident: PR checks pending 30+ min though every job log ended clean and the coverage proof read 2500 of 2500; tell a platform stall from the account by status page, job logs/artifacts, repo-wide in_progress count and start lag; never merge on logs alone.
