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
- **`railway variables --stdin` stores a BOM**, which then travels inside the value.
  `railway-stdin-bom-trap`
- **`railway ssh` JOINS argv and lands as ROOT** - the command you think you are quoting is not the
  command that runs. `railway-ssh-joins-argv-and-lands-as-root`
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
  printf '%s' "$secret" | gh secret set CRON_SECRET --repo Gawish-1997/phoenix-people-workforce
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
  !isProductionRuntime();` — including `/api/notifications/process`, `/api/notifications/daily`,
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
