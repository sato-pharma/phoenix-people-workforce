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
memory is reachable. The rows marked **(inline — load-bearing)** are the ones where that is the
ONLY reference — every other slug here names a file **an index** still links. Marked slugs therefore
**stay inline in `AGENTS.md`** and must never be moved here; the rest remain reachable through the
index. No count is given on purpose: the set has already changed three times (it grew again on
2026-09-01, when twelve slugs moved the OTHER way, out of `MEMORY.md` and into `AGENTS.md`, to buy
index budget under the loader cliff). Before removing any slug from `AGENTS.md`, re-run the
classifier — the load-bearing set changes as the index does.

**A MARKER THE CLASSIFIER CALLS "over-marked" IS NOT AUTOMATICALLY SAFE TO TRIM — read WHICH index
links it.** "An index" above means `MEMORY.md` **or** `MEMORY-ARCHIVE.md`, and for the marker
question those two are not interchangeable: §2.2 makes `MEMORY.md` the only auto-loaded memory file.
A slug whose sole index link is in the **archive** is not stranded — the archive's contract is
grep-findability — but cutting its `AGENTS.md` line drops the rule out of every session's loaded
context, leaving it only for whoever thinks to open a file that never loads. **That marker is
correct and stays.** Measured 2026-09-21, which is why this paragraph exists: three marked slugs
(`ats-candidate-children-one-has-no-fk-and-one-is-a-view`,
`offer-chain-was-live-in-the-registry-with-a-hole-past-approval`,
`owner-sheet-vocabulary-stores-is-office-upa-is-a-channel`) had zero matches in `MEMORY.md` and
appeared only in `MEMORY-ARCHIVE.md`, and the classifier printed all three as *"an index links it
too, so the marker over-claims — not a risk"*. The classifier now splits the two cases and prints
`keep` for the archive-only ones; `splitOverMarkedByAutoLoadedIndex` is the function, and the case is
pinned in `tests/memory-index-reachability.test.ts` §9.

**The marker is LINE-scoped, not slug-scoped — do not try to remove just one.**
`scripts/memory-index-reachability.mjs` tests each LINE for the marker text and, on a match, marks
**every** slug on that line. So on a row carrying several slugs the markers cannot say different
things about different slugs: deleting one leaves the rest still marking it, and the map then reads
as if that slug were not load-bearing while the tool still treats it as marked. This is why the
classifier can report a slug as `over-marked` when the marker beside it is already gone — read the
whole LINE, not the token. Tried and reverted 2026-09-04. If one slug genuinely needs a different
status, give it its own line.

## 2.1 Session-level traps

- **grep -r hangs from a repo or worktree root, `.`, node_modules or .claude — use git grep or rg there; any other named folder, file or small absolute path is fine (C1 is a deny-list since 2026-10-22).** — `shell-grep-unusable-use-git-grep-or-rg`
- **pnpm run <script> PURGES node_modules** — `pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved`
- **MSYS mangles paths silently, four ways:** — `git-ref-colon-path-is-mangled-by-msys-returns-empty`
- **Grepping a wrapped report returns a middle line that reads as a verdict — read the section, and measure the thing itself** — `grepping-a-wrapped-report-turns-an-explanation-into-a-verdict` **(inline — load-bearing)**
- **`pg_stat_statements` dates a `calls = 1` statement exactly via `stats_since` and can never say WHO ran it — the precise timestamp is what makes adjacency look like proof** — `pg-stat-statements-times-precisely-and-attributes-never` **(inline — load-bearing)**
- **Never restate a rule the repo already implements — a hand-rolled wholesaler regex collapsed a two-tier owner rule into one and nearly deactivated five real pharmacies on his approval** — `never-hand-roll-a-rule-the-repo-already-implements` **(inline — load-bearing)**
- **`main`'s required checks have rotted five times (4→5→6→4→2) and the filename still says four — read the protection API live** — `mains-required-checks-are-four-not-six-checks-carries-the-suite` **(inline — load-bearing)**
- **A superseded deploy reached `success` before going `inactive`; a withheld one never did — and Railway posts two rows per commit, so judge the HISTORY** — `a-superseded-deploy-reached-success-a-withheld-one-never-did` **(inline — load-bearing)**
- **The 286 GPS-less venues from the 2026-06-20 import: a backfilled cross-area link is evidence, not a mismatch — read `validation_notes`** — `a-pre-gps-backfilled-venue-link-is-not-a-defect` **(inline — load-bearing)**
- **Cairo Pedia's DM and all five rep seats are vacant by the owner's ruling — never a finding, never filled** — `cairo-pedia-is-empty-on-purpose-a-hire-is-coming` **(inline — load-bearing)**
- **`TZ=Africa/Cairo date` silently returns UTC in MSYS — 3h early, no error** — `tz-africa-cairo-silently-returns-utc-in-msys` **(inline — load-bearing)**
- **`main` is usually NOT in the primary — a worktree holds it, so ahead/behind read from HEAD there is real but mislabelled** — `main-is-not-the-primary-checkout` **(inline — load-bearing)**
- **`git merge --no-commit --no-ff` is NOT a dry run — it MERGES, so a "would this overwrite anything?" probe mutates the shared primary and leaves MERGE_HEAD; the read-only pre-flight is `git diff --name-only HEAD..origin/main` intersected with `git ls-files --other --exclude-standard`** — `a-no-commit-merge-probe-actually-merges-in-the-shared-primary` **(inline — load-bearing)**
- **A scheduled task run by hand records no `lastRunAt` and creates no session — both absences are normal, not proof it failed** — `a-manual-scheduled-task-run-leaves-no-trace` **(inline — load-bearing)**
- **A role probe cannot trust the HTTP status code** — `a-role-probe-cannot-trust-the-http-status-code` · `a-post-to-any-api-path-returns-403-even-if-it-does-not-exist`
- **curl -d "@-" creates NOTHING on Windows** — `cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui`
- **Reads of .env* are auto-approved deliberately, for EVERY key** — `env-file-reads-fully-auto-approved-2026-08-09`
- **A permission allow-rule stores the LITERAL command, so an inline env var bakes a…** — `permission-allowlist-rules-can-embed-a-live-secret`
- **mcp__supabase-staging__* is PINNED to staging** — `supabase-staging-named-server-broken-2026-08-10`
- **A Windows USER env var SHADOWS every .env.local, silently.** — `windows-env-var-shadows-every-env-local-key`
- **ONE Supabase token wears TWO names — both `.mcp.json` entries expand the same Windows user env var** — `supabase-access-and-prod-token-are-one-token` **(inline — load-bearing)**
- **`CLAUDE_PROJECT_DIR` is the session's OWN worktree, never the primary — the docs say otherwise and hooks break silently** — `claude-project-dir-is-the-sessions-own-worktree` **(inline — load-bearing)**
- **`apply-sql-file.mjs` rewrites production's URL to the aws-0 pooler, which does NOT resolve — production is aws-1-eu-central-1, staging really is aws-0** — `apply-sql-file-default-pooler-host-is-wrong-for-production` **(inline — load-bearing)**
- **A NEW Railway service is born in `sfo` (US), not Europe, and a volume is region-pinned once created — set the region explicitly or the standing Europe rule is broken silently** — `railway-services-are-born-in-sfo-and-volumes-are-region-pinned` **(inline — load-bearing)**
- **The local attendance agent dies at EVERY logon and loses NOTHING — do not escalate…** — `attendance-agent-crashes-at-logon-but-loses-no-attendance`
- **ExcelJS emits two schema-invalid OOXML fragments, so Excel silently REPAIRS the…** — `exceljs-writes-two-schema-invalid-ooxml-fragments`
- **Looking at a generated workbook has two modes that LIE (LibreOffice PNG, ExcelJS round-trip).** — `looking-at-a-generated-workbook-two-ways-that-lie` **(inline — load-bearing)**
- **Deleting a branch does not remove its pushed commit** — `deleting-a-branch-does-not-remove-a-pushed-commit` · `reusing-a-squash-merged-branch-makes-a-conflicting-pr`
- **`git branch -d` gates NOTHING after a squash merge — it compares against its own STALE tracking ref** — `git-branch-d-is-not-a-safety-gate-after-a-squash-merge` **(inline — load-bearing)**
- **A stacked branch REBUILDS after its parent squash-merges — merging main into it conflicts on every line of the parent, and rerere replays the wrong resolution** — `a-squash-merge-makes-a-stacked-branch-rebuild-not-merge` **(inline — load-bearing)**
- **git push hangs — kill at ~60s and retry.** — `git-push-to-origin-hangs-retry-immediately` · `git-push-oom-is-a-500mb-postbuffer-in-repo-config`
- **A merge to main mid-session silently orphans your next push.** — `a-merge-mid-session-orphans-your-next-push-silently` · `two-sessions-fixed-one-bug-main-was-never-ci-validated`
- **refs/deleted-* is NOT automatic — a plain git branch -D archives NOTHING.** — `deleted-branch-tips-live-in-refs-deleted-branches`
- **An empty git log <branch> --not --remotes=origin is NOT proof a branch is safe to…** — `not-remotes-flips-when-remote-refs-are-pruned` · `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **A UTC merge time read against a Cairo commit time INVERTS the merged/stranded…** — `a-utc-timestamp-compared-against-cairo-manufactures-a-false-signal`
- **git "Authentication failed" can be the credential HELPER going OOM, not a bad token** — `git-auth-failed-can-be-the-credential-helper-going-oom`
- **F:\PHX backup is the disaster-recovery set, and a bundle restore silently returns…** — `phx-backup-disaster-recovery-set`
- **CI jobs failing in SECONDS mean billing, not code.** — `ci-jobs-failing-in-seconds-means-billing-not-code`
- **secret-scan is NOT a required check — demoted 2026-09-29, and off `pull_request` since; a personal account still has no GHAS** — `github-personal-account-no-ghas-oss-scanning`
- **gh pr checks LAGS behind the real job state.** — `gh-pr-checks-lags-behind-the-real-job-state`
- **check-runs: 0 also means CONFLICTED** — `a-conflicted-pr-runs-no-ci-at-all`
- **ONE new hub page trips FOUR separate CI gates.** — `adding-a-hub-page-trips-four-separate-ci-gates`
- **A red main still builds, ships and serves perfectly** — `a-red-main-ships-and-looks-fine-build-ignores-type-errors`
- **A migration FILE written is not a migration APPLIED** — `migration-file-written-is-not-migration-applied` · `merged-migration-file-does-not-mean-grants-are-live`
- **Migration timestamps COLLIDE across parallel branches** — `migration-timestamp-collides-across-parallel-branches` · `migration-ledger-version-never-matches-the-filename`
- **A PostgREST .in() fails 3 ways: ZERO rows and NO error; 22P02 on ONE null id; headers over ~16KB.** — `postgrest-in-with-hundreds-of-ids-silently-returns-nothing`
- **A neq against an ABSENT jsonb key matches ZERO rows** — `postgrest-neq-on-an-absent-jsonb-key-matches-nothing` · `postgrest-unbounded-select-silently-stops-at-1000-rows`
- **n_live_tup is STALE in production — it reports LIVE tables as empty.** — `n-live-tup-is-stale-use-real-count`
- **A Supabase client request that times out at 15s STILL COMMITS** — `supabase-client-15s-timeout-commits-anyway-half-applies`
- **A missing TABLE answers PGRST205, NOT 42P01** — `a-missing-table-answers-pgrst205-not-42p01` **(inline — load-bearing)**
- **A write REVOKE does NOT make a table read-only** — `a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function`
- **An append-only table needs a STATEMENT-level BEFORE TRUNCATE trigger** — `append-only-tables-need-a-truncate-trigger`
- **RLS on with no authenticated grant is the NORM here — ~4 in 5 public tables — not a…** — `rls-policy-without-an-authenticated-grant-is-usually-correct`
- **ONE auth.users row with banned_until = 'infinity' 500s the ENTIRE GoTrue admin API** — `banned-until-infinity-breaks-the-whole-auth-admin-api`
- **au.f_monthly_achievement SERVES A PRECOMPUTED ROLLUP, and its fingerprint covers…** — `attribution-rollup-fingerprint-ignores-the-sales-data` **(inline — load-bearing)**
- **The ATS data model carries four traps that each read as normal.** `offer-chain-was-live-in-the-registry-with-a-hole-past-approval` **(inline — load-bearing)** `ats-candidate-children-one-has-no-fk-and-one-is-a-view` **(inline — load-bearing)** `cv-extraction-reads-governorate-but-never-applies-it` **(inline — load-bearing)** `the-medical-rep-cv-schema-reads-12-fields-universal-reads-38` **(inline — load-bearing)**
- **A CV import OVERWROTE a candidate's whole identity** `a-cv-import-overwrote-a-candidates-whole-identity` **(inline — load-bearing)** `the-email-import-allowlist-holds-an-inbox-not-a-sender` **(inline — load-bearing)** `cv-file-is-in-ats-files-not-cv-external-url` **(inline — load-bearing)**
- **A 200 from a health endpoint can be blind to the thing that is broken** — `openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules` · `openai-spend-cannot-be-read-from-the-api-reconstruct-it`
- **app_error_events returning 0 rows means QUIET, not broken.** — `app-error-events-is-user-triggered-zero-is-not-broken`
- **A client-error census by MESSAGE reads iOS-ONLY on an every-platform failure — masking spares iOS WebKit's message and blanks Android's** — `census-client-errors-by-stack-not-message` **(inline — load-bearing)**
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
- **A UI timeZone: "UTC" has THREE causes and only ONE is a bug — a blanket Cairo fix…** — `ireports360-timestamps-cairo-local-mislabeled-utc`
- **VERIFY THE EMITTED ARTIFACT, NEVER THE SOURCE — three defects shipped in ONE night…** — `verify-the-emitted-artifact-never-the-source` **(inline — load-bearing)**
- **@/lib/utils resolves to the ROOT lib/utils.ts, NOT src/lib/utils.ts** — `at-slash-lib-shadows-src-lib-via-tsconfig-paths` **(inline — load-bearing)**
- **Sweep memories by CLAIM, never by filename or topic** — `staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones`
- **A parallel session can collide with NO git trace at all** — `feedback-parallel-session-pr-collision`
- **ONE approval can reach SEVERAL sessions — N sessions holding the same "yes" is N…** — `one-approval-can-reach-more-than-one-session`
- **Another SESSION can remove a worktree under you.** — `another-session-can-remove-a-worktree-under-you`
- **A gitignored _wt-*/ scratch folder makes a worktree look clean.** — `gitignored-wt-scratch-makes-a-worktree-look-clean`
- **The pre-push gate is GONE — a bare worktree pushes fine.** — `bare-worktree-cannot-push-pre-push-gate-needs-node-modules`
- **"Permission denied" on git worktree remove still DEREGISTERS the worktree.** — `worktree-remove-permission-denied-still-deregisters`
- **A husk is pinned by a PROCESS whose cwd is inside it, not by the session's — and MSYS `/proc` cannot see the holder.** — `a-worktree-husk-is-pinned-by-the-session-not-its-cwd` **(inline — load-bearing)**
- **--fix / --strip-idle need exactly ONE live session** — `repo-doctor-strip-idle-cannot-run-with-sessions-open` · `repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm`
- **A squash-merged branch reads as "on NO origin ref" — that means BACKED UP, not…** — `repo-doctor-no-origin-ref-is-usually-squash-residue`
- **Self-removing a worktree MUTES its own session-end guard.** — `self-removing-a-worktree-mutes-its-own-session-end-guard`
- **`gh pr merge` from a worktree exits NON-ZERO after the merge SUCCEEDED.** — `gh-pr-merge-exits-nonzero-from-a-worktree-after-it-succeeded` **(inline — load-bearing)**
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
- **A slow reply is the EFFORT level, not the machine** — `claude-code-effort-max-got-slow-xhigh-is-the-balance` **(inline — load-bearing)**
- **A slowness audit dates the CHANGE, never a snapshot** — `slowness-audits-compare-before-and-after` **(inline — load-bearing)**
- **`Agent` with `isolation: "remote"` from a desktop session can run LOCALLY, with no notice of the fallback** — `agent-isolation-remote-ran-locally-in-a-worktree` **(inline — load-bearing)**
- **A new workbook builder takes three checks, and none substitutes for another.** — `verifying-a-new-workbook-builder-takes-three-layers` **(inline — load-bearing)**
- **A keyword scan over source text matches a COMMENT exactly as it matches a call — read the imports before reporting what a generator reads.** — `regen-readslivedata-flag-matches-a-comment-not-a-call` **(inline — load-bearing)**
- **Auto mode refuses an `Edit` to `settings.json` as `[Self-Modification]`; his instruction clears it, his own grant does not.** — `automode-allow-cannot-authorize-editing-the-permission-config` **(inline — load-bearing)**
- **"Never close the dev" is SCOPED, not repealed — one YOUR session started is yours to stop; `TaskStop` frees no memory, and a compile's first RAM reading lies.** — `i-may-stop-a-dev-server-i-started-myself` **(inline — load-bearing)**
- **Reading a property the type does not have is `undefined`, not an error — so `if (obj.wrongName && …)` is a dead branch that logs nothing and looks exactly like "there is no data".** — `a-field-that-does-not-exist-is-a-silently-dead-branch` **(inline — load-bearing)**
- **A query that finds disagreements by filtering `a is distinct from b` cannot see the rows that AGREE, so a partial split reads as a simple fixable one — re-read the whole set for the entity before proposing a repair.** — `a-mismatch-query-hides-the-row-that-matches` **(inline — load-bearing)**

## 2.2 The memory index

- **Never delete a hook to make room, and correct the FILE before the hook.** — `memory-index-floor-is-13kb-dont-gut-it-chasing-17`
- **What earns a line — all three:** — `staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones`
- **A relocation's condition is present in the checkout you trim from — and from a worktree the classifier cannot read that checkout.** — `memory-reachability-classifier-reads-the-primarys-agents-md` **(inline — load-bearing)**
- **Session history lives in THREE stores with two retention keys — an empty `~/.claude/projects` proves nothing.** — `two-session-stores-two-retention-keys` **(inline — load-bearing)**
- **A ledger version never matches the repo filename for a migration applied through the Supabase MCP, so "absent from the ledger" is the expected state and not drift — and the stamped minute invites a guess about WHO, which the database cannot answer.** — `a-ledger-version-never-matches-the-file` **(inline — load-bearing)**
- **A reused branch name makes `gh pr list --head <branch> --state merged` return the OLD merged PR, so the removal gate vouched for #3734 while #5089 was open — ask for the PR by number and test content on `main`.** — `a-reused-branch-name-finds-the-old-merged-pr` **(inline — load-bearing)**
- **A stale-citation sweep's false positives have four shapes — the retired citation is the SUBJECT, the ABSENCE is the claim, the TITLE contradicts its own description, and elided-prefix shorthand looks corrupted.** — `the-four-shapes-a-stale-citation-sweep-misreads` **(inline — load-bearing)**

## 2.3 Production and approval hooks

- **A deploy applies NO migrations** — `railway-deploy-applies-no-migrations` · `railway-auto-deploy-can-silently-skip-a-race`
- **A red `main` CI makes Railway mark the production deploy SKIPPED in minutes, and a green re-run does not resurrect it** — `a-red-main-ci-makes-railway-skip-the-deploy-for-good` **(inline — load-bearing)**
- **The `railway` CLI in the primary is linked to `phoenix-headwind`, not the app — every command needs `--service phoenix-people-workforce`** — `railway-cli-is-linked-to-phoenix-headwind-not-the-app` **(inline — load-bearing)**
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
- **A HELD payroll row is DROPPED at publish, silently.** `a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace` **(inline — load-bearing)**
- **A vacation balance is RECOMPUTED, never read from a snapshot — INSERT missing days, never UNPAID, and `salary_records.unpaid_vacations` is a second path that has taken money** — `vacation-balance-is-recomputed-live-snapshots-are-display-only` **(inline — load-bearing)**
- **Hiring ONE person breaks achievement everywhere — the insert auto-seats them and flips `line_area_map.area_state`, which is hashed into the fingerprint; re-stamp after any hire** — `an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing` **(inline — load-bearing)**
- **Auth metadata keys `phoenix_role`, not `role`, so a migration writing `role` matches 0 rows and verifies itself green; `banned_until` is not deactivation** — `auth-metadata-role-key-is-phoenix-role-not-role` · `deactivated-accounts-are-mostly-not-banned-at-the-auth-layer` **(inline — load-bearing)**
- **A LOCAL run writes PRODUCTION but silently skips every email** — `local-run-against-prod-db-silently-skips-every-email` · `local-resend-key-is-restricted-use-railway-run-to-send-from-production`
- **STAGING cannot rehearse a PRODUCTION shape.** — `staging-cannot-rehearse-shapes-only-prod-surgery-made`
- **APP_ENV was UNSET on Railway staging, so staging identified itself as PRODUCTION** — `app-env-unset-on-staging-made-it-look-like-production`

## 3. Stable Environment Facts

- **The OUTBOX DRAIN is the one that needs care — it ran perfectly and did nothing for…** — `outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line`

## 4. Standing owner rules

- **"continue verifying" means RESUME the paused Source of Sales audit — never restart…** — `continue-verifying-resumes-sos-audit` · `sos-deep-audit-paused-checkpoint`
- **Open every reply with a single recommended next step — it goes FIRST, not last.** — `recommendation-goes-first-not-last` **(inline — load-bearing)**
- **The quoted words are a message he SENDS to Claude — never a physical act (a click, a file pick, a reset, a QR scan)** — `never-put-his-physical-actions-in-the-next-step-box` **(inline — load-bearing)**
- **Ask business-fact questions IN CHAT as multiple choice, never in prose** — `ask-business-questions-as-in-chat-multiple-choice` **(inline — load-bearing)**
- **A typed payroll Addition has NO ceiling — never re-propose one.** — `typed-payroll-additions-have-no-ceiling`
- 🛑 **THE MOBILE APP IS FROZEN — no work in it, no mention of it, no question to him about it, until HE lifts it in his own words** (owner golden rule, 2026-09-29). It outranks the two mobile rows below, which are ⏸️ DORMANT until then. — `the-mobile-app-is-frozen-until-he-lifts-it` **(inline — load-bearing)**
- ⏸️ **THE MOBILE APP IS A SHELL OVER THE WEB PORTAL — never rebuild a portal screen natively; native is login, CRM and Profile only** (dormant under the freeze; the live half is `phoenix_app_shell=1` defaulting FALSE, which protects the WEB portal's chrome) — `the-mobile-app-is-a-shell-over-the-web-portal` **(inline — load-bearing)**
- **A PUBLISHED AND ANNOUNCED MONTH IS NEVER CORRECTED, however wrong it is.** — `never-fix-a-published-and-announced-month` **(inline — load-bearing)**
- **A price can differ by PERIOD — Saginko is 111.15 through 2026-09 and 170.52 from 2026-10, and the product master stays 111.15** — `saginko-repriced-retail-from-october-direct-from-today` **(inline — load-bearing)**
- **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND…** — `never-horizontal-scroll-always-mobile-and-desktop-friendly` **(inline — load-bearing)**
- **THE DOCUMENT IDENTITY — every company document wears SATO-DIS-2026-01 v1.0** — `the-house-document-identity-standard` **(inline — load-bearing)**
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
- **SCOPE RUNS DOWNWARD ONLY — an employee never sees his own manager, nor anyone at or above his own RANK.** — `scope-runs-downward-only-never-your-own-manager` **(inline — load-bearing)**
- **Recruitment too: a DM never receives a DM CV — the automatic folders and the hand-push alike.** — `a-dm-never-receives-a-dm-cv` **(inline — load-bearing)**
- **An NSM's outstation expense is NEVER held** — `nsm-outstation-expense-is-never-held` **(inline — load-bearing)**
- **THE SYSTEM NEVER AUTO-APPROVES A PLAN — a DM's weekly plan is submit → NSM (or RSM if applicable) → HR acknowledge, with NO CEO stage.** — `the-system-never-auto-approves-a-plan` **(inline — load-bearing)**
- **The mailbox-monitor app-password entry is `imap` (was ___ until 2026-09-07), never "Phoenix".** — `mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix` **(inline — load-bearing)**
- **Turbify CANNOT issue app passwords centrally — the owner is STAYING, so do not…** — `turbify-cannot-issue-app-passwords-centrally-owner-stays` **(inline — load-bearing)**
- **A password reset does NOT revoke a Turbify mailbox — the app passwords survive it.** — `a-password-reset-does-not-revoke-a-turbify-mailbox` **(inline — load-bearing)**
- **Four sales-attribution facts that silently change a number.** `ez-is-credited-evenly-across-cairo-giza-cns-reps` **(inline — load-bearing)** `closing-reads-distributor-product-rollup-not-fact-rollup` **(inline — load-bearing)** `a-case-duplicate-line-map-row-doubled-a-whole-line` **(inline — load-bearing)** `owner-sheet-vocabulary-stores-is-office-upa-is-a-channel` **(inline — load-bearing)**
- **THE DIRECT-ORDER MONTH GOLDEN RULE — the month Finance books is the month the order COUNTS, at that pharmacy’s own brick and area.** `direct-orders-are-counted-in-the-month-finance-books-them` **(inline — load-bearing)**
- **NOT every distributor uploads every month — "N of 17 missing" is never a finding.** `not-every-distributor-uploads-every-month` **(inline — load-bearing)**
- **THE CALL RATE'S LEAVER AND WINDOW RULINGS ARE DECIDED, not defects** (owner chose B2/C1/D2): a leaver or new hire is divided by the WHOLE month's working days, a resigned rep DROPS OUT the moment HR marks him, and every call rate scores through YESTERDAY — the rate only. — `reps-list-rulings-b2-c1-d2-leavers-keep-whole-month` **(inline — load-bearing)**
- **THE 06:55 CRM DAILY DIGEST IS LIVE AGAIN — never delete its schedule** (refused 2026-09-27, restored 2026-09-28: "i want it in app or telegram only"). A declaration and its cron job move in one sitting, and a restored one also carries `watchingSince`. — `the-0655-crm-digest-is-refused-never-schedule-it` **(inline — load-bearing)**
- ⏸️ **MANAGED GOOGLE PLAY REACHES NO REP TABLET — the upload is dropped** (owner 2026-09-28; dormant under `the-mobile-app-is-frozen-until-he-lifts-it`). The enterprise has zero enrolled devices; the tablets are on Headwind, which installs an APK it hosts. The fleet artifact is `eas.json`'s `mdm` profile, never the store `.aab`. — `managed-play-cannot-reach-the-rep-tablets` **(inline — load-bearing)**
- **THE NDA STAYS HAND-STAMPED — never give the confidentiality undertaking a digital stamp or signature** (owner 2026-09-29); its 12mm cells have no room for a 34mm seal at any height, on a paper that prints two copies. — `the-nda-stays-hand-stamped-it-has-no-room-for-a-seal` **(inline — load-bearing)**

## 4.1 Marketing customer, venue and licence validation

- **Venue validation is GPS + a live picture ALWAYS — and leg 3 (the registered code,…** — `venue-validation-rule-gps-photo-then-code-or-licence`
- **A wholesaler / makhzan is NEVER shown as a candidate nor validated as a venue (both flows; two tiers).** — `wholesaler-makhzan-never-shown-or-validated-as-a-venue` **(inline — load-bearing)**
- **Marketing pharmacies are TERRITORIAL, and a NULL area_id makes one invisible.** — `seeded-marketing-pharmacies-have-no-area-and-are-invisible`
- **A licence verdict is PERMANENT and has no correction path.** — `a-licence-verdict-is-permanent-and-has-no-correction-path`
- **system_validated means NO HUMAN LOOKED.** — `marketing-system-validated-means-no-human-looked`
- **A venue's evidence was WRITE-ONCE, writable only at insert** — `marketing-venue-evidence-was-writable-only-at-insert`
- **The badge read a FROZEN note, never the live evidence** — `marketing-badge-read-a-frozen-note-not-the-live-evidence`
- **A duplicate merge STRANDS the desk validation on the retired row.** — `a-duplicate-merge-strands-the-desk-validation-on-the-retired-row`
- **The screen that SHOWS a badge is not the screen a rep can OPEN.** — `the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open`
- **A CROSS-GOVERNORATE DISTRIBUTOR CODE IS A TYPO, NOT A REP GAMING YOU — measure the distance first** (he asked it directly, 2026-09-29). Across all 127 validated links carrying GPS on both sides: median 23 m, max 1,069 m, nothing over 2 km, and both real incidents were 18 m and 59 m from the doctor. — `a-wrong-distributor-code-is-a-typo-not-a-rep-gaming-you` **(inline — load-bearing)**
- **`phx_resolve_marketing_pharmacy_codes` RUNS ONCE, AT CAPTURE, and nothing re-runs it** — a code entered before the sales master learned its pharmacy reads `unresolved` for good, so any "untraceable codes" count is inflated; never re-resolve in bulk, and read `validation_notes` first because `unresolved` can be a signed human verdict. — `the-marketing-code-resolver-never-re-runs` **(inline — load-bearing)**

## 6. Approval rules and git hygiene

- **A feature arriving in instalments is still ONE feature — hold the parts and open one PR** — `hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces` **(inline — load-bearing)**

