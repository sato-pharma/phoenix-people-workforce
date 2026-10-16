# Incident history behind the AGENTS.md rules

[AGENTS.md](../AGENTS.md) states the rules. This file holds the evidence behind them — dates, PR
numbers, billing figures, measurements, and superseded state.

**Why it is split this way.** AGENTS.md is loaded into context on every single turn of every
session; this file is read on demand. Measured 2026-08-13, the always-loaded set (CLAUDE.md +
AGENTS.md + the memory index) cost ~15,400 tokens *per turn*, and §2 and §3 of AGENTS.md were
~3,100 of those — almost entirely narrative that an agent does not need in order to obey the rule.
The rule and its one-line reason stay there. The story lives here.

Nothing in this file is optional reading when you are actually changing the thing it describes.
If you are about to touch branch protection, CI cost, the deploy path, or the region, read the
relevant section here first.

---

## Branch protection and the required checks

`main` is branch-protected: `enforce_admins: true`, force-pushes and deletions blocked, and **2
required status checks** (`validate`, `checks`) that **DO gate every merge** — a PR cannot land
until both are green on its head commit.

🔴 **`mobile` STILL REPORTS AND NO LONGER BLOCKS; `secret-scan` DOES NOT REPORT ON A PR AT ALL.**
Both were demoted on 2026-09-29, minutes before #4800 took `secret-scan` off the pull request
entirely (gitleaks moved into the pre-push hook, `bash-guard.mjs` clause C12, where a key never
reaches GitHub at all). So a red Expo typecheck no longer stops a PR — read it on the commit rather
than assuming the gate caught it — and a PR with no `secret-scan` row is correct, not uncovered.

🔴 **THE COUNT IS THE PART THAT ROTS. It has been 4, then 5, then 6, then 4, and is 2 — and after
every single change the docs kept stating the old one.** On 2026-09-27 PR #4527 folded `lint`,
`typecheck` and `test` into one `checks` job (GitHub rounds every job up to the minute, so three
jobs paid that rounding three times; ~14% fewer billable minutes), branch protection was repointed at
`checks` in the same window, and **`lint`, `typecheck` and `test` stopped existing as check
names.** Nineteen places in this repo still said six afterwards, including `.claude/skills/ship`
and `.claude/skills/verify-context` — the two things a session follows to merge. One session
followed `ship`, counted to six, and waited on three checks that could never report. **So: read
`branches/main/protection/required_status_checks` live before stating or counting anything, and
treat every list in the repo — including this one — as a description, never a source.**

**It was 4 until 2026-09-18**, and both names added that day had been outside the gate by oversight
rather than by decision. `test` was split out of `validate` on 2026-09-17 (#3950) for speed, and
the new job's own header said in as many words that it "has to be added to branch protection's
required checks, because `validate` is required and no longer runs the tests" — that step never
happened, so for a day a PR with a red unit suite showed four green required checks and merged.
`mobile` (#3974) was created the next day and had never been listed. Both were added with a
surgical `PATCH` to `branches/main/protection/required_status_checks` in the `checks` array form,
which keeps `app_id: 15368` (GitHub Actions) on every context; the deprecated `contexts` form sets
`app_id: null` and would let **any** app satisfy a check by name. Nothing else in the payload moved
— `enforce_admins`, reviews, force-pushes, deletions and `strict: false` were read before and
after and were identical.

**Both new names come from jobs that always run and always report**, which is what made them safe
to require: a skipped job reports no status, and a required check with no status blocks a PR
forever. `mobile` therefore decides *inside* the job whether to do the work — its detect step
answers `true` for anything it cannot resolve — and on a PR that never touches `mobile/` the whole
check costs about nine seconds.

**`secret-scan` is required and blocking.** — superseded 2026-09-29: demoted to non-blocking and
taken off `pull_request`; see this section's demotion note above and `AGENTS.md` §2.3. The rest of
this paragraph still holds. It is the gitleaks job in
`.github/workflows/security-scan.yml`, which #1889 deleted on 2026-08-08 believing it was optional
and #1894 restored the same day (`3cb11791`), dropping the original `--exit-code 0` that had made
the job incapable of failing. Semgrep's `sast-scan` was deliberately **not** restored (4m14s per PR
against gitleaks' 13s, and Sonar covers overlapping static-analysis ground) — so SAST does not run
at all, but secret scanning does, and it is this repo's only automated secret detection
(`security_and_analysis: null`; GHAS is not purchasable on a personal account).

Required conversation resolution is **off**. Required approving reviews is **0**, dropped
2026-08-04: a solo owner cannot approve his own PR, so the previous `required_approving_review_count: 1`
deadlocked every self-authored PR; CI is the gate instead.

`allow_auto_merge: false`, so `--auto` is rejected outright anyway.

Full protection payload re-verified live 2026-08-09.

## Why "require branches to be up to date" was turned off

Turned OFF on 2026-08-05 (owner-approved) because it was the dominant Actions cost:

- July billed **5,933 Linux minutes ($17.26 net)**.
- **Aug 1–5 alone billed 11,391 minutes ($50.00 net)** — ~12x the daily burn, tracking to
  $400+/month. It hit the spending cap on 2026-08-05, freezing every merge.

The mechanism: at **278 PRs merged in five days (74 on 2026-08-05 alone)**, every open PR fell
behind `main` within minutes of any unrelated merge, and each `update-branch` moved the head SHA,
so **all 5 checks then running re-ran from scratch and the prior green run was discarded**. Re-runs
scaled as open-PRs × merges-per-day, not additively — measured 3–16 CI runs on a single branch in
one day.

If GitHub ever *does* refuse a merge as *"not up to date"*, the strict setting has been turned back
on — confirm before assuming the rule is wrong:

```bash
gh api repos/Gawish-1997/phoenix-people-workforce/branches/main/protection --jq '.required_status_checks.strict'
```

## `gh pr update-branch` acts on the server

It merges base into head with no rebase, no force-push, and no history rewrite, so it needs none of
the section 6 approvals a rebase would. But it creates that merge commit **on the remote**, so the
local branch silently falls behind and the next `git push` is rejected with *"remote contains work
that you do not have locally"* — which reads like someone else pushed. Hit live 2026-08-04 on #1727.

GitHub may suggest `--auto` and `--admin`; both are wrong here — `--auto` is banned, and
`enforce_admins: true` means `--admin` does not bypass protection anyway.

## The 2026-08-01 Railway cutover

A merge to `main` shipping straight to production **reversed on 2026-08-01**. Railway is
GitHub-connected and deploys on push, at full traffic, with no cron wait, no staged rollout, and no
smoke test. The old Cloud Run pipeline did all four of those things and is gone;
`deploy-cloud-run.yml` and `deploy-cloud-run-staging.yml` are trigger-disabled, so a
`deploy: skipped` there is now expected rather than informative.

Verified live 2026-08-04: `/api/healthz` `revision` returns the running commit SHA, e.g. `6ae2528c`,
not `null`.

## Railway topology and the region move

Railway project `Phoenix-HR-Workforce` (id `dc218ad3-99b7-4aff-be38-953a57524a71`, env `production`
`cd5600e6-99dd-4b1c-80b2-16af8770abef`), service `phoenix-people-workforce`, 1 replica.

It ran in `sfo` (US West) from the 2026-08-01 emergency cutover until 2026-08-09. That cutover had
silently discarded the colocation deliberately set on 2026-07-17 in
`.github/workflows/deploy-cloud-run.yml` (`REGION: europe-west3`, commented "same metro, ~1ms" /
"~57ms from Cairo vs ~146ms from Iowa"), leaving the app on the far side of the planet from both its
database and its users.

Measured on `/api/healthz`, a route that does zero work: **~204ms server-side from `sfo` (n=10)
against ~75ms from `europe-west4` (n=12)**. Moved with:

```bash
railway service scale --service phoenix-people-workforce --environment production europe-west4-drams3a=1 sfo=0
```

Region verified live 2026-08-09 via `railway status` (reports `region: EU West`); rest of the
topology verified 2026-08-04. The earlier project name `creative-serenity` was wrong.

Public URL also reachable at `https://phoenix-people-workforce-production.up.railway.app`.
Cloudflare holds `CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied; the pre-cutover value was
`A 8.232.10.208` (Cloud Run) if a rollback is ever needed.

## How GCP died

Billing account `01BDEA-A20B4C-CC568F` closed 2026-08-01 ~21:00 Cairo over an unpaid balance the
owner has decided not to settle. Every API in project `phoenix-workforce-498619` returns
`BILLING_DISABLED`, and the site served 503 for ~2h15m until the Railway cutover. Expect GCP to
delete the project's resources roughly 30 days after closure. `deploy-cloud-run.yml` /
`deploy-cloud-run-staging.yml` are trigger-disabled but otherwise intact for that reason.

The Cloud Run staging service (`phoenix-hr-staging`, same project) died with it; there is no Railway
replacement. `.github/workflows/deploy-cloud-run-staging.yml` is left in the repo but is dead.

## cron-job.org, the real production scheduler

Verified live 2026-08-02 from Railway HTTP logs — its `/api/cron/*` requests return 200. Daily
notifications, the outbox drain, and iReports sync/reconcile all fire from that account.

The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** (secret mismatch) — a red
herring, not proof anything is down. The Railway `phoenix-cron` service never reached the app and
was disabled.

Caveats: it is free-tier, undocumented, and outside the repo — its schedule lives only in that
account, a single point of failure no runbook mentions — and it caps request timeout at 30s, so a
long route logs a false `Failed (timeout)` while the server still finishes the work. iReports
freshness also has an in-process poller (`PHOENIX_LIVE_CRM_POLL=true`) independent of any cron.
`src/lib/cron-control/*` is a dashboard over the dead GCP Cloud Scheduler and remains inert.

Detail: memory `cron-job-org-is-the-real-production-scheduler`.

## The retired staging Supabase project

Current staging ref `cifwmndunmlxjhyjugxa` (`Phoenix-HR-Staging`, Pro org, eu-central-1) was created
2026-07-11 as a 1:1 clone of production.

The prior free-tier staging project, ref `izhmxvgiktiafqusolot`, is **GONE** — as of 2026-07-27
`list_projects` returns only `cifwmndunmlxjhyjugxa` and `ozucdzovmcqvepbozvqf`, so that old ref
resolves to nothing. Treat any doc, script, or prompt still naming it as stale.
`scripts/staging-safe-rebuild.ts` is the one deliberate exception: its `currentStagingRef` pins the
archived ref on purpose and says so.

## `STAGING_SUPABASE_SERVICE_ROLE_KEY` wiring

Added 2026-07-18. The staging project's service-role key, consumed by **two** workflows.

In `.github/workflows/ci.yml` it is set on the `validate` job's "Run Playwright login smoke test"
step, so the login-smoke test (CI_SMOKE_LOGIN_ID account) writes its expected session-rejection
noise to staging instead of production `audit_logs`; the matching URL/anon key for that step are
hardcoded in `ci.yml` (public/non-secret, RLS-protected).

In `.github/workflows/migration-drift-check.yml` it powers both staging legs
(`check:migrations-applied` and `check:schema-shape`) — the production legs use the separate
`PRODUCTION_SUPABASE_SERVICE_ROLE_KEY`.

**There is no `preview-smoke` job any more**; the smoke test is a step inside `validate` (verified
2026-08-09).

---

# §3 Stable Environment Facts — the accounts

Companion to **[AGENTS.md §3](../AGENTS.md)**, which auto-loads in full on every request and so pays
only for the **hook**. This part holds the **account**: the measurements, dates, PR numbers and the
diagnosis traps that nearly sent each one the wrong way.

**Adding here? Put the hook in AGENTS.md §3 and the account in this file — never the account there.**

## Why production must stay in Europe

The Railway region `europe-west4-drams3a` (Amsterdam) is deliberately colocated with the Frankfurt
Supabase project (`eu-central-1`) and near the Cairo users. Measured: **~204 ms from `sfo` versus
~75 ms from `europe-west4`**. If production is ever re-platformed, it must stay in Europe.

## The Railway source branch that silently stranded five merged PRs

The `production` Railway environment's service now tracks git branch `main` directly, repointed
**2026-08-13** via `railway service source connect --environment production --branch main`.

Before that it was source-configured to track a git branch literally named `staging`, which had gone
stale. Five already-merged, already-CI-green PRs — **#2093, #2095, #2094, #2098, #2097** — sat
unshipped in production for hours while `main` moved on, **with no error or signal anywhere**.
GitHub shows the merge as normal either way, so nothing surfaces the drift.

That is why the rule is to confirm the service source branch rather than assume a merge ships. Note
also that `railway status --environment production --json` returns the **whole project**, so a reader
taking `environments.edges[0]` prints the same environment whatever `-e` says. Select by
`.environments.edges[] | select(.node.name=="production")`, print the name you matched, then read
`.node.serviceInstances.edges[].node.latestDeployment.meta.branch`.

## cron-job.org: the 30 s cap, and the mid-sweep snapshot trap

Both halves were measured **2026-08-28** with a one-shot probe on `/api/cron/crm-contact-lists`. The
API accepted and read back `requestTimeout=300`, and the execution still recorded
`status=5 http=0 ms=30108` — the 30 s cut is a **platform cap** `requestTimeout` cannot raise.

But the server finishes the work anyway. The route's own audit row — written **last** in the handler
— landed at **20:09:43 Cairo** covering **all 82 agents, 9,518 rows, 0 failures**, about **70 s
after** the client was killed. So a long route logs a false `Failed (timeout)` while succeeding.

⚠ **A mid-sweep snapshot reads exactly like a truncated one, and this rule carried the resulting
error for one commit.** A query run at **20:09:02**, while the sweep was still writing, returned
"39 of 68 agents re-stamped" and was reported as proof that the work half-applies. It was just the
run in progress. Never judge completion from row timestamps while the job may still be running —
read the terminal artefact (the audit row, the response body from
`GET /jobs/{id}/history/{identifier}`, the final log line), or re-query only after the route's full
known duration has elapsed.

Slicing a long route into several ticks is still right, for the honest reason: a permanently red job
is one nobody reads, the response body is never seen, and completion otherwise depends on a detached
request surviving a container restart. `/api/cron/crm-contact-lists` is the worked example — one
twelfth of the roster per tick, 12 ticks 5 minutes apart inside one hour, measured at 8–10 s each.

## The outbox drain that ran perfectly and did nothing for 13 days

cron-job.org job **8200914** hits `/api/notifications/process?limit=50` **every 5 minutes**, returns
**HTTP 200** in ~3–5 s, and returned `"outbox":{"attempted":0,…}` on **every single cycle from
2026-08-14 to 2026-08-27**. It was never down, never 401, never unscheduled — so a green cron and a
200 prove nothing here.

The cause was a **head-of-line block** in `loadDueNotificationOutboxRows`
(`src/lib/notifications/email.ts:1998-2007`): `.limit(50)` was applied **in SQL**, then
`attempts < max_attempts` was filtered **in JS afterwards**. Fifty permanently exhausted rows
(`attempts = 5 = max_attempts`, created 2026-08-09 → 08-14, all with `next_attempt_at IS NULL`,
which *matches* the due predicate) filled the entire batch window; the JS filter then emptied it, so
`attempted` was 0 forever and **nothing newer was ever reached.**

The consequence was invisible from the product, because inline sends still work: **every retry was
silently dead.** Any mail whose inline send failed queued behind the blockage and was never retried.

**Cleared 2026-08-27 ~18:15 Cairo** by retiring those 50 rows to `status='skipped'` (reversible,
`last_error` marked); the window then returned **0** rows.

**FIXED 2026-08-27 — the code bug is gone:**

- **#2462** (`9f61f582`) made the loader page past dead rows.
- **#2464** (`2e93c273`) moved `attempts < max_attempts` into the SQL query itself, on **all three**
  drains — telegram and push carried the identical defect, **25 and 16** dead rows against the same
  50-row window — so exhausted rows can no longer consume the window.
- **#2468** (`c943d46f`) added the alarm that would have caught this on the first cycle rather than
  after 13 days: every run asks whether a queue had work due **before the run started** and
  attempted nothing, and on that shape pings the dead-man's switch **fail** with the reason and
  writes a `drain_stranded` ERROR log.
- **#2470** (`4a64464f`) added the third channel, because those two only reach someone already
  watching a dashboard or an inbox: it **pages a human in-app + Telegram** on the existing
  `weekly_system_health_digest` audience (retarget or silence it at
  `/admin/notification-recipients` — no new key, no migration), bucketed per Cairo day **and** per
  exact set of stranded queues, so a strand that persists across ticks alerts once a day while a
  newly stranded queue still gets through.

**Deliberately no email, and do not "fix" that back** — this alert fires precisely when the
notification pipeline is the thing not delivering, so an emailed alert would depend on the channel
it is reporting broken. It is best-effort and never throws: a failed alert must not turn a stranded
drain into a second, self-inflicted incident.

Memory: `outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line`

## The Railway staging environment

Verified **2026-08-13** and the owner confirmed keeping it. Same project, service
`phoenix-people-workforce`, reachable at `https://phoenix-people-workforce-staging.up.railway.app`
(returns 200, `/api/healthz` responds).

Its service source tracks git branch `main` — not the git branch named `staging` — so confusingly,
this Railway *environment* named "staging" was, until the production fix above, actually **fresher
than the Railway environment named "production"**.

`railway variables --environment staging` confirms `NEXT_PUBLIC_SUPABASE_URL` points at the staging
Supabase project (`cifwmndunmlxjhyjugxa`), not production — safe to use as a real verification
target.

## The Supabase ref list, and why neither region nor org is a guard

The four refs in the AGENTS.md §3 table are the complete list `list_projects` returns, verified live
**2026-08-23**. Two belong to this app; the other two do not, and are tabled precisely so an
unfamiliar ref is identifiable instead of alarming.

**Dead refs:** `izhmxvgiktiafqusolot` (the prior free-tier staging) and `oaifhavixhdtwmseshff` (an
older secondary project). Neither is returned by `list_projects` any more. The §3 list named only the
first as dead until 2026-08-23; both were live in older memories, and one of them sat in the
`reference` memory a session consults to answer "which project is which".

Three of the four are `eu-central-1`, and a different organization does not stop anyone passing a
ref — so neither region nor org is a guard. Combined with both named MCP servers seeing all four,
the `project_id` argument remains **the only thing separating staging from production on every
call.**


---

## Relocated from AGENTS.md — 2026-09-01 (batch 2)

Verbatim, unabridged. The cue — and every memory slug — stays in `AGENTS.md`; the account is here.

- **The OUTBOX DRAIN is the one that needs care — it ran perfectly and did nothing for 13 days.** **A green cron and a 200 prove nothing here**, and **`attempted: 0` cannot by itself tell idle from broken — read `drainHealth` in the response body.** The head-of-line block is **FIXED 2026-08-27** on all three drains (outbox, telegram, push), with a dead-man's-switch alarm and an in-app + Telegram page behind it. **That alert is deliberately never email, and do not "fix" that back** — it fires precisely when the notification pipeline is the thing not delivering, so an emailed alert would depend on the channel it reports broken; it is best-effort and never throws. **Never infer a cron's health from database state alone, or from its status code** — read its execution history *and* its response body (on cron-job.org the job-list endpoint returns an empty body; only `GET /jobs/{id}/history/{identifier}` carries it). To check the drain, run its own window query — `status in ('pending','failed')` AND `(next_attempt_at is null or next_attempt_at <= now())` ordered by `created_at` **limit 50** — and count how many of those 50 are already exhausted. `outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line`

- **The production scheduler is the third-party `cron-job.org`, and it is running, not stalled.** Daily notifications and iReports sync/reconcile fire from that account. The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** — a red herring, not proof anything is down. **Never tell the owner notifications/iReports are stalled without checking `cron-job.org` first.** **It cuts every request at 30 s, a PLATFORM cap `requestTimeout` cannot raise — but the server DOES finish the work afterwards**, so a long route logs a false `Failed (timeout)` while succeeding. ⚠ **A MID-SWEEP SNAPSHOT READS EXACTLY LIKE A TRUNCATED ONE.** Never judge completion from row timestamps while the job may still be running — read the terminal artefact (the audit row, the response body of `GET /jobs/{id}/history/{identifier}`, the final log line), or re-query only after the route's full known duration has elapsed. Slicing a long route into several ticks is still right: a permanently red job is one nobody reads. `src/lib/cron-control/*` is a dashboard over the dead GCP scheduler and remains inert.

---

## The protected-file lock, and why no prompt backs it any more (relocated from `CLAUDE.md`, 2026-09-01)

**Superseded 2026-09-30 — a prompt backs the three behavioral locks again,** by owner instruction
("build the protected-file ask hook"). It is a PreToolUse HOOK, not a `permissions.ask` entry:
`.claude/hooks/protected-file-guard.mjs` answers a Write/Edit of `scheme-2026.ts`, `payroll/policy.ts`
or `identity-card.tsx` — or a shell command that writes one — with `permissionDecision: "ask"`, which
the hooks docs say still prompts under `--permission-mode auto` (only `bypassPermissions` skips it).
It never denies and never fires on a read. Under an armed AUTORUN it lets the edit proceed with an
"announce it" instruction, as §6.1 rules. Pinned by `tests/protected-file-guard.test.ts`. What
follows is the history up to that day.

`CLAUDE.md` lists four permanently-locked files. Three of them are held by **behaviour alone**. This
is the history behind that, moved out of `CLAUDE.md` because it auto-loads on every request and this
account is only wanted once a session is already looking.

**The lock is now behavioral ONLY — no prompt backs it.** On 2026-08-14 the owner instructed that
`permissions.ask` be emptied in `.claude/settings.json`. The `deny` list was cleared that day too,
then its one block on the untrusted `mcp__b345e47e-…` connector was restored per AGENTS.md §8 — a
silent hard block, not a prompt.

**Two files, and they hold different lists.** This repo file denies that one connector, while
user-level `~/.claude/settings.json` denies TWO — the same one and, since 2026-08-23, the owner's own
`mcp__45bb6356-…`. Both counts read live 2026-08-29; check the file you actually mean.

**Correction, 2026-09-16:** the repo file now denies BOTH connectors, and six more silent hard
blocks joined them there: `gh pr merge` with `--auto` and any `gh api` call naming
`enablePullRequestAutoMerge` (AGENTS.md §2), and `railway service source connect` (§2.3), each for
Bash and PowerShell. Until then those six lived only in the gitignored `settings.local.json`, so a
cloud session, or a worktree opted out of the local-settings sync, had none of them. The same change
stopped the repo file auto-approving `pnpm install --frozen-lockfile` and `pnpm run
worktree:sync-env`, both banned inside a worktree (§5).

So the three file paths in `CLAUDE.md`'s table no longer have an entry there and **no dialog will
fire on any of them.** (`office-allocation.ts` was never in that list — it has the CI lock instead,
which is untouched and still turns a PR red.)

`permissions.defaultMode` is **`default`** in user-level settings, changed from `auto` on 2026-08-31
at the owner's instruction so that a would-be block becomes a prompt instead. Several hundred allow
rules still wave routine calls through. **So nothing except the agent's own compliance now stands
between a request and an edit to a protected file.**

**Correction, 2026-09-12: that setting does not govern a desktop-app session at all.** The Claude
desktop app launches every engine with `--permission-mode auto` on its own command line (read from
the process list that day), and a command-line mode beats `defaultMode`. So inside the desktop app
the auto-mode classifier decides — a would-be block is blocked or waved through, and never becomes a
prompt. `defaultMode: default` still applies to a `claude` started from a terminal without that flag.
The conclusion above is unchanged, only stronger: a prompt was never what stood between a request and
a protected edit.

**Same day, same audit: §8 had listed `mcp__45bb6356-…` as covered by the Supabase write grant** while
its own bullet four lines below — and both settings files — deny it. The deny is the owner's decision
(2026-08-23) and stands; the stale mention was removed from the grant.

**Never read the absence of a prompt as approval** — that was already the rule while the entries
existed, and it is the entire story now that they are gone. Ask the owner in plain words and wait for
a plain answer.

**Recovering the pre-2026-08-14 file.** It is recoverable from the commit *before* the lists were
emptied: `git checkout 6fd35986^ -- .claude/settings.json` (`6fd35986` is the `chore(claude)` commit,
#2117, that emptied both lists). Plain `git checkout .claude/settings.json` will NOT work once that
commit is checked out — it only restores that commit's already-empty version.

**Do not reintroduce a passphrase.** A shared one was removed 2026-07-31 (it sat in a committed file,
so it authenticated nobody); approval belongs in the conversation, not in version control.

## Section 3 was trimmed to its floor — 2026-09-01

**What was done.** §3 went from **5,520 → 5,369 bytes, −151 B (2.7%)**, and a further **−69 B** came
out of §2 where a §3 fact was stated a second time. `AGENTS.md` total **69,303 → 69,083, −220 B**.
Invariants held: **241 bullets, 12 🔒, 15 🔴, 31 memory slugs — an identical slug set before and
after**, and **all six Supabase project refs still appear**, including both dead ones. Proven by
arming the guard first: removing `a-missing-table-answers-pgrst205-not-42p01` made
`runMemoryIndexReachabilityTests` go RED; all three memory-index suites were green after restoring
it.

### Two duplicates, both resolved toward the fuller copy

- **The `project_id` sentence** (−92). §3's project-ref table ended with *"**The `project_id`
  argument is the only thing separating staging from production on every call.**"* — **verbatim** in
  §8, where it is framed better: *"**The server name guarantees nothing** — the `project_id` argument
  is the only thing separating staging from production on every call."* §8 is the Supabase section
  and already points at *"all four in the §3 table"*, so the table now ends with *"Resolve with
  `list_projects` before acting (§8)"* and the rule itself lives once, in the section about acting on
  a database.
- **The staging application bullet in §2** (−69). It carried the staging URL and the staging Supabase
  ref, then said *"See §3."* — pointing at the §3 bullet that has all of that **plus** the service
  name, the fact that its source tracks git branch `main` rather than the branch named `staging`, and
  the verdict that it is safe as a real verification target. The §2 bullet keeps the corrective claim
  that makes it worth a line at all — **there is a staging application *again*** — and defers the
  detail.

The staging URL still appears once in the file, and `cifwmndunmlxjhyjugxa` still appears once, in the
project-ref table where it is identifiable next to the other three.

### Four provenance dates

Each is recorded in `docs/agents-incident-history.md`, checked before cutting:

| Was | Now | B |
| --- | --- | --- |
| `served by Railway since 2026-08-01, no longer Cloud Run` | `served by Railway, no longer Cloud Run` | −17 |
| `It tracks main directly (repointed 2026-08-13)` | `It tracks main directly` | −23 |
| `Billing closed 2026-08-01` | `Billing is closed` | −8 |
| `The head-of-line block is FIXED 2026-08-27` | `…is FIXED` | −11 |

In every case the durable half is what a session acts on: *no longer Cloud Run*, *it tracks `main`
but has silently drifted before*, *`BILLING_DISABLED`*, *fixed on all three drains*. §2.2 already
requires a hook to be *"durable (never a count, a status or a date)"*.

### What was deliberately left alone

- **The project-ref table** (630 B including its two notes). It is the densest reference in the file
  and the one thing standing between a session and running a migration against production because a
  ref looked familiar. Four rows, two dead refs, and the note that **neither region nor org is a
  guard** — three of the four projects are `eu-central-1`.
- **The `cron-job.org` bullet** (792 B) and the **outbox drain** bullet (755 B), the two longest in
  the section. Both are made of diagnosis traps rather than description: the 30 s platform cap that
  the server survives, the mid-sweep snapshot that reads exactly like a truncated one, `attempted: 0`
  not distinguishing idle from broken, and the deliberate never-email alarm. Every clause changes
  what a session concludes from the same observation.
- **The 13-day outbox silence** and **five stranded green PRs**. Both are measurements, which §2.2
  normally treats as evidence — but these two are the entire reason the rule is believed, and each is
  the number a session weighs a decision against.

### The campaign is now complete

| Section | Before | After | Yield |
| --- | --- | --- | --- |
| 2.1 Session-level traps | 19,789 | 19,060 | −729 (3.7%) |
| 4 + 4.1 Standing owner rules | 14,264 | 13,995 | −269 (1.9%) |
| 2.3 Production and approval hooks | 5,723 | 5,526 | −197 (3.4%) |
| 5 Session/worktree safety | 5,838 | 5,696 | −142 (2.4%) |
| 3 Stable Environment Facts | 5,520 | 5,369 | −151 (2.7%) |

**Every section over 5KB has now been passed over, for 1,687 bytes across five passes.** The finding
repeated in all five and is the one worth keeping: **the largest single cut was always a duplicate,
never wording**, and wording alone never returned more than about 1% of a section. `AGENTS.md` is not
verbose; it is occasionally redundant, and redundancy is findable mechanically — grep a distinctive
clause and count the hits.

**Do not open another editing pass.** What remains is the rules themselves, and the arithmetic has not
changed: PR #2880 added 884 bytes in one commit, more than half of what five passes recovered. The
only lever with a better rate is the displacement rule enforced when a hook is written — cue in
`AGENTS.md`, account in `docs/`.

## The fourth Actions cron, and the scheduler that actually drives it — 2026-09-04

`AGENTS.md` §3 said this repository runs **three** GitHub Actions crons "separate from cron-job.org
and from the dead GCP scheduler". Both halves were wrong, and the second half is the one that sends a
diagnosis to the wrong place.

### There are four, not three

`gh api repos/Gawish-1997/phoenix-people-workforce/actions/workflows` returns four active scheduled
workflows:

| workflow | cron | state |
| --- | --- | --- |
| `deploy-drift-check.yml` | `9,39 * * * *` | active |
| `migration-drift-check.yml` | `0 7 * * *` | active |
| `security-scan.yml` | `17 5 * * *` (`17 20 * * *` since 2026-10-16) | active |
| **`synthetic-journeys.yml`** | `17 2-18/3 * * *` | **active — 1,032 runs, and §3 never listed it** (its `schedule:` leg was REMOVED 2026-10-14; see below) |

A fifth, `security.yml`, reads `disabled_manually` and is correctly absent. The `cron:` lines in
`deploy-cloud-run.yml` and `deploy-cloud-run-staging.yml` are commented out with restore
instructions, so they are correctly absent too. §3's own closing instruction — *"Count them before
adding a fourth"* — was therefore already stale: the fourth existed and was uncounted.

### The two schedulers are chained, not separate

`synthetic-journeys.yml` is not driven by its own `schedule:` trigger. The cron-job.org job
`phoenix-run-synthetic-journeys` (`0 * * * *` until 2026-10-14, then cut to `17 5,8,11,14,17,20 * * *` — 6 runs a day — by the owner for cost; registered in `src/lib/observability/job-schedule.ts`)
calls `/api/cron/run-synthetic-journeys`, which `workflow_dispatch`es the workflow via
`src/lib/observability/dispatch-synthetic-journeys.ts`.

**This design is deliberate and is argued at length in that file.** GitHub's scheduler is
best-effort; measured 2026-08-05, it did not fire this workflow at all, while cron-job.org fires on
time. The dispatch is routed through a Phoenix cron route rather than pointing cron-job.org straight
at GitHub, so the GitHub write token stays in Railway instead of a free-tier third-party account.

Nothing about the mechanism is a defect. The defect was that `AGENTS.md` asserted the opposite
relationship, so a session reading §3 would treat the two schedulers as disjoint.

### What the run log shows

Counted from `actions/workflows/synthetic-journeys.yml/runs`:

| day | `schedule` | `workflow_dispatch` |
| --- | --- | --- |
| 2026-08-23 | 17 | 17 |
| 2026-08-24 → 08-26 | 15–17 | 24 |
| 2026-08-27 → 09-04 | 1–4 | 24 |

The 2026-08-29 cadence change documented inside the workflow — hourly to three-hourly, *"cuts it to
~6/day"* — did exactly what it claimed **to the schedule leg**. The dispatch leg has been a flat
24/day across the entire window, before and after, and was not part of that calculation. The
workflow's real rate is **~27 runs/day, not ~6**.

### The cost attribution was wrong too

§3 called `deploy-drift-check.yml` "the standing Actions cost". Measured wall-clock:

| workflow | avg per run | runs/day | wall-clock/day |
| --- | --- | --- | --- |
| `deploy-drift-check.yml` | 0.55 min | 48 | ~26 min |
| `synthetic-journeys.yml` | 2.1 min | ~27 | **~57 min** |

Roughly double. **No money figure is quoted, deliberately.** The per-run timing endpoint returns
`billable_ms = 0` for these runs, and `users/{user}/settings/billing/actions` now answers HTTP 410
("this endpoint has been moved"), so billed minutes could not be read. Wall-clock is what was
measured, so wall-clock is what is stated.

### What to do with this

Change the synthetic-journeys cadence in `job-schedule.ts` and at cron-job.org. Editing the
workflow's own `cron:` line moves about 3 runs a day and leaves the other 24 untouched — which is
precisely the mis-diagnosis the §3 hook now warns against. And do not probe the cron-job.org REST API
to confirm the job: §2.3 records a 100-request **daily** cap that 429s every endpoint with no
`Retry-After`, so that check costs more than it returns.

## `AGENTS.md` §2 Hard-Learned Rules (the intro bullets above §2.1) — as it stood before the 2026-09-12 condensation

On 2026-09-12 `AGENTS.md` was cut to roughly half its size at the owner's request ("Load less of AGENTS.md"): every hook was reduced to its rule plus the one detail needed to obey it. This is that section's hook text **verbatim** from `origin/main` 3eea44aef, kept so that no measurement, date, count or diagnosis a condensed hook dropped is lost. Search it for the hook's wording. The accounts earlier in this file remain the fuller record.

Evidence — dates, PR numbers, billing figures, measurements — is in
[docs/agents-incident-history.md](agents-incident-history.md). Read it before changing branch
protection, CI cost, the deploy path, or the region.

- **Never use `gh pr merge --auto`.** `main` is branch-protected (`enforce_admins: true`) with **4 required status checks** — `validate`, `checks`, `mobile`, `secret-scan` — that **DO gate every merge**. `allow_auto_merge: false`, so `--auto` is rejected anyway. Required reviews is **0**. Merge only with an explicit plain `gh pr merge` after separate owner approval. The list has changed four times (4 → 5 → 6 → 4); read it live rather than from any doc.
- **Do NOT run `gh pr update-branch` reflexively.** "Require branches up to date" is **OFF** (`strict: false`, owner-approved 2026-08-05) because it was the dominant Actions cost and hit the spending cap. Each run costs ~16 Actions minutes and discards the prior green CI. Run it **only when the change genuinely depends on something newly on `main`**.
- **When you do run it, it acts on the SERVER — your local branch is then stale.** The next `git push` is rejected with *"remote contains work that you do not have locally"*. Always `git fetch` and `git merge --ff-only origin/<branch>` first. It also moves the head SHA, so **CI re-runs and the previous green result no longer applies.**
- **A merge to `main` SHIPS TO PRODUCTION as soon as that commit's CI is green.** Railway deploys on push, at full traffic, no cron wait, no staged rollout, no smoke test — **gated since 2026-09-27 on the commit's Actions check suites** (Wait for CI), which is why `main`'s own CI run must never be removed to save minutes. **Never merge anything to `main` you are not willing to have serving employees within minutes.** To confirm what is live, request `/api/healthz` and read `revision` — 🔴 and note the gate fails by *not* shipping, silently, so a green PR is no longer evidence production moved. Account: `docs/deployment.md`, "The deploy gate".
- **There is a staging application again**, wired to the staging Supabase project — URL and caveats in §3.
- **A local typecheck must not trust a warm TypeScript cache.** CI always starts cold. If you must run one by hand, use `tsc --incremental false`.
- **Never foreground-watch a long pipeline.** Background it and check at batched checkpoints.
- **Role sweeps use dev-auth request headers** (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + `x-phoenix-role`/`x-phoenix-hr-id`), not the cookie flow — cookie switching logs the real user out.
- **Merged-branch checks must be squash-aware.** Use `gh pr list --head <branch> --state merged`; `git branch --merged` is always wrong here.
- **A regression test only counts if you break the fix and confirm the new test's own headline assertion fires.** "The suite went red" is not proof.
- **`list_migrations` reports the ledger, not reality.** To prove an object exists, query `pg_class`/`pg_proc`.
- **Auto-git workflows are permanently banned.** Tried and reverted **twice**. Always ask first.

## `AGENTS.md` §8 Supabase and data safety — as it stood before the 2026-09-12 condensation

On 2026-09-12 `AGENTS.md` was cut to roughly half its size at the owner's request ("Load less of AGENTS.md"): every hook was reduced to its rule plus the one detail needed to obey it. This is that section's hook text **verbatim** from `origin/main` 3eea44aef, kept so that no measurement, date, count or diagnosis a condensed hook dropped is lost. Search it for the hook's wording. The accounts earlier in this file remain the fuller record.

- **Supabase writes are pre-authorized end to end — NO approval prompt** (owner's `autoMode` grant, applied by hand 2026-08-02, which deliberately removes the §6 gate for Supabase). It covers the `supabase-staging` and `supabase-production` MCP servers and the `supabase` CLI (incl. `db push`), on staging AND production — every read tool and every write tool: `execute_sql` mutations, `apply_migration`, bulk and destructive SQL. **You do NOT wait for a separate approval.** The one standing condition: **announce any destructive or bulk PRODUCTION change in plain words before you run it, and give the owner a chance to stop it** — the removed prompt is a UI gate, not licence to skip telling him. (This grant does NOT cover creating/deleting a project or reading secrets.)
- All schema changes must be migration-based, repeatable, reviewable, and rollback-aware. Never patch production manually.
- Before any database action, print and verify the exact project ref, resolving it with `list_projects` rather than trusting a ref pasted in a prompt or copied from an older doc.
- Both named servers can see **every project the account is entitled to — all four in the §3 table.** **The server name guarantees nothing — the `project_id` argument is the only thing separating staging from production on every call.**
- Any UUID-named Supabase tool (a claude.ai account connector) has an identity you cannot verify from its name alone, so it stays deny-listed by default. `mcp__b345e47e-3198-4b48-97cc-07b47bbb3087` remains denied. **Write the BARE server name in a deny rule** — a `__*` suffix is not a supported wildcard, so a rule spelled that way can match nothing while reading as a block.
- **OWNER DECISION 2026-08-23: `mcp__45bb6356-…` stays DENIED.** It is the owner's own connector and was briefly allowed, but he was asked directly and answered plainly, so this is settled. Do not re-allow it, do not propose re-allowing it, and do not read a blocked call as a bug to chase — a `deny` is a silent hard block, not a prompt. Nothing is lost: the two named servers cover routine work, and this connector's grant was always the broader one (read+write on Secrets, Environment and Projects).
- Before destructive or bulk live-data work, inventory the target, create or verify a backup, show the exact mutation, and define post-change counts or checks.
- Verify RLS, grants, RPC authorization, service-role boundaries, and browser-role exposure whenever permissions or data access change. Service-role credentials stay server-only.
- Visibility in this app is **application-scoped, not RLS-scoped** — most code paths use the service-role client. Changing auth or sessions will not move what a user can see, but a `?? getSupabaseAdmin()` fallback is a silent fail-open.

## `AGENTS.md` §7 Validation — as it stood before the 2026-09-12 condensation

On 2026-09-12 `AGENTS.md` was cut to roughly half its size at the owner's request ("Load less of AGENTS.md"): every hook was reduced to its rule plus the one detail needed to obey it. This is that section's hook text **verbatim** from `origin/main` 3eea44aef, kept so that no measurement, date, count or diagnosis a condensed hook dropped is lost. Search it for the hook's wording. The accounts earlier in this file remain the fuller record.

**CI is the gate. Do not run a local full validation.**

`check:harden` was retired on 2026-08-18 at the owner's instruction, along with the
`ask-before-validation` hook. Do not reintroduce any of them, and do not invent a replacement — no
"quick subset" of lint + typecheck before pushing, no `pnpm run ci` as a pre-push ritual. **Push the
branch and let the PR's checks answer.**

This is safe because the local gate never gated anything. `.github/workflows/ci.yml` re-lists every
step itself, and the four **required** checks — `validate`, `checks`, `mobile`, `secret-scan` —
run on the PR head commit and block the merge if any is red.

`pnpm run ci` still exists for the rare case where you genuinely need the answer before pushing. It
is opt-in: run it **only when the owner names it**.

Two things are NOT covered by a PR's CI and still need a check immediately before the action:
**migrations** and **production deploys**.

Verifying a UI change in the browser is not validation at all — reload and look.

| Change type | Minimum validation | Who runs it |
| --- | --- | --- |
| Docs or repo instructions only | Review diff, formatting, links, secret exposure | You, by reading |
| Narrow TypeScript/JavaScript change | Lint, typecheck, targeted tests | CI, on the PR |
| Shared runtime, app/API route, server component, env, or deployment behavior | Lint, typecheck, tests, build | CI, on the PR |
| UI workflow | Relevant code checks plus browser verification at desktop and mobile sizes | CI for the code; **you** for the browser |
| Migration, view, function, RPC, grant, or policy | Migration checks, SQL review, target confirmation, schema/security review, staging verification after approval | **You, before the migration** — CI never sees this |
| Auth, RLS, payroll, HR lifecycle, sales, permissions, executive reporting | Full checks, role-based tests, failure-state checks, explicit risk review | CI for the code; **you** for the role sweep and the risk review |

Prefer repository scripts over improvised commands. Never present a known-broken change as ready.
Report failures your change caused separately from pre-existing ones. When a data source is
unavailable, verify the UI says so rather than showing a misleading zero.

**Role-based testing.** For permission-sensitive work, test the affected roles including denial
paths. Sales: Super Admin, CEO, National Sales Manager, Regional Manager, District Manager.
Coaching: Super Admin, CEO, SFE Manager, Training Manager, and Medical Rep when employee review is
affected. HR: Super Admin, CEO, HR Advisory, HR Operations, and Employee when portal behavior is
affected. Do not claim role safety from code inspection alone when real role testing is possible.

**Deploy verification.** Production is Railway auto-deploy on push to `main` — there is no Cloud Run
workflow to watch. Confirm a deploy through the GitHub deployments API
(`gh api repos/Gawish-1997/phoenix-people-workforce/deployments`) or `railway status`, and confirm
what actually serves traffic by requesting `/api/healthz` and reading `revision`. Use the live
staging app (§3) to smoke-test before a risky production deploy when there is time. After a
runtime-impacting production deploy, verify the public domain, smoke-test the changed workflow, and
inspect production logs (`railway logs`). When a page fails, capture the visible error, browser
console, network/API response, deployment logs, and database/RLS evidence before proposing a fix.

## `AGENTS.md` — the full wording condensed out on 2026-10-08

AGENTS.md loads on every request and again after every compaction, so on 2026-10-08 these lines were shortened to their rule. Nothing was dropped: each block below is the wording as it stood, word for word, and the rule it carries is still in AGENTS.md. Search here for the evidence, the owner's words and the measurements behind a rule.

### §2 — Never use `gh pr merge --auto`

- **Never use `gh pr merge --auto`.** `main` is branch-protected with **2 required checks** — `validate`, `checks`; `allow_auto_merge: false`. Merge only with a plain `gh pr merge` after separate owner approval. 🔴 **THAT LIST HAS ROTTED FIVE TIMES, AND `lint`, `typecheck` and `test` ARE NOT CHECK NAMES.** Never quote this line, or any doc, as the source: read `branches/main/protection/required_status_checks` live and count passes against what it returns, because a gate counting to a number a doc gave you waits forever for checks that are gone. `node scripts/check-required-checks.mjs` compares this line against the live gate and is the ONE thing that catches the next rotation. Account: `docs/agents-incident-history.md`.

### §6 — A classifier denial on a merge

🔴 **A CLASSIFIER DENIAL ON A MERGE IS USUALLY STALE AUTHORIZATION, NOT A STANDING BLOCK — AND THE
FIX IS A FRESH WORD FROM HIM, NEVER A SETTINGS CHANGE.** Auto mode judges from what it can
currently SEE, so his approval going out of view across a context compaction reads exactly like a
permission he never gave: same `[Production Deploy]` refusal, same wording. Measured 2026-09-29 —
six merges went through on his approval, then #4776 was refused hours later on the *same* standing
approval; he retyped `merge 4776` and it passed on the next attempt, head sha unchanged. **Never
route around it, never ask a peer session to merge for you** (that launders a permission decision
made in your window), and never propose editing `permissions` to clear it. Put it back to him and
quote the merge. A denial is about what the classifier can see, not about what is permitted.
