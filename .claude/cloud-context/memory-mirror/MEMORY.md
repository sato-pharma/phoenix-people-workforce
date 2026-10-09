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
- [Talent Acquisition seat: HE hands it out in User Access](talent-acquisition-seat-waits-for-his-word-on-yomnas-first-day.md) — never assign HR Resourcing for him; the HR Business Partner seat was RETIRED 2026-10-08 (his word), so recruiting and its other work are the Super Admin's alone until he does — never revive the seat or give recruiting back to cover the gap.
- [`check-migrations-applied` exits 0 when it cannot reach Supabase](check-migrations-applied-exits-zero-when-it-cannot-reach-supabase.md) — it prints `FAILED: ... not set` and still returns 0, so a hand-run with no env file reads as a clean ledger when nothing was measured; pass `--env-file=.env.local`, and do NOT "fix" the workflow, which supplies both variables inline.
- [phx-preview's red error was its OWN `2>$null`](phx-preview-red-error-was-powershell-wrapping-native-stderr.md) — PowerShell 5.1 wraps a native exe's stderr as ErrorRecords, so the redirect meant to hide a harmless `cat: no such file` is what printed NativeCommandError over the happy path; silence it inside the remote command and give ssh `LogLevel=ERROR`.
- [A `cancelled` check on a head you pushed = another session rebased the branch](a-rebase-by-the-branchs-own-session-cancels-your-ci-run.md) — re-read `origin/<branch>` and the PR's `headRefOid` before calling it red, and judge a required check by its LATEST run on the exact head, since a superseded run leaves a CANCELLED row with the same name as the live SUCCESS one.
- [`git show origin/main:.claude/…` is mangled by the MSYS shell](git-show-of-a-dotclaude-path-is-mangled-in-msys.md) — the argument becomes `origin\main;.claude\rules\…`, git errors, the capture is EMPTY, and a branch-vs-main loop then reports every line of that file as missing work; compare in node with `execFileSync`, and read "all N lines missing" as an empty capture.
- [An API role sweep needs no dev server](a-role-sweep-runs-without-a-dev-server.md) — call the real route handlers under the test loader with the x-phoenix-* headers + host localhost; one ~150 MB process swept 115 people at the 1.8 GB freeze line. Blind to page shells and sidebar reach; never call an export route.
- [Running a `tests/*.test.ts` file directly runs NOTHING and exits 0](running-a-phoenix-test-file-directly-runs-nothing.md) — the suites are exported functions `tests/run-tests.ts` calls, so a standalone run prints nothing and passing, failing and never-ran are indistinguishable; import the exported `run<X>Tests` and call it. A PowerShell `Set-Content -Encoding utf8` BOM fakes the break-test failure too.
- [Desktop slowness, 8 Oct 2026: compaction and the app window process, not the memory folder](desktop-slowness-2026-10-08-is-compaction-and-the-window-process.md) — 177 compactions/6.4 h in 3 days + a 1.5 GB renderer only a restart clears; BOTH fixed at the source 9 Oct — an ~8k-character compaction summary and the RAM meter's own idle-and-away app restart; skillOverrides cannot hide synced anthropic-skills.
- [The ROI facts full rebuild is the NO-ARGUMENT call](roi-facts-full-rebuild-is-the-no-argument-call.md) — `phx_refresh_marketing_roi_facts(<any uuid>)` takes the import branch, finds no batch, returns `success` with `affectedRequests: 0` before any delete and rebuilds nothing — and the argument also derives `triggered_by`, so a made-up batch id logs a FALSE `sos_import` run that then becomes the dashboard's `freshness.lastRefreshedAt`.
- [The ROI fast RPC needs its own defaults, never explicit nulls](the-roi-fast-rpc-needs-its-own-defaults-not-nulls.md) — `p_exclude_codes => null` makes `<> all(null)` drop every row, and the request list is `requestReport`, not `requests`; either mistake prints an empty dashboard that reads like a broken engine or empty fact tables.
- [ROI exact attribution joins on the distributor's NAME, not its code](the-roi-exact-attribution-chain-joins-on-distributor-NAME.md) — `marketing_distributors.distributor_code` is a `DST_*` id that matches nothing in the rollup, so `rollup_rows = 0` reads as a broken chain on BOTH environments while production attributes 24 rows fine (`ibn sina → IS`, `overseas → PS`); request-geo facts come from attributed SALES, not the pharmacy link graph; and the attributed value is the Phoenix price, with a shared sales row de-duplicated in the summary.
- [A class ratchet's regex must allow a quote before the ground](a-class-ratchet-regex-must-allow-a-quote-before-the-ground.md) — `(?:^|[\s`])border border-…` misses every class string that STARTS with the ground, because position 0 is the opening quote; the flat/lifted counts agree either way, so only a break-watch probe that reverts a composed template to a plain literal exposes it.
- [Dev-auth cannot reach STAGING — neither headers nor the cookie route](dev-auth-headers-cannot-reach-staging.md) — `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` is set there but both gates also demand `NODE_ENV=development` AND a loopback host, so the page 307s to `/login` and `/api/dev-auth` answers 404 (measured 2026-10-09); verify a staging-only build from the variable, the deployment, the code path and the RPC, and say the rendered page was not seen.
