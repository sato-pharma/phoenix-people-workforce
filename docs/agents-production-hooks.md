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
- **`CRON_SECRET` lives in TWO stores**, so a half-rotation 401s; and **a nightly-failing cron
  alerts NOBODY** or is ignored. The 4 OFF iReports360 jobs are DELIBERATE.
  `github-actions-cron-secret-went-stale-after-a-railway-rotation` ·
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

