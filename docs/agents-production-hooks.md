# Production and approval hooks — the full account

`AGENTS.md` §2.3 carries the **hooks**: one or two lines each, enough for a session to act correctly
before it knows it needs the detail. **This file is the fact** — the measurements, the dates, the
incidents that produced each rule, and the diagnosis traps that nearly sent each one the wrong way.

Same split `docs/agents-session-traps.md` (§2.1) and `docs/agents-owner-rules.md` (§4) run under, and
the same reason. `CLAUDE.md` pulls `AGENTS.md` in via `@AGENTS.md` **in full, on every request**, so
every byte of the detail below was being re-sent to the model on every turn of every session. The
hook is what has to be seen unprompted; the account is what gets looked up once. Keeping the account
here costs a session nothing until it goes looking.

**Do not move the memory slugs out of `AGENTS.md`.** `scripts/memory-index-reachability.mjs` resolves
a memory only if its slug appears **backticked in `AGENTS.md`**, and it never scans `docs/`. Measured
when this file was created: **all 18 of §2.3's slugs exist nowhere else in `AGENTS.md`** — more than
any other section — so relocating a single one would orphan that memory outright, and an unlinked
memory is invisible rather than merely hard to find. `AGENTS.md:237` states the rule; this section is
the sharpest case of it in the repository.

**Nothing below was rewritten.** The body is the verbatim §2.3 text as it stood at `ee6dd3dd6`,
immediately before the hooks were compressed. Where a hook in `AGENTS.md` now reads as a single
sentence, the paragraph it was compressed from is here in full.

---

### 2.3 Production and approval hooks (relocated from `MEMORY.md`, 2026-08-27)

**Compression ran out, exactly as §2.2 predicted it would.** Measured that afternoon, `MEMORY.md`
sat at **24,234 bytes against the 24,400 ceiling - 166 bytes of headroom**, with **zero** trailing
whitespace, **zero** double spaces, and **one** em-dash left (the August pass had already converted
the other 102). The only remaining lever was all 41 bold pairs, worth 164 bytes - and 166 bytes is
**less than one hook line**, so a trim could not have fitted even a single new pointer, let alone
the four that were waiting. So this block moved here instead, per §2.2's own instruction. Each name
is the memory file under
`C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\`.

Two lines that sat under the same `MEMORY.md` heading did **not** come with it - the Egypt-centroid
geocoding hook and the brick-mapping hook are data-quality facts filed under a Railway heading, not
production-ops guidance. They stay in the index.

**Railway deploys**

- **A deploy applies NO migrations**, and **auto-deploy can silently SKIP a race.** A merge that
  never shipped looks identical to one that did until you read `/api/healthz`.
  `railway-deploy-applies-no-migrations` · `railway-auto-deploy-can-silently-skip-a-race`
- 🔴 **THE DEPLOY IS GATED ON CI (Railway Wait for CI, 2026-09-27) AND THE GATE FAILS BY NOT
  SHIPPING.** Red, cancelled or still-queued check suites on the pushed commit withhold the deploy,
  and Railway then SKIPS it outright with nothing turning red — a second, larger way for "a merge that
  never shipped" to look like one that did. 🔴 **CORRECTED 2026-09-27: a RED conclusion skips it within
  MINUTES, not after two hours.** Measured on `2b654dd73` and `371200082`, merged 86 seconds apart and
  both `SKIPPED` about five minutes later, as soon as their CI concluded red. 🔴 **A red `ci.yml` is only
  the commonest cause, not the rule — ANY failed suite on the commit does it.** Measured 2026-09-27 on
  `cd9e0be03`: `checks`, `mobile` and `validate` were all `success` and the deploy was still withheld,
  because a **scheduled** `Deploy Drift Check` run attached a second `github-actions` suite to that sha
  and it concluded `failure` at 22:35:35Z — Railway marked the deployment SKIPPED at 22:35:40Z, five
  seconds later. So `gh run list --workflow=ci.yml` can read fully green on a withheld commit; read
  `gh api repos/<repo>/commits/<sha>/check-suites` instead. 🔴 **And read them with the right
  expectation: `sentry`, `claude` and `railway-app` are `queued` on EVERY commit and never
  report** (`vercel` was a fourth until the account move on 2026-10-27; its app is not installed on
  `it-gawish-hr`) — `1825e0b45` and `b91bd8c0c` both deployed `success` with all of them queued — so a
  *failed or cancelled* suite is the thing that withholds, a still-*running* Actions suite is the gate
  working, and those four are neither. The two-hour timeout is
  the case for a suite that never finishes at all; do not wait two hours before believing a red merge
  was withheld. 🔴 **And re-running that CI GREEN afterwards does NOT resurrect the deploy** — main's
  head was green from 23:11 Cairo and production stayed on the older commit. `railway deployment list`
  says `SKIPPED`; **GitHub only ever says `inactive`, the same word as a healthy superseded deploy**, so
  the tell is an `inactive` that was never `success` (`verify-shipped.mjs` prints `WITHHELD`). Staging
  deployed both fine, so staging proves nothing about production.
  `a-red-main-ci-makes-railway-skip-the-deploy-for-good` **Any** workflow on that commit counts,
  so a failed `staging-migrate` withholds production; `railway variables --set` bypasses the gate
  entirely. Never remove `push: main` from `ci.yml` to save minutes. Account:
  `docs/deployment.md`, "The deploy gate".
- **`railway variables --stdin` stores a BOM**, which then travels inside the value.
  `railway-stdin-bom-trap`
- **`railway ssh` JOINS argv and lands as ROOT** - the command you think you are quoting is not the
  command that runs. `railway-ssh-joins-argv-and-lands-as-root`
- 🔴 **`railway service scale <region>=1` ADDS a region rather than MOVING one, and the extra replica
  is live immediately.** Measured 2026-09-28 during the Headwind EU cut-over: the call answered
  `regions: EU West (1) · sfo (1) — 2 replicas`, which for an MDM server meant **two live copies
  writing one database** until it was corrected. The old region has to be passed `=0` in the SAME
  command, and the region map the call prints back is the thing to read before believing a move
  happened — the command succeeding says only that it accepted a region, not that it dropped one.
  Compounding it, a new Railway service in this account is created in `sfo`, so §3's "it must stay in
  Europe" needs an explicit scale on every new service and a re-read afterwards. The successful
  cut-over that followed: `phoenix-headwind` in EU West, `headwind-db-eu` on a
  `europe-west4-drams3a` volume with 52 tables, the `sfo` database frozen at 0 backends as the
  rollback, and latency 426 ms → ~245 ms, level with `phoenix-hr.satopharma.com`. 🔴 **THAT ROLLBACK
  IS GONE — `headwind-db` was DELETED on 2026-09-28 (~02:0x Cairo) at the owner's instruction once EU
  West was proven**, after confirming nothing in production or staging referenced
  `postgres.railway.internal`, the volume was attached to nothing else, the database had 0 non-self
  backends and three dumps verified at 52/52 TABLE DATA. **So the recovery story is now three hand
  dumps in `F:\PHX backup\headwind-db\` plus whatever orphaned volume Railway has not yet purged —
  verified live, not assumed** (see the volume hook in AGENTS.md §2.3: one of the two orphans has no
  purge date at all). Reported by the
  session that did it; the `=0` rule and the read-back are the parts that generalise.
- **`railway service source connect` is NOT environment-scoped — `--environment staging` REPOINTED
  PRODUCTION** (relocated from `MEMORY.md` 2026-08-28 together with its index line). The flag reads
  like `railway variables -e staging`, which genuinely is environment-scoped; this one is not. The
  CLI's own help says so: `-e, --environment <ENVIRONMENT>  Environment to use for resolving the
  service` — *resolving* the service, not choosing what to change. The git source is a
  **service-level** setting shared by every environment of that service, so connecting a branch
  repoints them all. Measured 2026-08-28 ~04:38 Cairo on this repo: one command meant as a
  staging-only test of an unmerged PR put `codex/retire-modules-control` on BOTH environments, and
  `https://phoenix-hr.satopharma.com/api/healthz` returned **`revision: 24f736bc`** — production
  serving an unmerged feature branch at full traffic, with two already-merged commits rolled back.
  The rule that follows is absolute: **a branch cannot be staged on Railway without shipping it**,
  so never reach for this command to preview anything. Four more things that incident proved,
  each of which nearly sent the diagnosis the wrong way. **Both environments moved together, and
  the revert moved both back** — that is how the service-level scope was confirmed from the other
  direction rather than assumed. **§7's "smoke-test on staging before a risky production deploy"
  therefore cannot be done by repointing a branch** — it needs a separate Railway service. The
  damage was never the feature: that branch was green on all four required checks and inert (0
  rows in `sidebar_module_assignments`, all 16 roles 200). The damage was that production
  silently **rolled back two commits merged minutes earlier** (#2508, #2509, recruitment fixes) —
  **a green branch is still the WRONG code when it is older than `main`, and `healthz` reporting
  `status: ok` hides that completely, so read the `revision`.** And last, `railway status
  --environment X --json` returns the WHOLE project, so a reader taking `environments.edges[0]`
  prints the same environment whatever `-e` says: staging and production printed identical lines,
  which reads as a parser bug and was nearly dismissed as one. Select by
  `.environments.edges[] | select(.node.name=="production")` and print the name you matched.
  `railway-service-source-connect-is-not-environment-scoped`

**Cron and secrets**

- **A PARTIAL `CRON_SECRET` rotation leaves TWO fingerprints**, and Healthchecks reading `up` is
  **not** proof of authentication - the grace window hides a 401. The 2026-08-23 401s are RESOLVED:
  **rotate NOTHING.** Always print `len` (the fingerprint is `Bearer …`, 71).
  `a-partial-cron-secret-rotation-leaves-two-fingerprints`
- **`CRON_SECRET` lives in TWO stores, and since the sync workflow existed the arrow points one
  way: GitHub Actions -> Railway production.** A half-rotation 401s.
  `sync-railway-production-secrets.yml` rewrites ~48 Railway production variables, `CRON_SECRET`
  among them, **unconditionally and without diffing** - on `workflow_dispatch` AND on any push to
  `main` touching that workflow or `scripts/sync-railway-production-secrets.mjs`.

  Measured **2026-08-31**: PR #2820 touched the `.mjs`, which fired run **33407660884** at
  15:18:11Z; its log reads `synced CRON_SECRET` and `completed: updated=48, skipped=7`. A
  production redeploy at 15:45:00Z activated the freshly-written value, and
  `ireports360-sync-cron` wrote 122 `audit_logs` notification rows at **15:48:20Z** - a cron route
  authenticating against the synced secret three minutes later. So the repository's copy is
  **current, not stale**: it was re-aligned on 2026-08-24, the day after the schedule moved off
  GitHub. **The comment in `direct-orders-sweeps.yml` telling you to re-align it was written
  2026-08-23 and was true only that day** - it has been corrected in place.

  **The live hazard is therefore the mirror image of the 2026-08-14 one.** That incident was a
  Railway rotation never mirrored *up* to GitHub, and it 401'd the two sweeps for nine nights. The
  standing risk now is a Railway rotation never mirrored up: it does not stick at all, because the
  next push touching either of those two files silently overwrites it with GitHub's copy - and
  that breaks **every** cron-job.org job at once, not two. Nothing in the PR, the workflow history
  or the app announces it. Compounding it, the sync passes `--skip-deploys`, so the clobbered value
  is inert until the next deploy: the breakage surfaces **detached from the change that caused
  it**, possibly days later, with a deploy of unrelated code as its apparent trigger.

  **Rotate the GitHub secret first and let the sync carry it down, or set both in one sitting.**
  Do not rotate as a ritual - AGENTS.md 2.3 records that the 2026-08-23 401s are resolved and that
  the standing instruction is to rotate nothing.

  **The guarded re-align** — the bare `railway | jq | gh` pipe is not safe here, because a past
  rotation stored a UTF-8 BOM unnoticed ([[railway-stdin-bom-trap]]) and GitHub is upstream, so a
  poisoned value does not sit harmlessly in a repo secret: the next qualifying push writes it into
  Railway production. Assert the bytes *before* writing, and never let the value reach a file, a
  log, or the session:

  ```bash
  raw="$(railway variables --environment production --service phoenix-people-workforce --json \
          | sed '1s/^\xEF\xBB\xBF//')"                              # strip UTF-8 BOM
  secret="$(printf '%s' "$raw" | jq -r '.CRON_SECRET' | tr -d '\r\n')"   # strip CR/LF
  [ "${#secret}" -eq 64 ] || { echo 'refusing: unexpected length'; exit 1; }
  printf '%s' "Bearer ${secret}" | sha256sum | cut -c1-16           # must equal the live fleet fp
  printf '%s' "$secret" | gh secret set CRON_SECRET --repo sato-pharma/phoenix-people-workforce
  ```

  `updated_at` moving proves the write landed; the pre-pipe fingerprint proves *what* landed. A
  GitHub secret cannot be read back, so those two together are the strongest proof available short
  of firing a workflow — and **do not fire `direct-orders-sweeps.yml` to test it**: it has no route
  selector and runs `direct-orders-probation`, which emails the owner and the CEO.

  Also **a nightly-failing cron alerts NOBODY** or is ignored. The 4 OFF iReports360 jobs are
  DELIBERATE. `github-actions-cron-secret-went-stale-after-a-railway-rotation` ·
  `a-cron-that-fails-nightly-can-do-so-forever-unwatched`
- **The cron-job.org REST API allows 100 requests per DAY** - 429 on EVERY endpoint with no
  `Retry-After`, and a bulk edit costs ~34 and CANNOT be rolled back.
  `cron-job-org-rest-api-is-100-requests-per-day`

**Production data**

- **NEVER rotate the Supabase DB password with `ALTER ROLE`** - Supavisor holds its own copy, so
  use the dashboard only. `28P01` vs `XX000` tells a stale password from a wrong host; nothing off
  the laptop uses it. `never-rotate-the-supabase-db-password-with-alter-role`
- **`expense_claims` is the ONE live RLS read path in production.** Put a precondition in every
  production `WHERE` when another session shares the queue, and remember **"Log out everywhere" is
  THREE writes.** `expense-claims-rls-read-path-is-live-in-prod` ·
  `guard-every-prod-write-when-another-session-shares-the-queue` ·
  `force-logout-everywhere-needs-three-writes`
- **Production has NO PITR — 7 daily physical backups are the whole recovery story** (relocated
  from `MEMORY.md` 2026-08-28 together with its index line). Verified 2026-08-13 against the
  Management API: `pitr_enabled: FALSE`, `walg_enabled: true`, 7 daily backups retained.
  **Healthy WAL archiving is not PITR**, and concluding otherwise is the easy mistake —
  `pg_stat_archiver` shows 11,309 segments archived with **0 failures ever**, pushing every ~120s,
  and every Supabase project looks like that; restore-to-a-timestamp is a paid add-on this project
  does not have. So on a database that pays real employees, **recovery granularity is one day and
  the restore unit is the whole database** — say that plainly before any bulk or destructive
  production change, and **never restore a daily backup in place**, which rolls back everything
  since roughly 07:30 Cairo that day. `production-supabase-has-no-pitr-only-daily-backups`
- **Payroll never reads `social_insurance_status` — the WAGE column alone decides the statutory
  filing, and neither statutory figure reduces take-home pay** (recorded 2026-08-31, after a night
  reconciling insurance across the whole workforce). Two separate traps, both of which read
  backwards, and the second of which I got wrong out loud several times before the owner's own
  constraint forced the check.

  **First: the status column is inert.** `employees.social_insurance_status` (`yes` / `no` /
  `pending` / blank) is display and data-entry only. Measured on `origin/main`:
  `git grep -n 'social_insurance_status\|socialInsuranceStatus' -- src/lib/payroll` returns **zero
  hits**; the column surfaces only in the directory, the import validator, the record-health check,
  the portal and the hiring pack. What decides is `employees.social_insurance_wage`:
  `src/lib/payroll/copilot/service.ts:132` selects exactly `hr_id,social_insurance_wage` with **no
  status column and no filter**, and `src/lib/payroll/copilot/assemble.ts:149` gates the entire
  statutory block on `input.statutory.insuranceWage != null && baseSalary > 0`. So the register and
  the filing can disagree **in both directions, silently**. Omar Anwar (B-10) sat marked `no` while
  carrying a 16,700 wage — the register said not insured and payroll filed him anyway; the mirror
  case is a `yes` with a null wage, where the register looks complete and the person is in no filing
  at all. `src/lib/employees/employee-record-health.ts:85` checks only that the status is one of the
  three valid strings and that a `yes` carries an insurance number — it never compares status to
  wage, so neither shape is a "missing field" anywhere in the app. **Never audit enrollment by
  status.** Query both columns and reconcile them both ways. Reconciled clean across all 106 active
  employees on 2026-08-31: `yes` 93 (92 filed), `pending` 8 (7 filed), `no` 4 (0 filed), blank 1 (the
  CEO). The wage rule is the owner's own — base ÷ 1.3, capped at **16,700**, with the statutory basic
  wage printing as a flat **2,450**; `payroll_statutory_config` carries employee 11%, employer
  18.75%, floor 2,700, effective 2026-01-01 (Law 148/2019). A `pending` person **with** a wage is
  correct and intended: enrolled, awaiting the Authority's number.

  **Second: neither statutory figure is deducted from anything.** They are called deductions and they
  deduct nothing. `socialInsurance` appears in exactly **five** places in `assemble.ts` (132, 151,
  157, 318, 396) and none reaches the amount paid — `totalDeductions` is
  `crm + fingerPrint + unpaidVacations + medicalInsurance + loans + otherDeductions`, while
  `governmentalDeductions` is a separate reported line holding
  `socialInsurance + employmentIncomeTax`. The payable amount comes from `calculatePayrollParts`,
  fed by the first total. The protected `src/lib/payroll/policy.ts` confirms the other side:
  `calculateNetSalary` is `base + extraCostOfLiving + fuelAllowance` and `totalPayable = netSalary +
  variableAdjustments`, with neither statutory figure anywhere in either. **Sato absorbs both.** I
  asserted repeatedly that setting a wage "starts deducting 1,837/month from pay" (11% of the
  ceiling), and it was the owner's constraint *"but do not deduct anything from net or base"* that
  forced the check which disproved it — the plausible reading is the wrong one, and the payslip's own
  governmental-deductions line does nothing to correct it. So **setting or correcting an insurance
  wage is safe for take-home pay**: it changes who is filed and what the employer owes, never what
  the employee receives. Do not warn the owner it will cost someone money, and never withhold a wage
  for that reason — withhold one only when the person is genuinely not yet enrolled, because the wage
  is precisely what puts them in the filing.
  `payroll-reads-the-insurance-wage-never-the-status` ·
  `social-insurance-and-tax-never-reduce-take-home-pay`

**Which environment the code thinks it is in** (the first two relocated from `MEMORY.md`
2026-08-27, and they live HERE now — their index lines are gone, so this block is the only thing
that recalls them. The room that bought paid for the `APP_ENV` hook, which does have an index
pointer: the index carries the hook, this block carries the detail.)

- **A LOCAL run writes PRODUCTION but silently skips every email**, and **the local Resend key CANNOT
  send** — it is restricted, on an unverified domain. Send from production with `railway run`.
  `local-run-against-prod-db-silently-skips-every-email` ·
  `local-resend-key-is-restricted-use-railway-run-to-send-from-production`
- **STAGING cannot rehearse a PRODUCTION shape** — the surgery that proved this was only ever made
  against prod. `staging-cannot-rehearse-shapes-only-prod-surgery-made`
- **`APP_ENV` was UNSET on Railway `staging`, so staging identified itself as PRODUCTION** — and two
  things quietly depended on that. `isProductionRuntime()`
  (`src/config/system-settings.ts:61`) and `currentEnvironmentLabel()`
  (`src/lib/error-monitor/service.ts:69`) both read `APP_ENV || VERCEL_ENV || NODE_ENV`, and a
  Next.js production build sets `NODE_ENV=production` **on staging too**. Measured 2026-08-27: 43
  staging variables, no `APP_ENV`; production had it. **Fixed** with
  `railway variables --set "APP_ENV=staging" -e staging -s phoenix-people-workforce`, proven by
  POSTing one synthetic error to staging's `/api/errors/client` and reading the row back
  (`environment: production` → `staging`; both probe rows deleted after).
  `app-env-unset-on-staging-made-it-look-like-production`
- **The email fail-safe did NOT cover staging.** `isForceTestingDelivery()` returns
  `!isProductionRuntime()` when `PHOENIX_EMAIL_FORCE_TESTING` is unset, and its own comment says
  that default "keeps preview/dev from emailing real people" — but on staging it evaluated
  **false**, inverted exactly where it was needed. Staging was safe only because
  `PHOENIX_EMAIL_FORCE_TESTING=true` is set explicitly: **one variable, nothing behind it.**
- **FIXED 2026-08-27 (PR #2479) — the `APP_ENV`/cron-secret hole below is closed, all 22 of 22.**
  Until this PR, **18** cron/notification routes carried `if (!secret) return
  !isProductionRuntime();` — including `/api/notifications/process`, `/api/notifications/daily` (retired 13 Nov 2026),
  `/api/cron/background-jobs`, `/api/cron/recruitment-email-intake` and
  `/api/sales/master-map/sheet` — while only **4** (the three `ireports360-visits-*` plus
  `reconciliation-check`) used the hardened form `if (!secret) return process.env.NODE_ENV ===
  "development";`. Labelling an environment non-production used to flip that branch from closed to
  open, so with `CRON_SECRET` absent one variable change exposed all 18 at once — proven live on
  Railway staging: `MASTER_MAP_SYNC_TOKEN` was unset there, and `/api/sales/master-map/sheet`
  served ~49.7k customer records unauthenticated until this PR shipped. PR #2479 moved the
  remaining 18 onto the hardened form, so **`APP_ENV` no longer affects this fallback at all** —
  `process.env.NODE_ENV` is inlined at `next build`, so every deployed build (Railway has no
  `NODE_ENV` set on either environment) resolves the bypass closed regardless of `APP_ENV`. The
  `⚠ NEVER set APP_ENV without confirming CRON_SECRET` warning that stood here is retired for this
  specific risk — **`APP_ENV` still matters for the separate `isForceTestingDelivery()` email
  fail-safe two bullets up, which this PR did not touch.**
  **Treat `!isProductionRuntime()` as an auth fallback with suspicion generally, still:** it reads
  as "only in dev" and means "anywhere not labelled production", which includes any environment
  where someone simply forgot the label — the pattern regenerates itself if a future route copies
  it from an old comment instead of the current hardened routes.
- **The `railway` CLI is linked to `production` here** (`railway status` → `Environment: production`),
  so every variable command needs an explicit `-e staging`. Omitting it would set `APP_ENV=staging`
  on PRODUCTION, flipping `isProductionRuntime()` false there and redirecting **real employee email**
  into the test inboxes. Re-read both environments after any such change. Setting a variable **does**
  trigger a redeploy (unless `--skip-deploys`), and the change is inert until that deploy reaches
  `SUCCESS`.
- **That deploy fires in SECONDS but serves in MINUTES — and reading the gap as "no deploy" is a
  mistake already made here.** Measured on staging 2026-08-28: environment settled on `96fa5e19`
  `SUCCESS`; `railway variable set` at **08:57:42Z**, no `--skip-deploys`; deployment `6c805087`
  created **08:57:46.663Z** — 3 seconds later, on the SAME commit `fdc63919`, with no push behind
  it. Production carries the identical shape: `e84f0c05` at 07:57:56Z on `8f27b62b`, with no commit
  to explain it. So for the first minutes a correct trigger and a missing one look alike — the old
  container is still serving and the variable appears inert. On 2026-08-24 a session read exactly
  that window as proof Railway does **not** restart on a variable change, ran an explicit
  `railway redeploy`, and wrote the inverted rule into a memory file, where it stood until
  2026-08-28. **Confirm by listing DEPLOYMENTS, never by probing the running app**, and never
  `railway redeploy` to make a variable "take" — that is a second build of the same commit.


---

## Relocated from `AGENTS.md` §8 — 2026-09-01

Verbatim, unabridged. Two sessions relocated overlapping content here on 2026-09-01; the two
bullets that duplicated the fuller accounts above (`railway service source connect`, and payroll
vs `social_insurance_status`) were verified to carry no fact those accounts lack, and were dropped
the same day. The slug stays in `AGENTS.md`.

Verbatim, unabridged. The cue — and every memory slug — stays in `AGENTS.md`; the account is here.

- **Owner-confirmed exception (2026-08-02):** `mcp__45bb6356-8105-4482-9464-25bfd754baec__*` is the owner's own claude.ai Supabase connector. He confirmed ownership and instructed its removal from the deny list, so it is callable. **VERIFIED 2026-08-23: it is back IN that list, so the previous sentence no longer describes live state.** `permissions.deny` in `~/.claude/settings.json` currently holds **two** entries — `mcp__b345e47e-…` *and* this connector — and a `deny` is a silent hard block rather than a prompt, so a session following the sentence above hits a wall with no dialog to explain it. **OWNER DECISION 2026-08-23: leave it DENIED.** He was asked directly and answered plainly, so this is settled — the connector stays in `permissions.deny`. Do not re-allow it, do not propose re-allowing it, and do not read a blocked call as a bug to chase. Nothing is lost by the block: the two named servers in §3 cover routine work, and this connector's grant was always the broader, riskier one. Note its consent grant is **broader than either named server** — read+write on Secrets, Environment, and Projects, meaning it can read project secrets and create or delete projects. Reach for the named servers first; use this one only when it is actually the right tool. Its DB writes fall under the pre-authorized grant above (announce destructive/bulk prod changes; no wait), but **creating/deleting a project or reading secrets is NOT covered — get an explicit go for those** (see §6).

## Section 2.3 was trimmed to its floor — 2026-09-01

**What was done.** §2.3 went from **5,723 → 5,526 bytes, −197 B (3.4%)**, the best yield of the four
section passes run on 2026-09-01. `AGENTS.md` went **69,500 → 69,303**. Invariants held across the
whole file: **241 bullets, 12 🔒, 15 🔴, 31 memory slugs — an identical slug set before and after.**
Proven by arming the guard first: removing `payroll-reads-the-insurance-wage-never-the-status` made
`runMemoryIndexReachabilityTests` go RED with *"every memory the map marks load-bearing must still be
named in AGENTS.md"*; all three memory-index suites were green after restoring it.

### The one real duplicate: the `railway status` jq selector

§2.3's `railway service source connect` bullet ended with *"`railway status --environment X --json`
returns the WHOLE project; select by `.environments.edges[] | select(.node.name=="production")`."*
That same selector sits in §3, in the bullet about confirming the production service source branch,
and **§3's copy is the fuller one** — it names the real `--environment production`, says to print the
name you matched, and carries the follow-on read
`.node.serviceInstances.edges[].node.latestDeployment.meta.branch` that §2.3's copy did not have.
§3's bullet already cross-references *"See §2.3"* for the environment-scoping rule, which stays where
it is. So the shorter copy went (−137 B) and the operation is still fully described, once, in the
place you need it.

Reach is unchanged — the whole file auto-loads — so this cost scannability only. That is §2.2's
*"Reach is identical; only scannability differs"* spent deliberately, for the fourth time today.

### Three hooks that were a status, a date, a PR number and a count

§2.2 requires a hook to be **"durable (never a count, a status or a date)"**. Three lines in §2.3 were
all four at once, and each has its full record in this file:

- *"**FIXED 2026-08-27 (PR #2479) — the `APP_ENV`/cron-secret hole is closed, all 22 of 22.**"* →
  *"**The `APP_ENV`/cron-secret hole is CLOSED — do not re-chase it.**"* (−23). The instruction a
  session acts on is "do not re-chase it"; the date, the PR and the 22-of-22 sweep count are
  provenance, and a count in particular goes stale the moment the surface grows.
- *"**Fixed 2026-08-27.**"* on the `APP_ENV`-unset-on-staging bullet → *"**Fixed.**"* (−11).
- *"The 2026-08-23 401s are RESOLVED"* → *"The past 401s are RESOLVED"* (−6). What stops the mistake
  is **rotate NOTHING**, not the date it was decided.

The preamble also lost *"full"* and *"and unabridged"* (−20), matching the wording §2, §4 and §5 now
use.

### Nothing else in §2.3 is fat

The section is 22 bullets in 5,526 bytes, ~250 each. The two largest were left untouched on purpose:

- The **payroll insurance** hook (663 B) is the longest line in the section and every clause of it is
  load-bearing — that the wage column alone decides the filing, that the status is display-only, that
  the register and the filing disagree *both ways*, that neither figure reduces take-home pay, and
  the standing instruction never to warn the owner that setting a wage costs an employee money. It
  carries two memory slugs. Shortening it is how someone ends up auditing by status.
- The **HELD payroll row** hook (447 B) is the same shape: the filter, the silence, HELD = OWED PART
  2 ONLY, and the double-pay that follows from getting it wrong.

**PITR** (375 B) was also left verbatim. It is the sentence that has to be said out loud before any
bulk production change, and every clause of it — one-day granularity, whole-database restore unit,
never restore in place, roughly 07:30 Cairo — changes what a session does.

### Where the campaign stands after four passes

| Section | Before | After | Yield |
| --- | --- | --- | --- |
| 2.1 Session-level traps | 19,789 | 19,060 | −729 (3.7%) |
| 4 + 4.1 Standing owner rules | 14,264 | 13,995 | −269 (1.9%) |
| 5 Session/worktree safety | 5,838 | 5,696 | −142 (2.4%) |
| 2.3 Production and approval hooks | 5,723 | 5,526 | −197 (3.4%) |

**1,337 bytes across four passes.** In every one, the largest single cut was a duplicate rather than
wording — and in every one the wording-only remainder came to roughly 1% of the section. §3 (5,520 B)
is now the only section over 5KB that has not been passed over; on this evidence it should be
expected to yield around 150 bytes, not more.

**The arithmetic that matters is still on the other side.** PR #2880 added 884 bytes to §2.1 in one
commit — two thirds of everything four editing passes have recovered. Cue in `AGENTS.md`, account in
`docs/`, enforced when the hook is written, is the only lever with a better rate than that.

## New hook — the venue resolver cache goes stale, and reads as unmappable (2026-09-03)

**The hook is in §2.3, "Production data".** This is the account.

**What was audited.** A sweep of the marketing to CRM to Source-of-Sales links reported *"6 of 345
rows in `marketing_customers` have a NULL `area_id`"*, against the §4.1 rule that marketing
pharmacies are territorial and a NULL `area_id` makes one invisible. **Two things in that framing
were wrong, and both are worth keeping.**

**First, the table was the neighbouring one.** `public.marketing_customers` holds **207 rows with
zero** NULL areas. The 345/6 measurement belongs to `public.marketing_pharmacies`. The two tables sit
side by side with near-identical columns — `area_id`, `region_name`, `extracted_area_name`,
`captured_*`, `validation_status` — so a query written against the wrong one returns a clean,
plausible, entirely misleading answer. **Confirm the row count matches the claim before working the
claim**; here the count was the thing that caught it.

**Second, the harm did not bite.** All 6 NULL-area rows were `active = false`, and **all 335 active
pharmacies already carried an area**. They were also excluded by a second, independent condition:
the reusable-pharmacy workspace query in `src/lib/marketing-requests/service.ts` filters
`.not("owner_hr_id", "is", null)` as well as `active`, and all 6 have no owner. `area_id` was not
what hid them. Fixing it was still right — a row reactivated later would have become genuinely
invisible — but it was latent hygiene, **not a live blind spot**, and saying otherwise would have
overstated the finding. The 6 were an unowned import batch created 20 Jun 2026, 16:45–16:48 Cairo,
never validated, no photo, no GPS; the other 4 inactive rows are app-minted `MKT-PHA-*` venues with
real owners, and they kept their areas.

**THE TRAP.** `marketing_pharmacy_distributor_codes` carries `mapped_area_code`, `mapped_brick_id`,
`reference_status` and `master_match_kind`. **These are a cache, not an authority.** Five of the six
resolved straight off it. The sixth — حضانة زمزم, a `nursery`, code `0001511111` — read
`reference_status = not_found`, `master_match_kind = unresolved`, every `mapped_*` column NULL. On
that reading it was unrecoverable, and the next step under §4's standing rule would have been an XLSX
of candidate areas put to the owner.

**It was not unrecoverable. The cache was ten days out of date.** `master_resolved_at` on that row is
**9 Aug 2026, 12:16 Cairo**. The `source_of_sales_customer_map` row that answers it was written
**19 Aug 2026, 23:57 Cairo** — `source = direct-order-evidence-hadanat-zamzam-2026-08-19`,
`confidence = 90`, exact customer code, exact name `حضانة زمزم`, address `الزراعة بالمحلة الكبرى`,
brick `B192-1` (المحله الكبرى), area **D15, Gharbia 2 (Mahalla)**. A re-resolution of a *different*
row four hours earlier the same evening (19 Aug, 19:55 Cairo) had still missed it. The venue's own
inactive link to a doctor in D15 agreed independently.

**So the question would have been asked of the owner about a fact production already held.** That is
the cost of the trap, and it is silent in both directions: no error, no staleness marker, and a
`not_found` that looks like a settled answer rather than a stale one.

**Same shape as `au.f_monthly_achievement` in §2.1** — a precomputed rollup whose fingerprint does not
cover the data that would invalidate it. Treat any `mapped_*` / `*_resolved_at` pair as that family:
**the resolved-at timestamp is the question, not the verdict.**

**What was set.** All six recovered from the registered distributor code against the live map — the
owner's rule that the registered code beats live GPS, applied to the column that governs sight.

| Venue | Area set | Independent confirmation |
| --- | --- | --- |
| محمود محمد موسى -الشهداء | Menoufia 1 (D12, id 1101) | code `PS/0001576768`, exact name; brick الشهداء |
| هبه خالد البدرشين | Giza - Giza Centers (GZ1, id 1113) | code `PS/0001537376`, exact name; brick البدراشين |
| حضانة زمزم | Gharbia 2 (Mahalla) (D15, id 1104) | live map only; address and linked doctor both Mahalla |
| السنترال - سمالوط ت | Minia 1 (UE1, id 1123) | code `PS/0001511917`, exact name; brick سمالوط |
| صيدلية خاصة بمستشفى تبارك للاطفال | Haram - Faisal (GZ4, id 1116) | own code `IS/431302` exact name, and POS `0001533787`, both to GZ4 |
| مصطفى احمد وحيد القوصية | Assuit 1 (UE3, id 1125) | code `PS/0001548234`, exact name; brick القوصيه |

In every case the brick's Arabic name is the town in the venue's own name, every code returned
exactly one active map row, and no area is a Delta (3) moved area. Post-state: 345 rows, **0 NULL
areas**, 345 valid area FKs, 335 active / 10 inactive unchanged, **0 other columns changed**.
`updated_by_hr_id` was deliberately left NULL — no person made the edit, and §2.1 already records
that this column lies about who wrote a row.

**Rollback.** `marketing_rollback.pharmacy_area_null_pre_20260903`, 6 rows, areas preserved as NULL.
Per §2.1 a `create table … as select` copies rows but never RLS: **measure that table's ACL before
assuming anything about it either way.**

## New hook — a deploy queue reads exactly like a rollback (2026-09-03)

Two PRs merged 56 seconds apart on 2026-09-03: `#2988` at 06:48:36 Cairo (`b668474d8`) and `#2994`
at 06:49:32 (`ede6b8435`). `main`'s tip was `ede6b8435`, with `b668474d8` as its parent. Production
then served **the parent**, and the GitHub deployments API read:

```
deployment 6236566561  ref=ede6b8435  created 03:49:37Z  in_progress   <- the NEWER commit
deployment 6236577761  ref=b668474d8  created 03:50:45Z  success       <- the OLDER commit
/api/healthz           revision=b668474d8...  status: ok
```

The older commit's deployment carries the **later** `created_at`, because Railway stamps the record
when a build goes live rather than when it starts. Sorting deployments by `created_at` therefore puts
the older commit on top and makes production look like it reverted a merge that had just landed
green.

Every signal matches the `railway service source connect` incident in §2.3: production serving a
commit that predates a merge, `status: ok` hiding it, and only `revision` telling the truth. The two
are distinguished by the **state field, not the timestamps** — a real rollback has no `in_progress`
deployment for the newer commit, whereas a queue does. Here `ede6b8435` finished ~3 minutes later
and took over on its own.

What made the call safe was content, not timing — the same lesson as the merged/stranded rule in
§2.1:

```
git merge-base --is-ancestor ede6b8435 <live revision>   # ancestor => nothing was reverted
```

The wrong move — re-merging, forcing a `railway redeploy`, or reconnecting the service source —
would have shipped a second production deploy to fix a queue that was already resolving, and
`source connect` in particular is the one command that turns this false alarm into the real thing.

Cost of the mistake if unwritten: a session reads a normal two-merge morning as a production
incident. Sessions here merge back-to-back constantly (~30 commits/day), so the window recurs daily.

## New hook — the duplicate-identity test cannot fire across distributors (2026-09-03)

`confirmDirectOrderCleanup` carries an identity standard that reads as strict and safe:

> Identity is proven by a shared distributor customer code — never by a similar name.

The intent is right: Arabic pharmacy names vary by spelling, honorific, and whether the district is
appended, so name similarity has already merged two different venues here. But the test the sentence
describes is **structurally incapable of returning true** on the commonest duplicate shape, and a
session that treats "no shared code" as "not duplicates" is reading a check that never ran.

Every distributor issues customer codes from its **own** catalogue. `direct_order_pharmacy_distributor_codes`
exists precisely because one venue holds many — one row per distributor. Two pharmacy rows created
from two different distributors' order files therefore **cannot** share a code, no matter how
certainly they are the same building. The two pairs merged on 2026-09-03 show it directly:

```
survivor 75adc578  محمد عبد الغني عزبة النخل   B12-11    EP-PHS 1504555     PS 0001546814
survivor f7956f28  الجناينى ميت غمر            B187-11   EG     50977       PS 0001503292
```

The formats do not even collide — `EG` issues 5 digits, `EP-PHS` 7, `PS` 10 zero-padded. There is no
value either pair could have held that would have made the shared-code test fire.

**What to use instead — evidence that satisfies the standard's intent.** For these two it was: an
order returned and re-raised byte-identically by the same DM in the same brick, and two distributors
independently recording the same building number for one venue. Both are far stronger than a name
match, and neither is a code match.

**What not to do.** Do not relax the rule to name similarity — that is the failure it was written
against. Do not merge on your own inference either: put the pair to the owner with the evidence, as
was done here. A merge is reversible in principle (`merged_into_pharmacy_id` survives) but the orders,
codes and CRM links move with it, and production has no PITR.

Cost of the mistake if unwritten: a session sweeps for duplicates, finds no shared codes, and
reports the venue list as clean — while the cross-distributor duplicates, which are most of them,
sit untouched and keep splitting one pharmacy's sales across two rows.


## New hook — the 255 append-only actor rows stay lower-cased (2026-09-05)

**What happened.** On 2026-09-05 the actor-id casing audit repaired 92 write sites and 3,460
production rows. `AccessContext.hrId` is the lowercase comparison key, and persisting it verbatim
had split one person into two in every per-actor report. One column could not be repaired:
`ats_candidate_status_events.actor_hr_id`, 255 rows, because the table is append-only —
`ats_candidate_status_events_immutable` refuses UPDATE and DELETE and a second trigger refuses
TRUNCATE. **That refusal is the guard working, not a failure.**

**What was designed, and then declined.** The repair would have amended the trigger to permit
exactly one kind of UPDATE: one where `to_jsonb(new) - 'actor_hr_id'` equals the old row (so every
other column, including any added later, is byte-identical), the actor is the same person
case-insensitively, and the value actually differs. Delete and truncate untouched. That is provably
casing-only and cannot rewrite who decided what, or when.

It was still declined, and the reasoning is worth keeping because the design looks good enough to
tempt a future session into rebuilding it:

- **Nothing is broken by the 255.** Every comparison in the application routes through
  `canonicalHrIdKey`, which lower-cases both sides, so `b-10` and `B-10` are already one identity.
- **The one pattern that would be fooled** — a raw `.eq` against the column — is pinned by
  `tests/hr-id-storage-casing.test.ts`, which runs in the required CI `validate` job.
- **The writer is fixed**, so the count cannot grow.
- **The rows are not wrong.** They are an accurate record of what the system wrote at the time.
  Repairing them makes the table tidier, not truer.
- Against all of that: a permanent write path into a hiring-decision audit trail, to change how a
  name is capitalised.

**The move that must never be taken instead.** Disabling the trigger for the duration of an UPDATE
fails OPEN — a session that errors between DISABLE and ENABLE leaves the whole history writable with
nothing saying so — and for that window it grants the power to change anything at all, including who
decided and when.

**Owner decision, 2026-09-05: leave them.** Offered with the design in hand and declined. A safety
classifier had already blocked the migration before it was written, which was the correct call and
is worth noting: the block is what turned a plausible repair into a decision the owner made.

## New hook — one area, several teams, because a team is named for a region (2026-09-09)

**What happened.** Four active sales reps were found with no `team_id`: Samah Ashraf and Shimaa
Ibrahim on Anti Infective, Ahmed Farag on Anti Infective, and Ebtissam Alaa, added the same day.
Every one of their areas already had a team, so the obvious repair was to attach each rep to it.
The owner was asked first, and asked for correctly named teams to be created instead. That instinct
was right, and the reason is worth writing down because the obvious repair is silently wrong.

**The model.** `public.teams` is keyed on `area_id`, but `teams.name` holds a REGION and `teams.code`
is `<area code>_<region slug>` — `d11_delta_1`, `d24_delta_2`, `ab5_alex_bhr`. That was unambiguous
while an area belonged to exactly one region.

**What broke the assumption.** The Delta (3) migration is line-specific: on Anti Infective the five
areas moved to Delta (3), and on CNS and Pedia they did not move at all. So one area now sits in two
different regions depending on the line, and the teams table has no line column to say so. Kafr
El-Sheikh 1 is the same shape from the other direction — Alex-BHR on Pedia, Delta (1) on Anti
Infective — and that one predates Delta (3) entirely, so this is not a migration artefact to tidy
away.

**Why the obvious repair is wrong twice over.** Attaching Samah to the existing `d11_delta_1` files
an Anti Infective Delta (3) rep under a team named Delta (1). Renaming that team instead is worse:
it holds a Pedia rep and a CNS rep for whom Delta (1) is correct, so the rename fixes one person by
breaking two. Neither failure surfaces anywhere — the area matches in both cases, which is exactly
what makes it read as correct.

**The rule.** Resolve a person's team from their own seat, not from their area. `au.v_org_tree`
carries `region_name` per seat, and joining an employee's open `au.occupancy_history` span to it
gives the region that the team name must equal. Where no team exists for that pair, create one on
the existing `<area>_<region>` convention rather than renaming a sibling.

**What was done, 2026-09-09.** Three teams created — `d11_delta_3` and `d24_delta_3` named
`Delta (3)`, and `d16_alex_bhr` named `ALEX-BHR` — each carrying a description naming the split.
Ahmed Farag needed none: his seat sits in Delta (1) and Gharbia 1 already had a correctly named
Delta (1) team, so he joined it. Verified afterwards that all four team names equal their seat
region and that no active sales employee is left without a team, down from four. No existing team
was renamed and no other employee row was touched; the triggers on `public.employees` were read
first and none fires on `team_id`.

**One measurement worth keeping.** `employees.team_name` and `employees.department_name` are dead
columns: 0 of 107 active employees have either populated, while 105 carry a `team_id`. They are
export-only twins that the seat path deliberately leaves null, so an emptiness sweep will flag them
as a data-quality gap. They are not one. Read `team_id` and join.

## New hook — a held re-mapping is dropped with no error (2026-09-11)

> **RETIRED 2026-10-10.** The owner removed the Mapping Guard completely (see `docs/source-of-sales-decisions.md`, "The Mapping Guard retirement"): the triggers, the decide functions and the permits table are dropped, so nothing below is live. It stays as the account of why the guard once existed.

`sos_map_guard_customer` (PR #3647) is a `BEFORE INSERT OR UPDATE OR DELETE` trigger on
`public.source_of_sales_customer_map`. It holds a move when either of two things is true: the row's
existing `source` matches `^(owner-|final-new-)` or equals `sheet-verified`, or
`sos_map_region_of_area` resolves the old and new areas to different regions. A held row is written
to `sos_map_change_log` with `outcome = 'held'` and queued in `sos_map_change_holds`, and the
trigger **returns `null`**.

**Returning `null` is the whole trap.** The statement does not fail, nothing is raised, and no
notice is emitted. The only visible effect is that `UPDATE ... RETURNING` yields fewer rows than the
target list, which a session reads as a count and reports as success.

Measured on production this morning. A 111-row batch built from the distributors' own territory
columns ran as one guarded `UPDATE` and reported `asked 111, changed 99`. Every one of the 12
missing rows passed every guard written into the statement itself — still active, still not carrying
a ruling of the owner's, target brick still active, area still different — so the statement's own
predicates could not explain the gap. All 12 crossed a region boundary. `sos_map_change_holds` held
them as ids 189 to 200, and `sos_map_change_log` for the same window read 99 applied and 12 held.

**Read the log, never the row count.** `sos_map_change_log.outcome` is the authority on what a write
actually did, and `sos_map_change_holds` names each held row with its reasons in plain words.

### Releasing a hold

`sos_map_guard_decide(p_hold_id bigint, p_decision text, p_actor text)` is the only sanctioned path.
`p_decision` must be `approved` or `rejected`; anything else raises. On approval it inserts a permit
into `sos_map_guard_permits` scoped to `txid_current()`, the table and the entity key, applies the
change from the hold's `after_json`, marks the hold, then deletes the permit. `sos_map_guard_permit_for`
is what the trigger consults, and it matches only within the same transaction.

The design intent is written into the function itself: the permit **names the hold it came from**,
so a writer cannot assert an approval that never happened. A session that inserts its own permit row
to push its own change through defeats the guard exactly as the comment warns. Do not do it; put the
hold to the owner and release it on his word, passing his words as `p_actor`.

⚠ **Before `20260913020000`, `sos_map_guard_decide` wrote `brick_id`, `area_code`, `region_code`,
`source` and `active` — and nothing else.** `mapped_by` and `confidence` kept their pre-hold values,
so a released owner ruling landed below confidence 100 and did not bind (214 rulings, repaired by
hand 2026-09-13; pre-images in `is_twin_backup_20260911.release185_pre_20260913` and
`release185_holds_pre_20260913`). That migration makes the customer-map branch carry both from the
hold's `after_json` (falling back to the row's own values). A follow-up update touching neither
brick nor area still passes without a new hold, because the trigger's `v_moves` check is false.

The batch that produced this entry finished at 111 of 111, with a pre-image of every changed row in
`sos_backup_20260911.customer_map_pre_territory`.

## `AGENTS.md` §2.3 Production and approval hooks — as it stood before the 2026-09-12 condensation

On 2026-09-12 `AGENTS.md` was cut to roughly half its size at the owner's request ("Load less of AGENTS.md"): every hook was reduced to its rule plus the one detail needed to obey it. This is that section's hook text **verbatim** from `origin/main` 3eea44aef, kept so that no measurement, date, count or diagnosis a condensed hook dropped is lost. Search it for the hook's wording. The accounts earlier in this file remain the fuller record.

**Each line is the rule, not the evidence.** The account of every one — measurements, dates, incidents,
and the diagnosis traps that nearly sent each the wrong way — is in
**[docs/agents-production-hooks.md](agents-production-hooks.md)**, verbatim.

**Railway deploys**

- **A deploy applies NO migrations**, and **auto-deploy can silently SKIP a race.** A merge that never shipped looks identical to one that did until you read `/api/healthz`.
- **Two merges inside a minute make production look ROLLED BACK when it is only QUEUED.** Railway stamps the GitHub deployment when a build goes **live**, not when it starts, so the **earlier** commit's deployment carries the **later** `created_at` and serves while the newer one is still `in_progress` — every reading matches the `source connect` rollback above. **Read the deployment STATES, never their timestamps:** one `in_progress` beside one `success` is a queue, not a revert. Settle it with `git merge-base --is-ancestor <your merge> <live revision>`, then re-read `revision` a minute later — do NOT re-merge or `railway redeploy`.
- **`railway variables --stdin` stores a BOM**, which then travels inside the value.
- **`railway ssh` JOINS argv and lands as ROOT.**
- 🔴 **`railway service source connect` is NOT environment-scoped — `--environment staging` REPOINTED PRODUCTION.** The git source is **service-level**, shared by every environment, so **a branch cannot be staged on Railway without shipping it** — never use it to preview, and §7's staging smoke-test needs a **separate service**. Production silently ROLLS BACK whatever was merged since, and `healthz` reporting `status: ok` hides it — **read the `revision`.**

**Cron and secrets**

- **A PARTIAL `CRON_SECRET` rotation leaves TWO fingerprints**, and Healthchecks reading `up` is **not** proof of authentication — the grace window hides a 401. The past 401s are RESOLVED: **rotate NOTHING.** Always print `len` (the fingerprint is `Bearer …`, 71).
- **`CRON_SECRET` lives in TWO stores and the arrow points GitHub → Railway.** `sync-railway-production-secrets.yml` rewrites ~48 Railway production variables unconditionally, so **rotating in Railway alone does not stick** — the next push reverts it and every cron-job.org job 401s at once. **Rotate GitHub first.** A nightly-failing cron alerts NOBODY; the 4 OFF iReports360 jobs are DELIBERATE.
- **The cron-job.org REST API allows 100 requests per DAY** — 429 on EVERY endpoint with no `Retry-After`, and a bulk edit costs ~34 and CANNOT be rolled back.

**Production data**

- **NEVER rotate the Supabase DB password with `ALTER ROLE`** — Supavisor holds its own copy; use the dashboard only. `28P01` vs `XX000` tells a stale password from a wrong host.
- **`expense_claims` is the ONE live RLS read path in production.** Put a precondition in every production `WHERE` when another session shares the queue, and remember **"Log out everywhere" is THREE writes.**
- **255 lower-cased `ats_candidate_status_events.actor_hr_id` rows are STAYING, by owner decision 2026-09-05 — they are not a defect to sweep.** Every other actor column in the database was canonicalised that day; this table refused because it is append-only, which is the guard working. **Nothing is broken by them**: every comparison in the app runs through `canonicalHrIdKey`, so `b-10` and `B-10` are already one person, and the naive raw `.eq` that would be fooled is pinned by `tests/hr-id-storage-casing.test.ts` in the required CI check. The writer is fixed, so the count cannot grow. **Repairing them would mean opening a write path into a hiring-decision audit trail to change how a name is capitalised** — offered, designed, and declined. Do not re-propose it, and do not disable the trigger for a minute.
- **The `expense_claims` mirror builds `claimed_total` and `approved_total` from TWO DIFFERENT TABLES** — the claim from `outstation_expense_requests.claimed_total_amount`, the approval from `outstation_expenses` — so a STALE REQUEST HEADER, not an over-approval, is what breaches `expense_claims_approved_total_range`. The hourly rebuild deletes and re-inserts all four mirror tables in ONE transaction, so **416 claims froze because of 2**, and reads are live on that mirror: a stale claim is not wrong on screen, it is ABSENT. **Read the expense components before touching an approved amount** — both known cases were approved for exactly what the trip cost. The rebuild now FLAGS such a row (`data_quality_hold`, counted in `flagged`) instead of dying on it.
- 🔴 **Production has NO PITR — 7 daily physical backups are the whole recovery story**, and healthy WAL archiving is not PITR. Granularity is one day and the restore unit is the whole database: say so plainly before any bulk or destructive production change, and **never restore a daily backup in place** — it rolls back everything since roughly 07:30 Cairo that day.
- 🔴 **Payroll NEVER reads `social_insurance_status` — the `social_insurance_wage` column ALONE decides the statutory filing, and NEITHER statutory figure reduces take-home pay.** The status is display-only, so register and filing disagree **both ways, silently** — **audit by querying both columns, never by status.** Both are reported as `governmentalDeductions` yet are **absent from the deductions that feed payable**: the company absorbs them, so setting a wage costs the employee NOTHING. Never warn the owner a wage will cost someone money. `payroll-reads-the-insurance-wage-never-the-status` · `social-insurance-and-tax-never-reduce-take-home-pay`
- 🔴 **A HELD payroll row is DROPPED at publish, silently.** `publishToPayslips` filters `!onHold`: no `salary_record` is written and **nothing records the out-of-system payment**. **HELD = OWED PART 2 ONLY** — paying full net double-pays part 1, so validate part 2 against PUBLISHED rows. `payroll_eligible=false` is NORMAL for executives. Read `hold_reason` and never re-raise. `a-held-payroll-row-is-dropped-at-publish-and-leaves-no-trace`
- **A `not_found` on `marketing_pharmacy_distributor_codes` means "unresolved when the resolver LAST RAN", not unmappable** — `mapped_area_code`/`reference_status` are a CACHE, and `master_resolved_at` can PREDATE the `source_of_sales_customer_map` row that answers it. **Join the live map before telling the owner a venue's territory cannot be recovered**, or you will put a question to him that production already answers. Same shape as `au.f_monthly_achievement` in §2.1 — a precomputed answer that goes stale with no error and no staleness marker.
- 🔴 **A shared distributor customer code CANNOT prove two direct-order venues are the same — and the cleanup's own standard asks for exactly that.** `confirmDirectOrderCleanup` states *"identity is proven by a shared distributor customer code — never by a similar name"*, but every distributor issues codes from its OWN catalogue, and `direct_order_pharmacy_distributor_codes` exists precisely so ONE venue holds MANY. Two rows sourced from two distributors therefore **can never share one**, so on the commonest duplicate shape the test does not return false — **it cannot fire at all**, and "no shared code" reads as *not duplicates*. Satisfy the standard's INTENT instead: byte-identical order lines from one DM in one brick, or two distributors independently recording the same building number. **Never merge on name similarity, and never on your own inference — put the pair to the owner.**
- 🔴 **A `teams` row belongs to an AREA but is NAMED for a REGION, and since Delta (3) one area sits in different regions on different LINES — so an area holds SEVERAL teams, and RENAMING one corrupts the lines that were right.** Resolve from the occupant's SEAT region (`au.v_org_tree.region_name`), never from the area's existing team: the obvious move files a Delta (3) rep under Delta (1) and reads as correct because the area matches. `team_name`/`department_name` are DEAD (0 of 107) — read `team_id`.
- ⏸️ **RETIRED 2026-10-10 — `sos_map_guard_customer` no longer exists, so a customer-map `UPDATE` is never held or dropped.** The trap below is history; see "The Mapping Guard retirement" in `docs/source-of-sales-decisions.md`.

**Which environment the code thinks it is in**

- **A LOCAL run writes PRODUCTION but silently skips every email**, and **the local Resend key CANNOT send.** Send from production with `railway run`.
- **STAGING cannot rehearse a PRODUCTION shape.**
- **`APP_ENV` was UNSET on Railway `staging`, so staging identified itself as PRODUCTION** — `isProductionRuntime()` and `currentEnvironmentLabel()` both read `APP_ENV || VERCEL_ENV || NODE_ENV`, and a Next.js production build sets `NODE_ENV=production` on staging too. **Fixed.**
- **The email fail-safe did NOT cover staging.** `isForceTestingDelivery()` returns `!isProductionRuntime()` when `PHOENIX_EMAIL_FORCE_TESTING` is unset — inverted exactly where it was needed. Staging is safe only because that variable is set explicitly: **one variable, nothing behind it.**
- **The `APP_ENV`/cron-secret hole is CLOSED — do not re-chase it.** **Treat `!isProductionRuntime()` as an auth fallback with suspicion anyway:** it reads as "only in dev" and means "anywhere not labelled production".
- **The `railway` CLI is linked to `production` here**, so every variable command needs an explicit `-e staging`. Omitting it writes to PRODUCTION — and for `APP_ENV=staging` that would redirect **real employee email** into test inboxes. Setting a variable **does** trigger a redeploy (unless `--skip-deploys`), and the change is inert until that deploy reaches `SUCCESS`.
- **That deploy fires in SECONDS but serves in MINUTES — reading the gap as "no deploy" is a mistake already made here.** **Confirm by listing DEPLOYMENTS, never by probing the running app**, and never `railway redeploy` to make a variable "take".

## The Railway CLI link names an environment, never a service

**Measured 2026-09-27.** `AGENTS.md` §2.3 has always said "the `railway` CLI is linked to
`production`". That is true about the *environment* and silent about the *service*, and the silence
hides a wrong answer: the link lives in `~/.railway/config.json`, keyed by absolute path, and

| path | service |
| --- | --- |
| `F:\Phoenix Workforce\phoenix-workforce` (the PRIMARY) | **`phoenix-headwind`** — device management |
| every `F:\Phoenix Workforce\_wt-*` worktree | `phoenix-people-workforce` — the app |

The project holds four services — `phoenix-cron`, `phoenix-people-workforce`, `phoenix-headwind`,
`headwind-db-eu` — so "linked to production" never identifies one. (Read live 2026-09-28. It was
`headwind-db` until that database was deleted for `headwind-db-eu`; a service list in a doc goes
stale the moment one is added or removed, so re-read it with `railway status --json` rather than
quoting this line.)

**Why this is worse than a wrong default.** `railway run -- <cmd>` from the primary injects only the
`RAILWAY_*` built-ins: 119 variables reach the child and `CRON_SECRET` and `CRONJOB_API_KEY` both
read as **absent**. `scripts/cronjob-sync.mjs` then answers *"CRON_SECRET is not set (environment or
.env.local). Nothing done."* — which reads as a missing or half-rotated secret. There is a standing
hook one line away warning that a partial `CRON_SECRET` rotation leaves two fingerprints, so a
session that believes the message goes hunting a rotation that never happened, against the standing
rule **rotate NOTHING**. The bearer was verified healthy the same day: `len` 71, matching a job
firing 200s.

**The fix is one flag:** `railway run --service phoenix-people-workforce -- <cmd>`.

**From a worktree** the CLI answers `No linked project found` instead, because `scripts/new-session.mjs`
copies `.env.local` but not `~/.railway/config.json`, and writing that file is refused as unauthorized
persistence. So from a worktree: use the `--service` flag from the primary, or have the owner run
`railway link` once.

## A second Railway project deploys this repo, and nothing documents it

**Measured 2026-09-27, read-only from the GitHub deployments API.** Every push to `main` produces
**three** deployment records, not two:

| environment | project |
| --- | --- |
| `Phoenix-HR-Workforce / production` | `dc218ad3-99b7-4aff-be38-953a57524a71` — the documented one |
| `Phoenix-HR-Workforce / staging` | same project |
| **`superb-smile / production`** | **`83a26007-1a15-4356-aff8-91ef9092bc98` — documented nowhere** |

It is **not failing** — its deployments reach `success`, the previous record going `inactive` as the
next takes over, which is a service genuinely being replaced per merge rather than a build retrying.
`railway list` confirms `superb-smile` is a real project in the account.

**106 deployments, 1:1 with `main`, from 2026-09-25T21:12:51Z to 2026-09-27T17:51:50Z.**

🔴 **AND THE FIRST ONE NAMES THE ORIGIN.** That earliest deployment is sha `56f57245f` =
**`Run Headwind on Railway, and use RustDesk own relay` (#4434)**, merged 2026-09-25 23:44 Cairo — the
stray project first built **28 minutes after that commit landed**. The mechanism is almost certainly
this repository own runbook: [devices/headwind-rustdesk.md](devices/headwind-rustdesk.md) step 133
reads *"New -> GitHub Repo -> `it-gawish-hr/phoenix-people-workforce`. Name the service
phoenix-headwind."* Run from the Railway dashboard ROOT rather than from inside the existing project,
that creates a NEW auto-named project wired to the repo default branch instead of a service in the old
one — and `superb-smile` is exactly Railway auto-generated project-name style. So this is one misclick
during a setup the runbook asked for, not an intrusion and not `railway service source connect`.
**OWNERSHIP IS ANSWERED; THE MECHANISM IS NOT — and the difference decides what to ask him.**
**Ownership:** the owner has stated, unprompted and in his own words, that he did not create this
project (his reply to a session that asked him directly, 2026-09-27). That is his statement, not an
inference, so **do not ask him again whether it is his** — he runs a dozen sessions and the same
question arriving twice in an evening is a real cost to him.
**Mechanism:** still unconfirmed. The runbook-misclick theory above is evidenced by the 28-minute gap
and the auto-generated name, but he has not said he clicked New Project, and he would have no reason
to remember doing so if it was a misclick. **Confirm the mechanism before writing it as settled
history** — and note that the two halves have different standards of proof.

🔴 **METHOD, because it caught two sessions on the same afternoon: an unfiltered or unpaginated
deployments query UNDERSTATES a per-environment floor.** An unfiltered 100-record page dilutes this
environment 1-in-3 and put its start 22 hours late; a filtered page that is itself full put it 1h 46m
late, and reads like a real answer. Only `gh api --paginate` with `?environment=` returns all 106. The
tell is the same one as every other page-edge trap in these docs: the oldest row being also the
"first" row.

**Two consequences.**

1. **It is the second reason "production deploys are gated on CI" is false.** Railway's Wait-for-CI is
   a per-service setting; a toggle on `phoenix-people-workforce` cannot gate a *different project*.
   Separately, the primary deployment record is created at or one second BEFORE the first check-run
   exists on the commit (`98ed75c83`: first check-run 17:00:41Z, deployment 17:00:40Z), so there may
   be nothing for the gate to wait on at evaluation time. See [deployment.md](deployment.md).
2. **Nobody is watching it.** A second deployment of a payroll application, outside every runbook,
   every drift check and every health probe in this repository.

🔴 **Do not touch that project.** Creating or deleting a Railway project is a production surface and a
money move — the owner's dashboard, his click. A plausible origin, worth confirming with him before
it is written as history: §2.3 already records that `railway service source connect` is **not**
environment-scoped and once repointed production while being run with `--environment staging`, so a
session trying to stage a branch could have created a fresh project instead.

## An orphaned Railway volume's purge date appears on a delay

🔴 **AN ORPHANED VOLUME'S PURGE DATE APPEARS ON A DELAY, AND AN ABSENT DATE IS NOT "never".**
Measured 2026-09-28, after `headwind-db` was deleted. `railway volume list` is the only readout that
says anything true here — the CLI's own `volume delete` prints `Volume "<name>" deleted` while the
volume stays listed, `volumeDelete` returns clean, and the GraphQL `Volume` type has no `deletedAt`
field at all, so a query keeps returning it as if nothing happened.

The two orphans looked like different species and were not:

| volume | first read | read ~2 h later |
| --- | --- | --- |
| `postgres-volume-we4X` (238 MB) | `Deletes on: Sep 30 2026 12:09 AM` | unchanged |
| `postgres-volume-0WKb` (931 MB) | **no schedule at all** | `Deletes on: Sep 30 2026 2:38 AM` |

A session (this one) wrote a hook saying 0WKb "has no schedule and will sit there until someone
removes it", and put it to the owner as a decision. Acting on that would have hand-deleted 931 MB
Railway was already going to purge — and the recovery story it was weighed against is three dumps in
`F:\PHX backup\headwind-db\` totalling 720 KB, which is the whole of it. **Read the list twice,
hours apart, before concluding an orphan is permanent.**

## New hook — an unparseable workflow file withholds EVERY production deploy (2026-09-29)

**The hook.** 🔴 **A workflow file that does not parse is not a quiet no-op: GitHub fails a run on
EVERY push, and that red suite withholds that commit's production deploy.** The tell is a failed run
whose **name is the file path** and which has **zero jobs** — GitHub prints the path because it never
learned the workflow's name. Read `actions/runs?head_sha=<full sha>` and compare the run NAMES, not
just their conclusions.

**What it cost.** `staging-hr-drift-check.yml` was merged at 18:37 Cairo (#4769) with its Telegram
message written as a literal multi-line shell argument, so seven lines sat at column 0 while the
`run: |` block's content was indented ten spaces. A YAML block scalar ends at the first line indented
less than its parent, so the document was invalid from `${DRIFT_SUMMARY}` onward.

Production then climbed through the deploys queued before that commit and **stopped dead at
`58b134936`**, the last one before it. Six commits — `945dac575`, `b6302bdb3`, `861750043`,
`f7c55f85c`, `305112798`, `46512864a` — were all marked `SKIPPED`, including the repair for an
organogram outage the owner was waiting on. **`ci.yml` was green on every one of them.**

**Three things that made it hard to see, and the measurement that settled each:**

- The workflow declares only `schedule` and `workflow_dispatch`, and its own comment says "Never on
  push or pull_request" — yet every run was on `push`. A workflow cannot trigger on an event it does
  not declare, so that contradiction IS the diagnosis: GitHub could not read the triggers.
- It had **10 runs, all failure, all with 0 jobs**, the oldest 6 minutes before the file merged. A
  workflow that has never once succeeded is a new one that never worked, not a flaky one.
- On the same commits in the same minutes, `ci.yml`, `staging-migrate.yml` and
  `staging-branch-sync.yml` carried real names and **succeeded** — which rules out billing, an outage,
  or "production is behind" as the cause. A parallel session was holding merges on exactly that
  theory; a quiet window cannot converge, because each new commit gets a fresh red suite of its own.

**Recovery.** Repair the file (or disable the workflow) and merge it. The next green commit ships and
carries the whole stranded backlog in one deploy — never re-merge, never `railway redeploy`. Pinned
by `tests/workflow-files-parse.test.ts`, which scans every workflow for a line at column 0 that is
not a top-level key and runs in the required `checks` job. Build multi-line text with `printf`;
newlines belong in a format string, never in the YAML.

## New hook — the deploy queue can promote an OLDER build, and a dropped column makes that fatal (2026-09-29)

**The hook:** the queue lands builds out of order, so production can serve an older commit than it
did a minute ago with nobody clicking anything. Harmless on its own. Not harmless once a migration
has dropped a column.

### What was measured

A backlog of eleven merges drained over about forty minutes. `/api/healthz` `revision`, read
directly:

| Cairo | Live revision | Position on `main` |
| --- | --- | --- |
| 19:58 | `5f1f40305` | 8th |
| 20:00–20:02 | `85f5a7db7` | **4th** |
| 20:04 | `3c576e7d8` | 9th |

Production moved **backwards four commits** and then forwards again. Each reading was settled, not
a flicker: three reads eight seconds apart at 20:02 all returned `85f5a7db7`, and fourteen rapid
reads at 20:04 all returned `3c576e7d8`. **So it is not a replica split** — that was the first
hypothesis and it was wrong; it is a slower build finishing after a faster one and being promoted.

Railway's own deployment list agreed and was confusing on its own: `5f1f40305` read `success`
while `/api/healthz` reported a different commit, and two rows sat at `in_progress` long after
their commits were in the serving code.

### Why it stopped being a curiosity

`ec33c37f6` (#4775) dropped `public.employees.team_name`, the fourth and last denormalized label
on that table. Every build before it still sends the column in a PostgREST select list —
exactly one, `src/lib/reports/organogram-au-source.ts`:

```
"hr_id, full_name, name_ar, work_email, mobile_number, job_title, employment_status,
 contract_type, contract_renewal_date, hire_date, departments(name), team_id, team_name,
 line_id, manager_hr_id, organogram_visible"
```

PostgREST fails the **whole** request on an unknown column, so a promotion of any build at or
before `5268f1238` does not degrade the Team column — it blanks **every occupant name in the
organogram**, and nothing turns red.

**The only reason it did not happen is that no build that old was in the queue.** All three active
deployments contained `ec33c37f6`. That is luck, not a safeguard: the backwards step landed on the
4th commit, and the danger line was the 3rd.

### What to do — written up elsewhere, deliberately not repeated here

**The rule belongs to #4790, which merged four minutes before this page was written and says it
better:** `docs/agents-session-traps.md` and the **Migrations** cluster of
`docs/agents-session-traps-clusters.md`. Dropping such a column is two deploys and never one; the
failure is a `42703` on the whole read rather than a blank field; the field comes out of the
TypeScript type too or a read quietly re-adds it and still typechecks; a `create table … as
select` pre-image copies rows but not RLS; and re-adding the column **empty** restores the read
fully, because the label was dead data.

Only one thing here is not there: the measurement above — that out-of-order promotion is a thing
Railway **observably does**, not a hypothetical in the list of ways an old build can land.

**Why this page says so instead of quietly repeating it.** Both records were written the same
evening by two sessions that could not see each other's work, and the duplicate went into
`AGENTS.md`, which auto-loads in full on every request, while #4790's went into the clusters file,
which is read on demand. That is the expensive direction. The `AGENTS.md` §2.3 hook has since been
cut to the measurement and a pointer. If you are about to document a hazard, run
`git worktree list` and `gh pr list --state all --search <keyword>` first: the branch that already
held this rule was sitting in output this session had printed twice.

### Two reading errors this cost, both worth keeping

**Elapsed time is not evidence of refusal.** A deploy that had sat unserved for half an hour was
read as withheld and a redeploy of it was proposed to the owner — after `verify-shipped.mjs` had
already classified it *"NOT refused — every check suite on it concluded success"*, the benign
superseded kind that §2.3 says is carried forward by the next merge. It was carried forward, on
its own, minutes later. The measurement was in hand and the narrative won.

**"Production went backwards" is not a single fact.** It was then asserted that the regression had
taken `ec33c37f6` out of service with it. It had not: `85f5a7db7` is one commit *above*
`ec33c37f6`, so the drop's precondition held throughout. The positions had just been printed.
Check each commit's ancestry against what is actually serving — `git merge-base --is-ancestor
<sha> <live revision>` — never against the shape of the story.

## New hook — a succeeded deploy can leave the domain routing to nothing (2026-09-30)

### What was measured

Merging #4866 at 10:37:26 Cairo, with three production builds already queued, the **production
domain and staging both stopped serving at once**:

```
$ curl -s https://phoenix-hr.satopharma.com/api/healthz          # 10:37:50 Cairo
{"status":"error","code":404,"message":"Application not found","request_id":"gn6YuZ3iTNqIY8S4nbOCzg"}

$ curl -s https://phoenix-people-workforce-staging.up.railway.app/api/healthz
{"status":"error","code":404,"message":"Application not found","request_id":"OZKWxokPQnyiGMu2jUJq2g"}
```

Two services, two domains, two different Railway request ids, the same answer. By 10:39:47 both
were serving again with no intervention of any kind:

```
$ curl -s https://phoenix-hr.satopharma.com/api/healthz          # 10:39:47 Cairo
{"status":"ok","service":"phoenix-hr","revision":"bca114bb2e1f5c7b9c4ba2882d1d4b06e4067e11", ...}
```

`status.railway.com` read **Fully Operational** throughout, with 100% uptime across Edge Network
and EU West for the preceding 90 days, and no check, run or deployment row anywhere went red.

### Why it is a distinct failure mode, and not one §2.3 already had

The four modes §2.3 documents are all about a deploy that never *reached* the serving position —
**withheld** (a red or queued suite, marked `SKIPPED`), **superseded** (a newer merge landed while
it waited), **absent** (no run and no deployment row at all), and the queue **promoting an older
build**. Every one of them is diagnosed by reading deployment states and ancestry, and in every one
the app keeps serving *something*.

This one is the opposite shape. The deploy succeeds, the states are healthy, ancestry is fine — and
for a couple of minutes the domain has nothing attached to answer for it. `"Application not found"`
is Railway's **router** speaking, not the application: the request reached the edge (it carries a
Railway `request_id`) and the edge had no service for that Host. So it cannot be seen in
`/deployments`, cannot be seen in `check-suites`, and is invisible to every tell in §2.3.

### The trap it sets for a verifier

`verify-shipped.mjs` reads the live `revision` as one of its four sources. With the edge answering
404 there is no `revision` to read, so it prints:

```
  live revision  (unreadable)  (error, -)
  note: healthz answered with no revision - the platform variable is missing, not the deploy
VERDICT: CANNOT TELL — a source did not answer - see the notes; do not act as if it shipped
```

`CANNOT TELL` is exit **5**. A wait loop written to continue only while the verdict is `QUEUED`
(exit 2) therefore **stops here and reports CANNOT TELL as its final answer** — which reads as a
failed deploy when the deploy was fine and the loop simply gave up. That happened in this session:
the loop ended on its first attempt, 24 seconds after the merge, and had to be re-armed to continue
through exit 5 as well as exit 2. Any loop waiting on a deploy must treat 5 as transient.

### What not to do

Nothing. The recovery took under two minutes and needed no action. The standing bans all apply and
all point the same way: **never `railway redeploy`, never re-merge, never `railway service source
connect`.** A 404 at the edge is not evidence about the deploy at all, so acting on it means acting
on no evidence — and `source connect` has repointed production before.

Classify on whether a `revision` comes back **at all**:

- a `revision` that is not yours → the queue, or a supersede; read states and ancestry (§2.3).
- **no `revision`, because the edge 404s** → this mode. Read it again a minute later.
- a `revision` that is yours → shipped.

### Evidence relocated here from the §2.3 hooks, to keep AGENTS.md inside its enforced share

The hook above this one in §2.3 carried its own measurements inline. They are facts worth keeping
and cost every request to hold, so they live here now and the rules stay there:

- **The flaky-cron withholding**, 2026-09-27 on `cd9e0be03`: `checks`, `mobile` and `validate` were
  ALL green and the deploy was withheld by `deploy-drift-check.yml`'s own scheduled run, because a
  scheduled workflow attaches its check suite to whatever commit is `main` HEAD when it fires. Fixed,
  and pinned by `tests/deploy-drift-settled-ref.test.ts`.
- **The third-party suites** — `sentry`, `claude`, `railway-app`, and `vercel` until the account move
  on 2026-10-27 (three since: read live on `618a1ebda`) — were measured sitting at `queued` forever on
  two commits that deployed `success`, which is why they never hold the gate and are never worth chasing.
- **Dependabot, which is not a workflow in this repository at all**, 2026-09-30: it cannot patch a
  TRANSITIVE advisory (`allowed-updates: direct`), so it retried, failed, and attached a red suite to
  whatever commit was `main` HEAD each time — **withholding THREE production deploys, one of them the
  repair for the critical `next/og` RCE**, which sat unshipped for 32 minutes and reached production
  only because an unrelated revert merged behind it and carried it forward. Re-running Dependabot green
  resurrects nothing; the cure is an override in `pnpm-workspace.yaml`. This is the reason the hook says
  to read `check-suites` rather than the CI run: `ci.yml` was green on every one of the three.
- **A suite that goes red AFTER the deploy already reached `success` costs nothing** — #4919 and #4915
  both shipped carrying one. That is why the tell is red WHILE Railway is still waiting, and not merely
  red on the commit; a session using the looser test reports healthy deploys as withheld.
- **The benign supersede**, 2026-09-28 on `047a33388`: one `inactive` status, no `in_progress` at
  all, and the commit was carried forward inside the next deploy.
- **Two rows per commit, both ending `inactive`**, measured 2026-09-29 across five merges: on a
  superseded commit BOTH rows pass through `success` first, so a session reading only terminal
  states concludes the withheld-tell fires falsely. One nearly had that hook rewritten to remove it.
  `/deployments/<id>/statuses` returns NEWEST FIRST, so `| last` hands back the OLDEST while looking
  final — ask `--jq 'any(.[].state; . == "success")'` over the whole history instead.
