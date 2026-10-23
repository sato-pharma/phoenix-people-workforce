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




























- [launcher 6.48 combined is the live fleet version](launcher-6-48-combined-shipped-to-the-fleet.md) - 23 Oct: superset of periodic location (6.46) + RustDesk-pump-on-open + the Sato Pharma lock-screen label; shipped via Fly to version row 10045 in place, superseding 6.46 and the never-shipped 6.47; cert unchanged (no re-enroll); manifest has MY_PACKAGE_REPLACED.
- [the HR Operations Specialist keeps the Resignations tab Export](hr-ops-specialist-keeps-the-resignations-tab-export.md) - owner dropped the 20 Oct "exports nothing" fix on 2026-10-23; never re-ship f54b877aa from codex/hr-ops-specialist-jd.
- 🔴 [the next DATABASE PR carries the 15 Oct account-connector rule correction](carry-the-15-oct-account-connector-rule-correction.md) - database.md still says the connector runs declined SQL; it answered -32600 on 15 Oct. Take 61324ccd5's line, minus "his word to give"; never a PR alone.
- 🔴 [the 22 Oct stall was four database-machine restarts](the-22-oct-stall-was-four-database-machine-restarts.md) - 4 hard restarts 11:30–14:25 Cairo while swapping ~5 GB on 2 GB RAM; heaviest load the CRM unified views, not Closing. Start any "DB was slow" at `database_restarts` + swap.
- 🔴 [a CI Build that died at "Collecting page data" was the runner running out of memory — FIXED by #6282](ci-build-dies-oom-on-the-8gb-github-runner.md) - 2 CPU / 7.9 GB / 3 GB swap ubuntu-latest, exit 137 "Killed" 23 Oct; #6282 split the CI build (compile then generate) + 6 GB swap, live 23 Oct 05:12 Cairo; never put one `pnpm run build` back.
- [Satoslim has no remote and is left alone](satoslim-has-no-remote-and-is-left-alone.md) - Gawishhh303/satoslim-tracker is gone, the rescue branch is local-only; owner said "Leave it" 2026-10-23 — never re-raise.
- [the Headwind admin API is behind Cloudflare Access on mdm-console](headwind-admin-api-is-behind-cloudflare-access-on-mdm-console.md) - a login that returns HTTP 200 text/html with a cf-ray header is the Access sign-in page, NOT a bad/rotated password; every admin call needs CF-Access-Client-Id/Secret from HEADWIND_MDM_ACCESS_CLIENT_ID/SECRET (in the phoenix-people-workforce Railway env); the device sync endpoint stays open.
- [whatsapp.com refuses Railway — the APK is copied onto the disk from the laptop](whatsapp-refuses-railway-so-the-apk-is-copied-onto-the-disk.md) - the container gets a 49 KB web page; pipe the official APK with `railway ssh -i ~/.ssh/railway_phoenix_ed25519`; never upload big files through mdm-console (Cloudflare 524 / 100 MB cap).
- [PHX-TAB-0002 removed from the Headwind console](phx-tab-0002-removed-from-headwind.md) - deleted 23 Oct 2026 at the owner's word (device id 6, config 3); createNewDevices=false, so if switched on it cannot sync; reuse needs a factory reset and a fresh config-3 enrolment.
- 🔴 [.railway/railway.ts is the only deploy config — a dashboard edit now STAYS](railway-ts-is-the-only-deploy-config-and-a-dashboard-edit-stays.md) - both railway.toml retired 23 Oct (#6286); the daily settings check (#6287) catches drift; every apply needs his word.
- [apply-sql-file is the route for a declined production data write](apply-sql-file-is-the-route-for-a-declined-production-data-write.md) - 23 Oct: the CRM training-day write was declined by the MCP dialog FOUR times with production untouched, then applied first try through `scripts/apply-sql-file.mjs` on his word; stop re-sending after two declines and quote that route instead, with PHOENIX_POOLER_HOST=aws-1.
