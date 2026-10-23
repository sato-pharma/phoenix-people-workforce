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
- 🔴 [the 22 Oct stall was four database-machine restarts](the-22-oct-stall-was-four-database-machine-restarts.md) - 4 hard restarts 11:30–14:25 Cairo while swapping ~5 GB on 2 GB RAM; heaviest load the CRM unified views, not Closing. Start any "DB was slow" at `database_restarts` + swap.
- 🔴 [a CI Build that died at "Collecting page data" was the runner running out of memory — FIXED by #6282](ci-build-dies-oom-on-the-8gb-github-runner.md) - 2 CPU / 7.9 GB / 3 GB swap ubuntu-latest, exit 137 "Killed" 23 Oct; #6282 split the CI build (compile then generate) + 6 GB swap, live 23 Oct 05:12 Cairo; never put one `pnpm run build` back.
- [Satoslim has no remote and is left alone](satoslim-has-no-remote-and-is-left-alone.md) - Gawishhh303/satoslim-tracker is gone, the rescue branch is local-only; owner said "Leave it" 2026-10-23 — never re-raise.
- [the Headwind admin API is behind Cloudflare Access on mdm-console](headwind-admin-api-is-behind-cloudflare-access-on-mdm-console.md) - a login that returns HTTP 200 text/html with a cf-ray header is the Access sign-in page, NOT a bad/rotated password; every admin call needs CF-Access-Client-Id/Secret from HEADWIND_MDM_ACCESS_CLIENT_ID/SECRET (in the phoenix-people-workforce Railway env); the device sync endpoint stays open.
- [whatsapp.com refuses Railway — the APK is copied onto the disk from the laptop](whatsapp-refuses-railway-so-the-apk-is-copied-onto-the-disk.md) - the container gets a 49 KB web page; pipe the official APK with `railway ssh -i ~/.ssh/railway_phoenix_ed25519`; never upload big files through mdm-console (Cloudflare 524 / 100 MB cap).
- 🔴 [the job_leases drift exception is already on main — never write it again](carry-the-job-leases-drift-exception.md) - #6309 carries it (md5(prosrc)=74aee736…, live on production with NO ledger row); the three 23 Oct sweep findings are separate, in open PR #6312; the two local drafts that held both were retired 23 Oct to refs/deleted-branches/codex-job-lease-widen{,2}-20261023.
- [PHX-TAB-0002 removed from the Headwind console](phx-tab-0002-removed-from-headwind.md) - deleted 23 Oct 2026 at the owner's word (device id 6, config 3); createNewDevices=false, so if switched on it cannot sync; reuse needs a factory reset and a fresh config-3 enrolment.
- 🔴 [.railway/railway.ts is the only deploy config — a dashboard edit now STAYS](railway-ts-is-the-only-deploy-config-and-a-dashboard-edit-stays.md) - both railway.toml retired 23 Oct (#6286); the daily settings check (#6287) catches drift; every apply needs his word.
- [apply-sql-file is the route for a declined production data write](apply-sql-file-is-the-route-for-a-declined-production-data-write.md) - 23 Oct: the CRM training-day write was declined by the MCP dialog FOUR times with production untouched, then applied first try through `scripts/apply-sql-file.mjs` on his word; stop re-sending after two declines and quote that route instead, with PHOENIX_POOLER_HOST=aws-1.
- [the error table never says which Needs You source timed out](the-error-table-never-says-which-needs-you-source-timed-out.md) - app_error_events keeps only labels.event (as route) and drops source, hr_id and role; read notification_events.metadata (the delivered digest) to see which sources were lost.
- ["Load failed" is the rep's network, not a CRM fault](load-failed-is-the-reps-network-not-a-crm-fault.md) - 926 iOS + 276 Android + 7 desktop rows since 5 Aug over 62 releases, no context= marker (so nothing caught it, it is the App Router's own RSC fetch), CRM only tops it because that is where reps are; group by device AND page before calling CRM broken.
- [a push that prints "[new branch]" means the PR already merged](a-push-that-prints-new-branch-means-the-pr-already-merged.md) - GitHub deleted the ref on merge and your push recreated it: read the PR by number, prove the trees identical against the squash sha, then `git push --delete` the ref you made; an Auto-fix conflict event can cite a sha that is no longer the head, and a worktree can be pruned out from under you mid-flight.
- 🔴 [the ACKNOWLEDGED_EXCEPTIONS tail conflicts on every parallel append](acknowledged-exceptions-tail-conflicts-on-every-parallel-append.md) - #6310 hit it twice in 20 min on 23 Oct (entry-days cache vs release-gate login vs job leases); keep BOTH sides, prove with `uniq -d`, never "ours"/"theirs" — dropping a side un-acknowledges a live migration and reds the nightly drift check.
- [an Auto-fix conflict event can name a stale head](an-autofix-conflict-event-can-name-a-stale-head.md) - two events for #6310 both judged 5633029157 while the branch was at 3653a1a88 and MERGEABLE; compare the event's head before re-merging, and read BLOCKED+MERGEABLE as "checks unfinished", not a conflict.
- [`gh run view --log` can die with a stream CANCEL and write 0 bytes](gh-run-view-log-dies-with-a-stream-cancel-and-writes-zero-bytes.md) - exit 1 + empty file reads exactly like a job with no errors, and `--log-failed` is also empty mid-run; `gh api repos/OWNER/REPO/actions/jobs/<id>/logs` works. Never pipe the download into grep.
- 🔴 [the January parity window stays refused — his ruling](the-january-parity-window-stays-refused.md) - 2026-01-31 → 2026-03-01 refuses at 338 rows for ever: real visits by two resigned reps (B-111, B-82) that iReports360 no longer serves, all backfilled 13 Sept; owner said "Leave it refused" 23 Oct — never delete them, never build an exemption, never re-raise.
- [#6302's two system_audit migrations: the acknowledgement is on main](carry-the-system-audit-ledger-exceptions.md) - #6319 merged 23 Oct 11:28 Cairo (4009a969f) with both entries; live on production with 0 ledger rows; never write a second copy.
- [one production error got fixed five times in parallel](five-sessions-fixed-one-production-error-in-parallel.md) - 23 Oct, the visit_lifecycle 42703 in #6325/#6327/#6329/#6330/#6319 + an unPR'd sixth; diff the file across every head (all identical bar a comment), keep the copy inside the GREEN roll-up, close the pure duplicates, and COMMENT — never push — on the one carrying unique extra content.
- 🔴 [a rollup SUPERSEDED line is file overlap, never content](rollup-superseded-is-file-overlap-not-content.md) - 23 Oct it marked #6319 and #6321 superseded by #6320, which contained NEITHER acknowledged filename and only touched the same file; grep the superseding branch for the content before closing anything.
- 🔴 [a merge burst stamps earlier production deploys `failure`](a-merge-burst-marks-earlier-production-deploys-failure.md) - 10 merges in 45 min on 23 Oct left two `failure` rows and production on the last SUCCESS for 40 min; tell it from the release gate's silent non-ship by reading `release_gates` for that sha, and note `?environment=production` matches nothing — the name is `Phoenix-HR-Workforce / production`.
- 🔴 [GitHub's CONFLICTING flag goes stale when main moves](githubs-conflicting-flag-goes-stale-when-main-moves.md) - #6302 read DIRTY while `git merge-tree --write-tree` returned 0 conflicts and GitHub re-read MERGEABLE minutes later; never let DIRTY end a wait or start a conflict fix.
- 🔴 [pg_stat_statements ignores your marker comment](pg-stat-statements-ignores-your-marker-comment.md) - the queryid is the PARSE TREE, so a /*before*/ and /*after*/ probe share one row and sum: select `calls` and read the DELTA, never mean_exec_time. Also read `stats_reset` first — on 23 Oct the window opened before that day's two fixes and overstated the CRM doors tenfold.
- [.env.local lost CRON_SECRET — realign FROM Railway production](env-local-lost-cron-secret-realign-from-railway.md) - "CRON_SECRET not found in .env.local" is a missing key, not a rotation: read it from Railway production (service phoenix-people-workforce), assert 64 chars, and prove it against cron-job.org job 8200914, whose Authorization header compares byte-for-byte — a cronjob-sync dry run proves nothing and calling a /api/cron/* route RUNS the job.
- [re-running the system-audit sweep does NOT buzz his phone](re-running-the-system-audit-sweep-does-not-buzz-his-phone.md) - the daily message is idempotent per Cairo day, so a verification re-run's deliveries all come back skipped (measured 23 Oct: candidates 3, delivered 0); the route has no detector filter, GET not POST, through `railway run`; read the proof in `system_audit_detector_runs`, and `system_audit_issues` has no `detector` column — it is `family`.
- 🔴 [captureStallInSentry / PHOENIX-WORKFORCE-6 is the web event-loop freeze alert](captureStallInSentry-is-the-web-event-loop-stall-alert.md) - 168 events 16-23 Oct, but Sentry throttles to 1 per 30 min per container; the real rate is 51 freezes in 13 h (median gap 4 min) in Railway's `event_loop_stall` WARN lines. Not memory, not the CPU limit, not the platform - the web thread itself; 1-2 s bursts in traffic, ~5 s every ~63 min when idle, 14.9 s worst.
- 🔴 [`timings` and `jobs` in the process_health line are ALWAYS empty](the-process-health-timings-and-jobs-windows-are-always-empty.md) - 715 web + 946 worker lines, every one empty: the reporter drains a different module instance from the recorders, so the stall fingerprint is constant and every cause collapses into one Sentry issue. Never read an empty one as "nothing was running".
- [a refused parity window can heal itself](a-refused-parity-window-can-heal-itself.md) - `missing_in_mirror` is a point-in-time count, not a backlog: the 28 Sept–23 Oct window went refuse(8 missing, 4779 extra) at 06:08 to **equal** 7,346=7,346 at 12:05 on 23 Oct with 0 upserted and 0 deleted; re-read a window before planning any repair, and force one by setting its `checked_at` behind every other.
- [namesByHrId cannot replace an hrIdsMatch name lookup](namesbyhrid-cannot-replace-an-hridsmatch-name-lookup.md) - it matches on canonicalHrIdKey ALONE while hrIdsMatch also matches with punctuation stripped (B-10 = B10), so folding one in silently loses names; read a whole names roster instead, and never include leavers - a resignation item is meant to fall back to the stored name.
- 🔴 [the MCP bundle guard is gated repo-wide now, not by nine paths](the-mcp-bundle-guard-only-runs-on-nine-paths.md) - FIXED 23 Oct: `node build.mjs` is a step in ci.yml's `static`, which has no paths filter and which required `checks` needs; phoenix-mcp.yml's 9 paths are still NOT the import graph and mcp-security still gates nothing, so never read its silence as coverage. Cause pattern: a MODULE-LEVEL call retains its default argument's chain to a PRIVATE supabaseRest no module-name stub can reach.
- 🔴 [the dispatcher 90s timeouts are load outliers, not a defect](the-dispatcher-90s-timeouts-are-load-outliers-not-a-defect.md) - all 17 timeouts of 30 Sep-23 Oct fell in ONE 90-minute window on 23 Oct; C20 total work measures 1,675 ms and the dispatcher p50 869 ms over 884 runs, so NEVER lower the 90 s ceiling - it fails OPEN, and a lower one silently disables bash-guard C8/C12/C19/C20 under exactly that load. The 5 s task-rules-reminder budget was the one real misconfiguration.
- 🔴 [the slowness sentinel went blind for eight days](the-slowness-sentinel-went-blind-for-eight-days.md) - no log entry 16-23 Oct while Task Scheduler said success daily: #5959 gave slow-audit.mjs a relative import and the sentinel copies that ONE file flat into Temp, so the import threw and conhost.exe --headless reported ITS 0. Fixed 23 Oct. NEVER read LastTaskResult as proof a conhost-wrapped job worked - read the job log and check its newest entry is recent.
- [answers scale to the task](answers-scale-to-the-task-simple-question-simple-answer.md) - owner 23 Oct: answer first, concise by default, no recaps or alternatives unless the task needs them; the Next step line and MCQ rule stay.
