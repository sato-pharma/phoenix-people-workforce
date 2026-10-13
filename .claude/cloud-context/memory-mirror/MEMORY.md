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
- [HR premium identity](hr-premium-identity.md) - worn ONLY by the papers he ticked change on 13 Oct 2026 (the rest print as before, `PREMIUM_DRESS`); skill `hr-premium-identity`. Government forms stay as issued.

- [a `<rev>:<dot-path>` reads as ABSENT on main](a-rev-colon-dot-path-reads-as-absent-on-main.md) - MSYS mangles the colon; ask with `git ls-tree <rev> <path>`.

- 🔴 [production's signature is his ORIGINAL SCAN](the-approved-signature-master-is-the-svg-in-downloads.md) - he revoked the rebuilt one 12 Oct 2026; never put redrawn signature artwork there again.

- 🔴 [a page redirect can answer 200 with a meta-refresh](a-page-redirect-answers-200-with-a-meta-refresh.md) - a status-only role sweep reads that denial as access granted; read the refresh target and a page marker too.

- [a rescue branch's real size is measured AFTER merging main in](a-rescue-branchs-real-size-is-measured-after-merging-main-in.md) - 49 files/4,959 insertions became 12/332, and the remainder was still the discarded architecture.

- 🔴 [a worktree can be held by his phx-live sync](a-worktree-can-be-held-by-his-phx-live-sync.md) - check the `--folder` match AND `live-ctl.sh status` before retiring one; a missing `session.lock` in an `_wt-*` folder never proves the session left.

- [a UTF-8 em dash breaks a PowerShell 5.1 script](a-utf8-em-dash-breaks-a-powershell-5-1-script.md) - a BOM-less `.ps1` is read as ANSI, so one em dash is a ParserError; keep scripts ASCII-only.



- 🔴 [a helper-wrapped RPC call is invisible to the obvious grep](a-helper-wrapped-rpc-call-is-invisible-to-the-obvious-grep.md) - `rpc("current_…")` found 0 callers and `pg_policy` found 0 policies, yet phase24 calls five of the six helpers as a signed-in user through `rpcValue(client, name)`; a zero from a call-shape grep is evidence about the shape, not about callers.

- 🔴 [a deploy watcher keyed to ONE sha goes stale on the next merge](a-deploy-watcher-keyed-to-one-sha-goes-stale-on-the-next-merge.md) - `main` moves in minutes here; poll the live `origin/main` and test ancestry, and report the revision actually read.

Put each new memory note's pointer here, one line. The fold (`node scripts/module-memory/fold.mjs --apply`, three times a day — 09:00, 15:00 and 21:00 Cairo) files it under its module in ONE PR; once that merges, the next fold removes the line.

- 🔴 [the Ibn Sina LACTO MISR export is a SECOND supplier feed in the IS-S template](the-ibn-sina-lacto-misr-export-is-a-second-supplier-feed-in-the-is-s-template.md) - never upload it under `IS-S`: the next Sato week then de-cumulates against a sheet with no Sato products and double-counts the month.

- 🔴 [a governorate's city is ONE brick in ONE area](qena-city-is-qena-2-on-every-line.md) - مدينة قنا is one brick in Qena 2 like مدينة سوهاج in Sohag 1; Qena 1 is exactly nine bricks with no city brick, and the fold is by hand because no merge path exists.

- 🔴 [a brick move leaves its rollup files pending with nothing draining them](a-brick-move-leaves-its-rollup-files-pending-with-nothing-draining-them.md) - only an open Database Mapping page drains the queue; two moves sat a full day, so every Qena figure on screen was pre-move.

- [an Overseas address can be cut at the START too](an-overseas-address-is-a-30-character-window-cut-at-both-ends.md) - "قوس قرية" is فاقوس, "فرالدوار" is كفر الدوار; a matcher that forgives only the last word flags correctly mapped pharmacies.

- 🔴 [one clean `git status` called a LIVE worktree idle](one-git-status-read-called-a-live-worktree-idle.md) - retire on CLEAN + QUIET (no tracked file touched for 10 min) + PUSHED; no session in ListAgents may claim the folder, and "files edited 0 min ago" IS a holder.

- 🔴 [431648 is NO LONGER a split twin](431648-is-no-longer-a-split-twin-after-the-qena-city-fold.md) - the Qena city fold put both IS and IS-S on `B209B-4`/UE8; the `sales-imports` line ordering it kept split is stale, and re-splitting it would undo his ruling.

- 🔴 [a red shard shows ONE cause and hides the rest](a-shard-aborts-at-its-first-failure-so-the-second-cause-is-invisible.md) - it aborts at its first failing test, so read BOTH shards' FAIL lines; a new `app/api` route is red from its first commit until it is in the access registry.

- [a bash `GROUPS=( … )` array is silently ignored](assigning-to-groups-in-bash-is-silently-ignored.md) - it is bash's own array of the user's group ids, so the sweep looped once over `197609` and every hit read 000; rename it `PAGE_GROUPS`.

- 🔴 [both new IS-L depots are RULED, not inferred](the-two-new-is-l-depots-are-ruled-not-inferred.md) - `04` Platform Delta stays Gharbia 1 (Tanta), `A2` Assiut 2 Warehouse takes Assuit 2 (`UE4`), his word 13 Oct 2026; the "warehouse = region, no area" rows are not a policy, so ask him for the next unseen depot's area and ship it as a migration.

- 🔴 [the 521/520/525 bursts are production Postgres CRASH-RESTARTING, not Cloudflare](a-production-postgres-crash-restart-wears-cloudflare-codes.md) - twice in three days (10 Oct 11:05:48, 12 Oct 19:04:50 Cairo), each "not properly shut down" with no PANIC; prove it with `pg_postmaster_start_time()` and `cron.job_run_details`' `server restarted`, never with the edge codes, and never lengthen the retry to ride it out.

- [a long bash heredoc is truncated and bash blames EOF](a-long-bash-heredoc-is-truncated-and-bash-blames-eof.md) - past roughly 90 lines the tail never arrives, so `unexpected EOF` reads as a quoting bug in the content; long file content goes through Write.

- 🔴 [a SECOND live feed link silently pauses the weekly token rotation](a-second-live-feed-link-silently-pauses-the-weekly-token-rotation.md) - all three `*-rotate-sheet-token` jobs refuse rather than rotate, cron-job.org still shows a green 200, and only `job_heartbeats.last_detail` says why; keep the link with the live `last_accessed_at`.

- 🔴 [a date inside a note is not the note's subject](a-date-inside-a-note-is-not-the-notes-subject.md) - the Luxor `line_area_map` notes flagged as documenting the superseded 2026-09-11 union were recording its REVERSAL, byte-identical to the migration (`bf6f192e`, 387 chars); digest the prose before calling a live record stale.

- 🔴 [a roll-up can close your PR and de-register its worktree mid-work](a-rollup-can-close-your-pr-and-de-register-its-worktree-mid-work.md) - the pushed branch is what survives (`git ls-remote`); recover with `new-session.mjs --from origin/<branch>`, and prove each merge conflict with `git ls-tree` before taking `--ours`.
