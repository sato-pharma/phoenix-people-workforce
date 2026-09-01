# Memory map — which memory file backs which `AGENTS.md` hook

`AGENTS.md` carries the hooks; `docs/` carries the accounts; the memory files under
`C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\` carry the
point-in-time records. This file is the third mapping: **hook → memory file.**

**Why it exists.** Those slugs used to sit inline beside every hook in `AGENTS.md`, which
`CLAUDE.md` pulls in full via `@AGENTS.md` on EVERY request. Measured 2026-09-01: 149 slug
references costing 7,783 bytes — 11% of the file — re-sent on every turn, to answer a question
(which memory backs this hook?) that a session asks a few times a week. They moved here.

**Reachability is unaffected, and that was checked rather than assumed.**
`scripts/memory-index-reachability.mjs` treats a backticked slug in `AGENTS.md` as proof a
memory is reachable. Only **18** memory files depended on that — every other slug named a file
`MEMORY.md` already links. Those 16 therefore **stay inline in `AGENTS.md`** and must never be
moved here; the rest are listed below and remain reachable through the index. Before removing
any slug from `AGENTS.md`, re-run the classifier — the load-bearing set changes as the index does.

## 2.1 Session-level traps

- **grep -r hangs on this checkout — use git grep or rg.** — `shell-grep-unusable-use-git-grep-or-rg`
- **pnpm run <script> PURGES node_modules** — `pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved`
- **MSYS mangles paths silently, three ways:** — `git-ref-colon-path-is-mangled-by-msys-returns-empty`
- **`TZ=Africa/Cairo date` silently returns UTC in MSYS — 3h early, no error** — `tz-africa-cairo-silently-returns-utc-in-msys` **(inline — load-bearing)**
- **A role probe cannot trust the HTTP status code** — `a-role-probe-cannot-trust-the-http-status-code` · `a-post-to-any-api-path-returns-403-even-if-it-does-not-exist`
- **curl -d "@-" creates NOTHING on Windows** — `cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui`
- **Reads of .env* are auto-approved deliberately, for EVERY key** — `env-file-reads-fully-auto-approved-2026-08-09`
- **A permission allow-rule stores the LITERAL command, so an inline env var bakes a…** — `permission-allowlist-rules-can-embed-a-live-secret`
- **mcp__supabase-staging__* is broken** — `supabase-staging-named-server-broken-2026-08-10`
- **A Windows USER env var SHADOWS every .env.local, silently.** — `windows-env-var-shadows-every-env-local-key`
- **The local attendance agent dies at EVERY logon and loses NOTHING — do not escalate…** — `attendance-agent-crashes-at-logon-but-loses-no-attendance`
- **ExcelJS emits two schema-invalid OOXML fragments, so Excel silently REPAIRS the…** — `exceljs-writes-two-schema-invalid-ooxml-fragments`
- **Deleting a branch does not remove its pushed commit** — `deleting-a-branch-does-not-remove-a-pushed-commit` · `reusing-a-squash-merged-branch-makes-a-conflicting-pr`
- **git push hangs — kill at ~60s and retry.** — `git-push-to-origin-hangs-retry-immediately` · `git-push-oom-is-a-500mb-postbuffer-in-repo-config`
- **A merge to main mid-session silently orphans your next push.** — `a-merge-mid-session-orphans-your-next-push-silently` · `two-sessions-fixed-one-bug-main-was-never-ci-validated`
- **refs/deleted-* is NOT automatic — a plain git branch -D archives NOTHING.** — `deleted-branch-tips-live-in-refs-deleted-branches`
- **An empty git log <branch> --not --remotes=origin is NOT proof a branch is safe to…** — `not-remotes-flips-when-remote-refs-are-pruned` · `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **A UTC merge time read against a Cairo commit time INVERTS the merged/stranded…** — `a-utc-timestamp-compared-against-cairo-manufactures-a-false-signal`
- **git "Authentication failed" can be the credential HELPER going OOM, not a bad token** — `git-auth-failed-can-be-the-credential-helper-going-oom`
- **F:\PHX backup is the disaster-recovery set, and a bundle restore silently returns…** — `phx-backup-disaster-recovery-set`
- **CI jobs failing in SECONDS mean billing, not code.** — `ci-jobs-failing-in-seconds-means-billing-not-code`
- **secret-scan is a required check — there are 4 — and it is the one that never runs…** — `github-personal-account-no-ghas-oss-scanning`
- **gh pr checks LAGS behind the real job state.** — `gh-pr-checks-lags-behind-the-real-job-state`
- **check-runs: 0 also means CONFLICTED** — `a-conflicted-pr-runs-no-ci-at-all`
- **ONE new hub page trips FOUR separate CI gates.** — `adding-a-hub-page-trips-four-separate-ci-gates`
- **A red main still builds, ships and serves perfectly** — `a-red-main-ships-and-looks-fine-build-ignores-type-errors`
- **A migration FILE written is not a migration APPLIED** — `migration-file-written-is-not-migration-applied` · `merged-migration-file-does-not-mean-grants-are-live`
- **Migration timestamps COLLIDE across parallel branches** — `migration-timestamp-collides-across-parallel-branches` · `migration-ledger-version-never-matches-the-filename`
- **A PostgREST .in() carrying several hundred ids returns ZERO rows and NO error.** — `postgrest-in-with-hundreds-of-ids-silently-returns-nothing`
- **A neq against an ABSENT jsonb key matches ZERO rows** — `postgrest-neq-on-an-absent-jsonb-key-matches-nothing` · `postgrest-unbounded-select-silently-stops-at-1000-rows`
- **n_live_tup is STALE in production — it reports LIVE tables as empty.** — `n-live-tup-is-stale-use-real-count`
- **A Supabase client request that times out at 15s STILL COMMITS** — `supabase-client-15s-timeout-commits-anyway-half-applies`
- **A missing TABLE answers PGRST205, NOT 42P01** — `a-missing-table-answers-pgrst205-not-42p01` **(inline — load-bearing)**
- **A write REVOKE does NOT make a table read-only** — `a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function`
- **An append-only table needs a STATEMENT-level BEFORE TRUNCATE trigger** — `append-only-tables-need-a-truncate-trigger`
- **RLS on with no authenticated grant is the NORM here — 222 of 308 tables — not a…** — `rls-policy-without-an-authenticated-grant-is-usually-correct`
- **ONE auth.users row with banned_until = 'infinity' 500s the ENTIRE GoTrue admin API** — `banned-until-infinity-breaks-the-whole-auth-admin-api`
- **au.f_monthly_achievement SERVES A PRECOMPUTED ROLLUP, and its fingerprint covers…** — `attribution-rollup-fingerprint-ignores-the-sales-data` **(inline — load-bearing)**
- **A 200 from a health endpoint can be blind to the thing that is broken** — `openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules` · `openai-spend-cannot-be-read-from-the-api-reconstruct-it`
- **app_error_events returning 0 rows means QUIET, not broken.** — `app-error-events-is-user-triggered-zero-is-not-broken`
- **The Error Monitor HIDES rows whose environment is NULL** — `error-monitor-hides-null-environment-rows` · `ad-hoc-backup-tables-are-anon-readable`
- **updated_by_hr_id LIES about who wrote a row.** — `how-to-attribute-a-production-write`
- **HR ids are MIXED CASE, so a plain .eq silently under-returns** — `activity-events-hr-id-is-mixed-case-not-lowercase` · `direct-order-hr-id-columns-are-mixed-case-and-access-hrid-is-lowercase`
- **The Sato logo's wordmark is WHITE, so "SATO" vanishes on white paper.** — `sato-logo-wordmark-is-white-invisible-on-paper`
- **RAM-saturated? WAIT — do not skip validation for it.** — `dont-skip-validation-for-ram-wait-instead`
- **Source-pinning tests slice a fixed BYTE window and false-FAIL** — `source-pinning-tests-slice-a-fixed-byte-window`
- **A heredoc eats backslashes** — `heredoc-eats-backslashes-and-makes-a-test-that-only-passes`
- **parseDiagnostics is SYNTAX-ONLY — it cannot see a typecheck error.** — `parse-diagnostics-cannot-see-a-typecheck-error`
- **setState inside useEffect is a lint ERROR here.** — `set-state-in-effect-is-a-lint-error-here`
- **A green TEST run carries NO type signal** — `a-green-test-run-carries-no-type-signal-at-all`
- **The SUITE runs with PRODUCTION credentials while a test sets APP_ENV=production** — `the-test-suite-runs-with-production-credentials-and-app-env-production` **(inline — load-bearing)**
- **A test can NEVER hand a function a process.env literal** — `a-test-can-never-hand-a-function-a-process-env-literal`
- **An exhaustive Record does NOT gate the build** — `an-exhaustive-record-does-not-gate-the-build-here`
- **A narrowed SELECT disarms every gate downstream of it** — `a-narrowed-select-disarms-every-gate-downstream-of-it`
- **An OPTIONAL field written UNCONDITIONALLY is a silent erase.** — `optional-field-written-unconditionally-is-a-silent-erase`
- **A feature can ship green, deploy cleanly, and be reachable by NOBODY — and zero…** — `capture-evidence-was-dead-on-arrival-for-doctor-customers`
- **A merged fix on a path nobody has exercised is untested, not proven.** — `payroll-mutations-were-unaudited-until-2026-08-21`
- **cn() SILENTLY DROPPED every text-phx-* size, and only getComputedStyle in a real…** — `tailwind-merge-strips-custom-named-font-sizes` **(inline — load-bearing)**
- **Arabic + English in ONE value needs direction PER LINE; dir="auto" on the block is…** — `bilingual-bodies-need-direction-per-line-not-per-block` **(inline — load-bearing)**
- **@/lib/utils resolves to the ROOT lib/utils.ts, NOT src/lib/utils.ts** — `at-slash-lib-shadows-src-lib-via-tsconfig-paths` **(inline — load-bearing)**
- **Sweep memories by CLAIM, never by filename or topic** — `staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones`
- **A parallel session can collide with NO git trace at all** — `feedback-parallel-session-pr-collision`
- **ONE approval can reach SEVERAL sessions — N sessions holding the same "yes" is N…** — `one-approval-can-reach-more-than-one-session`
- **Another SESSION can remove a worktree under you.** — `another-session-can-remove-a-worktree-under-you`
- **A gitignored _wt-*/ scratch folder makes a worktree look clean.** — `gitignored-wt-scratch-makes-a-worktree-look-clean`
- **The pre-push gate is GONE — a bare worktree pushes fine.** — `bare-worktree-cannot-push-pre-push-gate-needs-node-modules`
- **"Permission denied" on git worktree remove still DEREGISTERS the worktree.** — `worktree-remove-permission-denied-still-deregisters`
- **--fix / --strip-idle need exactly ONE live session** — `repo-doctor-strip-idle-cannot-run-with-sessions-open` · `repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm`
- **A squash-merged branch reads as "on NO origin ref" — that means BACKED UP, not…** — `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **Self-removing a worktree MUTES its own session-end guard.** — `self-removing-a-worktree-mutes-its-own-session-end-guard`
- **next dev in a worktree needs the explicit --webpack flag** — `turbopack-cannot-resolve-a-junctioned-node-modules-here`
- **A >2MB unstable_cache entry KILLS the dev server** — `next-2mb-data-cache-throws-only-in-dev-and-kills-the-server`
- **unstable_cache SERIALIZES, so a returned Map comes back {}** — `unstable-cache-serializes-a-map-into-an-empty-object`
- **Standalone tracing copies FILES, not pnpm SYMLINKS** — `next-tracing-copies-files-not-pnpm-symlinks` · `next-standalone-trace-misses-a-native-librarys-so-dependency`
- **A MINIMIZED window makes every browser reading LIE — check document.visibilityState…** — `a-minimized-window-makes-every-browser-test-lie`
- **Click by TEXT — blind coordinate clicks once fired a real production collection run.** — `blind-coordinate-clicks-fired-a-production-collection-run`
- **Dev login is GET /api/dev-auth?role=<Role>, and it DOES role-switch the Browser pane** — `dev-auth-is-header-only-browser-pane-cannot-use-it`
- **Turbopack 500s with 0xc0000142 when the commit charge is exhausted** — `turbopack-500s-with-0xc0000142-when-commit-is-full`
- **Verify a 375px mobile layout with NO dev server.** — `verify-a-mobile-layout-without-a-dev-server`
- **A freeze leaves NO dump** — `commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb`
- **An interrupted session leaves the tree BROKEN ON PURPOSE.** — `an-interrupted-session-leaves-the-tree-deliberately-broken`

## 2.2 The memory index

- **Never delete a hook to make room, and correct the FILE before the hook.** — `memory-index-floor-is-13kb-dont-gut-it-chasing-17`
- **What earns a line — all three:** — `staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones`

## 2.3 Production and approval hooks

- **A deploy applies NO migrations** — `railway-deploy-applies-no-migrations` · `railway-auto-deploy-can-silently-skip-a-race`
- **railway variables --stdin stores a BOM** — `railway-stdin-bom-trap`
- **railway ssh JOINS argv and lands as ROOT.** — `railway-ssh-joins-argv-and-lands-as-root`
- **railway service source connect is NOT environment-scoped — --environment staging…** — `railway-service-source-connect-is-not-environment-scoped`
- **A PARTIAL CRON_SECRET rotation leaves TWO fingerprints** — `a-partial-cron-secret-rotation-leaves-two-fingerprints`
- **CRON_SECRET lives in TWO stores and the arrow points GitHub → Railway.** — `github-actions-cron-secret-went-stale-after-a-railway-rotation` · `a-cron-that-fails-nightly-can-do-so-forever-unwatched`
- **The cron-job.org REST API allows 100 requests per DAY** — `cron-job-org-rest-api-is-100-requests-per-day`
- **NEVER rotate the Supabase DB password with ALTER ROLE** — `never-rotate-the-supabase-db-password-with-alter-role`
- **expense_claims is the ONE live RLS read path in production.** — `expense-claims-rls-read-path-is-live-in-prod` · `guard-every-prod-write-when-another-session-shares-the-queue` · `force-logout-everywhere-needs-three-writes`
- **Production has NO PITR — 7 daily physical backups are the whole recovery story** — `production-supabase-has-no-pitr-only-daily-backups`
- **Payroll NEVER reads social_insurance_status — the social_insurance_wage column…** — `payroll-reads-the-insurance-wage-never-the-status` **(inline — load-bearing)** · `social-insurance-and-tax-never-reduce-take-home-pay` **(inline — load-bearing)**
- **A LOCAL run writes PRODUCTION but silently skips every email** — `local-run-against-prod-db-silently-skips-every-email` · `local-resend-key-is-restricted-use-railway-run-to-send-from-production`
- **STAGING cannot rehearse a PRODUCTION shape.** — `staging-cannot-rehearse-shapes-only-prod-surgery-made`
- **APP_ENV was UNSET on Railway staging, so staging identified itself as PRODUCTION** — `app-env-unset-on-staging-made-it-look-like-production`

## 3. Stable Environment Facts

- **The OUTBOX DRAIN is the one that needs care — it ran perfectly and did nothing for…** — `outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line`

## 4. Standing owner rules

- **"continue verifying" means RESUME the paused Source of Sales audit — never restart…** — `continue-verifying-resumes-sos-audit` · `sos-deep-audit-paused-checkpoint`
- **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND…** — `never-horizontal-scroll-always-mobile-and-desktop-friendly` **(inline — load-bearing)**
- **A PHARMACY IS NOT A CONTACT — a CRM contact count is PM + AM only.** — `a-pharmacy-is-not-a-contact` **(inline — load-bearing)**
- **THE OLD MONTHLY CLOSING EXPORT IS FROZEN — every new closing feature ships BESIDE…** — `the-old-monthly-closing-export-is-never-touched` **(inline — load-bearing)**
- **The premium closing workbook FILLS the .xlsm engine — it never rebuilds one.** — `premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it` **(inline — load-bearing)**
- **Every weekly report and export MUST set excludeUnmapped** — `unmapped-products-must-never-reach-a-report` · `an-export-must-match-the-screen-never-different-data` · `weekly-summarized-report-owner-rules`
- **The system FLAGS an expense; it NEVER auto-rejects one.** — `system-flags-expenses-never-rejects` · `never-auto-publish-deductions-owner-confirms-first` · `dv-evidence-window-same-day-submits`
- **CRM visit types -5 (Public Holiday) and -6 (Casual Leave) are WORKING days, never…** — `public-holiday-and-casual-leave-are-working-days`
- **The Ready-sheet >25th full-pay waiver is for genuine RESIGNATIONS only** — `resignation-full-pay-rule-is-resignation-only` · `cairo-trip-no-per-diem-allowance-live-prod-2026-08-15` · `field-force-provisioning-live-and-guard-relaxed-2026-08-14`
- **Social-insurance Form 1 prints exactly as the Authority issues it** — `government-form1-prints-exactly-as-issued`
- **The organogram XLSX carries a Mobile column** — `organogram-export-carries-the-mobile-by-owner-override`
- **The public Territory Management preview link must NEVER display or offer the line** — `territory-preview-link-must-never-show-the-line` · `organogram-chart-source-is-au-seat-model-not-directory` · `whatsapp-button-on-leadership-rows-is-an-owner-decision`
- **The CEO is NOT a district, and a picker is never wider than its viewer.** — `the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer` **(inline — load-bearing)**
- **An NSM's outstation expense is NEVER held** — `nsm-outstation-expense-is-never-held` **(inline — load-bearing)**
- **The mailbox-monitor app-password entry is ___, never "Phoenix".** — `mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix` **(inline — load-bearing)**
- **Turbify CANNOT issue app passwords centrally — the owner is STAYING, so do not…** — `turbify-cannot-issue-app-passwords-centrally-owner-stays` **(inline — load-bearing)**
- **A password reset does NOT revoke a Turbify mailbox — the app passwords survive it.** — `a-password-reset-does-not-revoke-a-turbify-mailbox` **(inline — load-bearing)**

## 4.1 Marketing customer, venue and licence validation

- **Venue validation is GPS + a live picture ALWAYS — and leg 3 (the registered code,…** — `venue-validation-rule-gps-photo-then-code-or-licence`
- **Marketing pharmacies are TERRITORIAL, and a NULL area_id makes one invisible.** — `seeded-marketing-pharmacies-have-no-area-and-are-invisible`
- **A licence verdict is PERMANENT and has no correction path.** — `a-licence-verdict-is-permanent-and-has-no-correction-path`
- **system_validated means NO HUMAN LOOKED.** — `marketing-system-validated-means-no-human-looked`
- **A venue's evidence was WRITE-ONCE, writable only at insert** — `marketing-venue-evidence-was-writable-only-at-insert`
- **The badge read a FROZEN note, never the live evidence** — `marketing-badge-read-a-frozen-note-not-the-live-evidence`
- **A duplicate merge STRANDS the desk validation on the retired row.** — `a-duplicate-merge-strands-the-desk-validation-on-the-retired-row`
- **The screen that SHOWS a badge is not the screen a rep can OPEN.** — `the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open`

