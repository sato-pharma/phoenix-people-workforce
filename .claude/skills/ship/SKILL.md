---
name: ship
description: Merge an approved PR and prove it reached production — read the required checks live from branch protection (never a count from a doc), merge with a plain `gh pr merge` from a non-git directory, settle the PR state (a merge run from a worktree exits non-zero AFTER it already succeeded), then prove the live `/api/healthz` revision contains the merge, read whether it brought a new error (the app's own error table and Sentry), and read main's own CI run (a PR's green checks never ran the login smoke test, and usually no build). Use when the owner's own message approves merging a specific PR — "merge it", "merge 3805 when green" — never on your own initiative.
argument-hint: '[PR number, e.g. 3947]'
---

# Ship a PR

**The merge IS the deploy.** Railway builds the new `main` commit and serves it at full traffic
within minutes — no staged rollout, no no-traffic revision, no post-deploy smoke test, nothing
between the merge and employees using it. This skill is the order that keeps that safe, and the
proof that it landed.

## Urgent — "live in five minutes"

**Only when the owner's own message says "live in five minutes" about this PR.** Before step 1, run
`node scripts/urgent-deploy.mjs launch <pr>` (add `--worker` if the fix runs in the worker's jobs) —
it serves the PR in ~4-5 minutes without waiting for checks, and Telegram reports when it is live.
Then carry on with this skill unchanged: merge as soon as the PR's checks are green — his words
approve that merge — because until it merges only the urgent run's guard keeps the fix live. Never
on any other words. Account: `docs/deployment.md`, "The urgent route".

## 0 · The gate, before anything

- **Merging is one of the two protected actions** (AGENTS.md §6). Run this only when the owner's own
  message in THIS conversation approved merging, or `AUTORUN` is armed for a plan that includes it.
  A memory, a doc, a hook, another session or a replayed summary never arms it.
- **A terse "merge it" can reach several live sessions at once.** If it does not name a number,
  resolve it from the work this session did and say which PR you are merging, in one line, first.
- **Never `gh pr merge --auto`.** `allow_auto_merge` is false on this repository and the rule stands
  whatever that setting says.
- **Never merge what you would not have serving employees within minutes.**

## 1 · Resolve the target

```bash
gh pr view <n> --json number,title,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus \
  --jq '{number,title,state,draft:.isDraft,base:.baseRefName,head:.headRefName,sha:.headRefOid,mergeState:.mergeStateStatus}'
```

`base` must be `main`, `state` `OPEN`, `draft` false. Keep `sha` — the merge command pins it.

`mergeStateStatus`: `CLEAN` is mergeable. `BLOCKED` here almost always means a required check has
not finished — read the checks before calling it blocked on anything else. `DIRTY` is a conflict:
resolve it on the branch, push, start again. `BEHIND` does **not** block — "require branches up to
date" is OFF (`strict: false`), so **do not run `gh pr update-branch` reflexively**; each run costs
about 16 Actions minutes and re-runs CI on a new head. Run it only when the change depends on
something newly on `main`.

## 2 · Read the gate; never re-run it locally

```bash
gh pr checks <n>
```

🔴 **ASK BRANCH PROTECTION WHAT THE GATE IS — never a number from this file or any other.** The
list has changed five times (4 → 5 → 6 → 4 → 2) and every change left the docs stating the old one:

```bash
gh api repos/Omar-3-xx/phoenix-people-workforce/branches/main/protection/required_status_checks \
  --jq '.contexts'
```

As of **2026-09-29** that returns **two**: **`validate`, `checks`** (`enforce_admins: true`).
`validate` holds the build and the login smoke test, so on a PR it is short and holds no tests. **`checks`
stands for the `static` job** (lint, `next typegen`, typecheck, the audit) **and the two `unit` jobs** (the
suite): it does no work of its own and is green only when both succeeded and every test ran exactly once.
They left `validate` on 2026-10-19 so the slowest job on `main` is the build alone. #4527 had merged
the three former jobs to stop paying per-job minute rounding four times, so **`lint`, `typecheck` and
`test` still do not exist as check names** — and the suite's job is deliberately `unit` and not `test`,
because a job named like a retired gate reads as gating when it does not (#3950). `static` and `unit` are
gating through `checks` although protection does not name them. Anything else in `gh pr checks` that
protection does not name — `mobile` or `full-e2e` reading `skipping` — is not a gate and not a failure.

🔴 **`mobile` is in that category NOW. `secret-scan` is not in the list at all — do not look for
it.** `mobile` was required until 2026-09-29 and is not any more; it still reports, skipping when
nothing under `mobile/` changed, so a red Expo typecheck is yours to READ and judge before merging
and will not stop the merge on your behalf. `secret-scan` went further in the same change:
`security-scan.yml` lost its `pull_request` trigger, so it cannot appear on a PR at all and its
absence is **not a gap in coverage** — gitleaks moved onto the machine, into `bash-guard.mjs` clause
**C12**, which refuses the push before a key ever reaches GitHub, and the workflow still runs daily
at 20:17 UTC. Never wait for it and never dispatch one to complete the set. Measured on #5005
(2026-10-01): one workflow run on the head — `ci.yml` — and four check runs, `validate`, `checks`,
`mobile` skipped, `full-e2e` skipped.

Why this is written as a live read and not a list: on 2026-09-17 `test` left `validate` for its own
job and nobody added the name, so for a day a red unit suite showed four green required checks and
merged (#3950, fixed 09-18). On 2026-09-27 the names changed again and this skill still said six —
a session following it counted to six, waited for three checks that no longer exist, and the only
thing that saved the merge was reading the API by hand. On 2026-09-29 `mobile` and `secret-scan`
were demoted on purpose, minutes before #4800 took them off the pull request — **a required check
whose job stops reporting blocks every PR for ever**, so the demotion and the un-wiring are always
one change. The docs lagged by under an hour that time, and `node scripts/check-required-checks.mjs`
is the only thing that compares them to the gate — it runs when someone runs it.

- Every context protection names `pass` → merge.
- Any `pending` → it is not green. Wait in the background and report when it lands; never merge on
  a partial set.
- Red → fix the cause and push. Do not re-run a job hoping, and report a failure your change caused
  separately from one that was already there.
- **Do not run a local full validation before the merge** — those PR checks are the gate and they
  are the same steps (AGENTS.md §7).

### 2b · Read the open Dependabot alerts — the PR's green is about the code, not about the day

```bash
node scripts/check-dependabot-alerts.mjs
```

🔴 **A GREEN PR PROVES THE DEPENDENCY AUDIT PASSED WHEN IT RAN, AND NOTHING ABOUT WHEN YOU MERGE.**
`static`, behind `checks`, runs `pnpm audit --audit-level=high --prod`, which reads an advisory feed that
moves on its own. Measured 2026-09-30: the same dependency passed that step at **16:11** and failed it at
**16:29** with nothing in the repository having changed. `main` runs the step AGAIN after the merge —
and a red suite there makes Railway mark the production deploy `SKIPPED` for good (§2.3), which a
re-run does not resurrect. An open HIGH alert is that failure with the clock already running.

- Nothing open → merge.
- **An open HIGH or CRITICAL *that the audit can reach* → bump it first, in its own PR, and merge
  that one before this one.** The output names the version to bump to; a transitive one needs
  `pnpm update --depth Infinity <pkg>`, because `pnpm up` touches only direct dependencies and
  answers "Already up to date" for everything else.
- 🔴 **`open, but CANNOT fail the gate — <reason>` is NOT something to bump, and NOT something to
  wait for.** `pnpm audit --prod` runs at the root, so an alert in `development` scope or in a
  manifest that audit never reads cannot turn `checks` red — the check prints it with its reason
  and exits 0. Measured 2026-10-04: three such alerts, none with a patched version, were being
  reported as `WILL FAIL CI` while the gate command itself passed, so the instruction above could
  not be followed by anyone. The decision and the fail-closed rule behind it:
  [docs/security/open-dependency-alerts.md](../../../docs/security/open-dependency-alerts.md).
- **`skipped — …` is NOT a pass.** It means nothing was read — no `gh`, not authenticated, no
  network, or a token without `security_events`. Report it as unread, never as clear.
- **`SWITCHED OFF` (exit 1) is NOT an alert to bump.** Dependabot alerts are off for the repository, so
  nothing could be listed. It does not stop this merge: the audit behind `checks` is still the gate. Say in the
  report that the alerts were not read, and that turning them on is the owner's click in the repository's
  Security settings.
- **`dependency list for this repo is empty` (exit 1) is NOT an alert to bump either.** Alerts are on, but
  GitHub has not scanned the repository yet, so the zero means nothing. Report the alerts as not read, the same
  as `SWITCHED OFF`.
- The alert appears here hours before the audit feed learns it, which is the whole window this buys.
  It is a read: it never merges anything, and **auto-merging these bumps was offered on 2026-09-30
  and declined** — every merge stays the owner's own word.

## 3 · Docs-only or not, the green checks skipped the same things

```bash
gh pr diff <n> --name-only | node scripts/ci-build-risk.mjs
```

**A docs-only PR gets no fast path.** Its `static` and `unit` jobs run in full, the whole suite
included, so a red one is real: many tests read `docs/` and `.claude/`. `ci.yml` used to skip them for
a diff of docs, and that let a PR of seven markdown files go green and then fail on `main`, withholding
three production deploys. It was removed on 2026-10-06, and its account is in `ci.yml`'s header.

What a green PR has not run is the same for docs and code, and it first runs after the merge (phase 8):

- **The login smoke test, the canvas check and the standalone assembly** are `main`-only, for every PR.
- **The build** runs on a PR only when a changed path is a route or a build config file. The command
  above prints that answer, `build=true` or `build=false`, with its reason. It lists a renamed file's
  new path only, while CI's own step reads both, so a rename can build when this says it will not.

Say in the report what did not run, instead of implying it passed.

## 4 · Migrations are applied BY HAND, BEFORE the merge

The Railway deploy applies none. If the PR touches `supabase/migrations/`, apply it first — §8
pre-authorizes the write, but announce a destructive or bulk production change in plain words and
take the pre-image before you run it. Production has **no point-in-time recovery**: 7 daily backups
are the whole recovery story. A merged PR whose migration has not been applied ships code that
queries a column that is not there.

## 5 · Merge — from a directory that is not a worktree

```bash
gh pr merge <n> --squash --repo Omar-3-xx/phoenix-people-workforce --match-head-commit <sha from phase 1>
```

Run it from the session scratchpad, or any folder outside every git worktree.

- `--match-head-commit` refuses the merge if the head moved after you read the checks. It is the one
  guard against merging a commit nothing verified.
- **No `--delete-branch`.** `delete_branch_on_merge` is on, so GitHub removes the remote branch
  anyway, and that flag is what drags the local checkout into the operation.
- **Run it inside a worktree and it exits non-zero AFTER the remote merge already succeeded:**
  `failed to run git: fatal: 'main' is already used by worktree at …`. `gh` merges on the remote
  first, then tries to switch this checkout to `main` — only that cosmetic last step fails. Treat a
  non-zero exit as **UNKNOWN, never as failed**, and settle it with the PR state (phase 6).
  Retrying answers "not mergeable" on an already-merged PR, and the tempting fixes — checking `main`
  out here, re-merging — are real damage in response to a no-op.

## 6 · Settle: did it merge?

```bash
gh pr view <n> --json state,mergedAt,mergeCommit --jq '{state,mergedAt,sha:.mergeCommit.oid}'
```

`state: MERGED` is the answer. There is no `merged` field — asking for one errors out. Keep the
merge sha: every check after this compares against it, not against the head sha.

## 7 · Prove it shipped

```bash
node .claude/skills/ship/verify-shipped.mjs <n>
```

One pass over all four sources, printed in Cairo time with a verdict: **SHIPPED · QUEUED · NOT LIVE
· NOT MERGED · CANNOT TELL**, and `RED MAIN` reported separately. It reads the PR state and merge
sha, the newest production deployment rows with their real states, the live `revision` from the
production domain, and `main`'s own CI run for that sha (asked by sha, not scanned from
`gh run list`, which is eventually consistent and has dropped a run that existed).

Its exit code carries the answer, so a backgrounded run's notification is readable on its own:
`0` shipped · `2` queued · `3` not live · `4` not merged · `5` cannot tell · `6` shipped but main is
red. `--json` for the whole reading, `--simulate-live <sha>` to force the live revision, and
`--selftest` for the verdict and ancestry tables — run that after editing the script, and expect
**`0 failed`**. 🔴 **Do not check the case COUNT against this page.** It said `17 cases` until
2026-09-28, by which time the script printed `32`, so a session that edited it, ran the selftest and
compared the two had to guess which to believe — with the doc being the thing that sounds
authoritative. The count is meant to rise, and writing a rising number into prose guarantees the
prose is wrong. `tests/verify-shipped-selftest.test.ts` is the authority: it runs the selftest in the
required `checks` job, asserts `0 failed`, ratchets the count against its own `MIN_CASES` so cases can
rise but never fall, and pins three cases by name so a hard one cannot be swapped for an easy one at
the same count. **If you add cases, raise `MIN_CASES` there and leave this page alone.**

**Right after a merge, let it wait instead of re-running it by hand:**

```bash
node .claude/skills/ship/verify-shipped.mjs <n> --wait [minutes]
```

Run it with `run_in_background: true` and act on the notification — never in the foreground, never in
a poll loop. It re-reads every 90 seconds (30 minutes unless you give a number) and stops at the
first answer waiting cannot change: `0` shipped, `4` not merged or `6` shipped but main is red. It
keeps going through `2` queued, `3` not live and `5` cannot tell, which is what the first minutes of
a deploy normally look like. Progress goes to stderr and the final reading to stdout. 🔴 **Giving up
at the limit is NOT a pass:** it prints the last reading and "NOT a pass" and exits with that
reading's code, so a deploy that never landed still reads as queued or not live. Three crashed
readings in a row also stop it, naming the verifier itself as the failure.

**A `CANNOT TELL` names its own reason — read the note, do not assume a missing commit.** Ancestry
needs a git checkout, and the script asks git in its own folder, falling back to yours. A copy
lifted out with `git show` and run from a scratchpad has no checkout under it, and that used to
surface as "one of the two commits is not in this clone", which blames the clone and sent a session
hunting a fetch race that was never there (measured 2026-09-17, on this skill's own PR). It now says
which of the four it is: no live revision, no checkout, a fetch that failed, or a commit genuinely
absent after a fetch and a re-ask. When the clone is simply behind — normal here, production can be
a commit ahead of your last fetch — it fetches and asks again before giving up.

What it protects you from, and what to do if you read the sources by hand instead:

- **Read deployment STATES, never their timestamps.** Railway stamps the GitHub deployment when a
  build goes live, not when it starts, so the earlier commit can carry the later `created_at` and
  serve while the newer one is still `in_progress`. One `in_progress` beside one `success` is a
  queue, not a revert.
  `gh api repos/Omar-3-xx/phoenix-people-workforce/deployments/<id>/statuses --jq '.[0].state'`
  Only the newest row reads `success`; every earlier one flips to **`inactive`**, which means
  superseded, not failed — your own merge reading `inactive` an hour later is the normal, healthy
  state, and ancestry is what answers whether it is still in the running code.
- **Ancestry, not equality.** `git merge-base --is-ancestor <merge sha> <live revision>`. Sessions
  here merge every few minutes, so a live revision NEWER than your merge is success — an equality
  test reads it as a miss.
- **Read the production domain, not staging.** Staging tracks `main` too, so the same sha shows up
  there; `https://phoenix-hr.satopharma.com/api/healthz` is the one that answers for production.
- **`status: ok` proves only that a container is up.** `revision` is the running commit sha, and a
  deploy can silently skip.
- **Never re-merge, never `railway redeploy`, and never `railway service source connect`** to make a
  deploy "take". The git source is service-level, so `source connect --environment staging` has
  repointed PRODUCTION and rolled back everything merged since.

## 7b · Did it bring a new error? The app's error table and Sentry

Once phase 7 says SHIPPED, run this with `run_in_background: true` and act on the notification:

```bash
node scripts/post-deploy-errors.mjs <n> --wait
```

It reads the releases that carry the merge (the merge commit, plus every later commit production served
since) and calls an error **new** only when no other release produced it in the week before. An error that
was already happening before the merge never reads as this merge's doing. It reads two sources:

- **The app's own error table** (`app_error_events` on production, read-only). It records every server and
  browser error with the commit it came from, so it always answers. The browser's own network-failure wording
  and a locked module's refusal are left out by the repo's own rules (`browser-noise.ts`, `expected-refusal.ts`).
- **Sentry**, through its Discover events read, when `SENTRY_READ_TOKEN` is set (a Windows user variable on
  the laptop since 2026-10-19). If it is not set, or Sentry refuses it, the report says "Sentry not read", and
  that is never a pass about Sentry. 🔴 `SENTRY_AUTH_TOKEN` is not a read token: in `.env.local` it was the
  retired account's on 2026-10-19, and on Railway it is the build plugin's. The read token is refused on
  Sentry's issue list and answered on Discover, which is why the script asks Discover.

`--wait` re-reads every 90 seconds until the merge has served for the whole window (15 minutes; change it with
`--window <minutes>`) or a new error shows, whichever comes first. 30 minutes past the window it gives up and
says the last reading is NOT a pass.

The window is timed from Railway's first production `success` for a release that carries the merge. When there
is none (a row that reads `failure` while its own commit serves is CARRIED, as #6432's was on 24 Oct 2026), it is
timed from the first reading of this run that saw production serving the merge, so a single reading says too
early and only `--wait` can close the window. The health probe gets three tries per reading, because one stalled
DNS lookup on the laptop used to make a whole reading CANNOT TELL.

Exit codes: `0` clean · `1` new errors · `2` too early, NOT a pass · `3` not live · `4` not merged · `5` cannot
tell.

- **`1`:** name each new error in the report: what it says, how many times, the page, and the release it came
  from. When a later merge also served inside the window, its new errors are reported as that release's, not
  this PR's. Fix what this merge caused. Never roll back on the verdict alone; read the error first (see "If it
  went wrong" below).
- **`5`:** say which source could not be read, and never report it as clean.

## 8 · Read main's own CI

```bash
REPO=Omar-3-xx/phoenix-people-workforce
gh api "repos/$REPO/actions/runs?head_sha=<merge sha>&per_page=30" --jq '
  .workflow_runs[]
  | select(.path == ".github/workflows/ci.yml")
  | "\(.name) | \(.event) | \(.status)/\(.conclusion // "-") | \(.html_url)"'
```

**Ask by sha — do not scan `gh run list`.** That list is eventually consistent: it dropped a run that
existed, in the minute another commit merged, which reads as "main has no verdict" on a commit that
had already passed. The sha endpoint answered correctly for the same commit at the same moment.

Runs on `main` are grouped by commit and never cancelled, so every merge has its own verdict — and
**a red `main` still builds, ships and serves perfectly**, so this is the only place that failure
appears. It is the first time the login smoke test ran, and for a PR that touched no route or build
config the first time the build ran. The verifier reads this too; do it by hand only when it could not.

## 9 · Report, in Cairo time

One short block: what merged (number and title), the merge sha, the live revision and whether it
contains the merge, the production deployment's state, main's CI verdict, the post-deploy error verdict
(each new error named, or clean after how many minutes, and whether Sentry was read), the migration you
applied, and anything you skipped. If a build or a run is still in flight, **background the wait and report
the real end** — never hand back "check it in a minute".

The one thing left that needs the owner is retiring the worktree and deleting the branch, which
takes his approval:

```bash
node scripts/new-session.mjs --remove <task>
```

## If it went wrong

- **Roll back by reverting the commit on `main`** — the revert is itself a deploy; confirm `revision`
  moved to it. The CLI cannot redeploy an older deployment (`railway redeploy` only redeploys the
  latest); the Railway dashboard can (project `Phoenix-HR-Workforce` → service
  `phoenix-people-workforce` → Deployments → Redeploy).
- **A revert does not undo a migration.** `docs/migrations.md`, and
  `docs/disaster-recovery-runbook.md` for the full procedure.
