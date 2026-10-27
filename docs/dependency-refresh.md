# The weekly dependency refresh

**What it is.** Every Sunday at 10:00 Cairo a Windows task on the laptop re-resolves every package in
`pnpm-lock.yaml`, transitive ones included, to the newest version its declared range allows, and
opens one pull request listing every package that moved. Its required checks are the gate; merging is
the owner's own word, as for every PR.

**Why** (owner, 2026-10-23: *"schedule the recurring pnpm update the fast-uri note says is due"*).
Most of the Dependabot alerts here share one shape: the range in the graph already allowed the patched
version, but the lockfile had resolved the version before it, and nothing ever re-resolved it. fast-uri
hit it five times between August and 30 September 2026, each time answered by hand-raising a floor in
`pnpm-workspace.yaml`. The note on that floor said a fifth occurrence called for a scheduled
`pnpm update` instead. hono and ip-address hit it again on 2026-10-23 (PR 6270).

## How one run goes

1. `~/.claude/scripts/deps-refresh-run.mjs` (a copy of `scripts/deps-refresh/run-refresh.mjs`) fetches
   `origin/main`, makes a throwaway detached worktree there, and runs that tree's
   `scripts/deps-refresh/refresh.mjs`. So the logic that runs is always what merged.
2. `refresh.mjs` stops at once if a refresh PR (branch `codex/weekly-deps-refresh-*`) is still open.
3. It pushes a branch identical to `main`. That starts no CI, because `ci.yml` runs on a push to `main`
   only. It then dispatches `lockfile.yml` on that branch with `mode=refresh`.
4. On GitHub, `lockfile.yml` runs `pnpm update --depth Infinity --no-save --config.minimum-release-age=10080 --config.minimum-release-age-strict=false --config.trust-lockfile=true`:
   - `--depth Infinity` reaches the transitive packages, which a plain `pnpm update` never touches.
   - `--no-save` leaves every range in `package.json` as written, so the exact pins (`next`, `react`)
     never move.
   - `--config.minimum-release-age=10080` is a **seven-day** window (7 x 1440 minutes), the same as
     `dependabot.yml`'s `cooldown`. The run adopts nothing younger than Dependabot will accept; see
     "Why a Dependabot PR is replaced, never merged" below. pnpm's own default is one day.
   - `--config.minimum-release-age-strict=false`, because setting the age explicitly turns strict mode
     on and strict mode refuses `--no-save` (`ERR_PNPM_STRICT_MIN_RELEASE_AGE_REQUIRES_SAVE`).
   - `--config.trust-lockfile=true`, because pnpm 11 otherwise re-applies the window to the lockfile it
     *loads*, which holds entries three to six days old, and stops before resolving anything
     (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`). It skips only that re-check of the loaded file; the
     resolver still applies the seven days to everything it picks.
   - The release-age quarantine still applies.
5. It downloads the regenerated files and stops in one of three ways:
   - **Nothing moved:** it logs `NOCHANGE` and deletes the branch.
   - **`pnpm-workspace.yaml` changed:** pnpm wanted a `minimumReleaseAgeExclude` entry, which the
     floors' notes refuse. It logs `REFUSED`, deletes the branch and opens nothing.
   - **Otherwise:** it commits the lockfile and opens the PR with a table of every package that moved.
6. The launcher writes every line to `~/.claude/scripts/deps-refresh-task.log` in Cairo time, and
   removes the worktree.

**Why the PR is opened from the laptop and not from a workflow cron.** A pull request a workflow opens
with its `GITHUB_TOKEN` starts no CI, so its required checks would never report and it could never
merge. The heavy part, pnpm resolving the graph, still runs on GitHub; the laptop only pushes, waits and
opens the PR.

`lockfile.yml`'s default mode is still `regenerate`, which is what `remote-check.mjs lockfile`
dispatches; that path moves nothing but the manifests a branch changed, and it has **no** release-age
window: a window there would roll back every young bump a person made on purpose.

## Why a Dependabot PR is replaced, never merged

**What happened** (owner, 2026-10-27). Dependabot PRs 6486, 6487 and 6488 were replaced by PR 6493 on
26 Oct, and 6580, 6581 and 6582 by PR 6595 on 27 Oct. Each time Dependabot's regenerated
`pnpm-lock.yaml` moved about forty packages **backward** against `main`: `puppeteer-core` 25.16.0 to
25.14.0, `imapflow` 2.9.1 to 2.5.8, `nodemailer`, `openai`, `supabase`, `lucide-react`, seventeen
`@sentry/*`. Only the `puppeteer-core` pin turned a check red (`infra/runtime-extras` must equal the
lockfile); the rest would have merged without a sound.

**The cause.** Dependabot hands its `cooldown` to pnpm as `--config.minimum-release-age`, in minutes,
and pnpm then re-resolves **every** lockfile entry younger than the window to the newest version that
is old enough, transitive ones included. Dependabot's documentation describes the cooldown only for the
version it proposes; that it reaches the rest of the lockfile is what dependabot-core's own pull
requests 16376 and 16521 describe, and what the diff shows. PR 6580's lockfile (head `a29f42b32`, base
`f53fa171c`) had 45 moves: 38 downgrades, 2 upgrades, 5 others. Every version it chose was at least
seven days old; `main`'s were three to five and a half days old, because the weekly refresh runs under
pnpm's default one-day window. Re-run on GitHub with the seven-day flag, pnpm picked the same versions
as Dependabot.

**The fix is two parts, because either alone leaves a hole.**

1. **Remove the cause.** The refresh now uses the same seven-day window as the cooldown, so it stops
   adopting what Dependabot will roll back. `tests/lockfile-downgrade-gate.test.ts` holds the number to
   `dependabot.yml`'s `cooldown default-days`, and holds the two extra flags and the window-free
   `regenerate` step.
2. **Catch the rest.** The same test compares `pnpm-lock.yaml` with the pull request's base and fails
   any pull request whose lockfile holds an older version, **whoever opened it**, naming each package
   and the route below. It is part of the suite, so the required `checks` job reads it.

**What counts as a downgrade** (`scripts/deps-refresh/downgrades.mjs`). A version the base resolved
that the head no longer holds, where the head holds a lower version of the same major and none higher
or equal. Not downgrades: an upgrade, a package added or removed, a major change either way, and an
older copy added *beside* the one that stays (`@babel/parser` holds two). Within one major only the
highest copy is judged. Prereleases compare by semver precedence.

**Where it runs.** On a `pull_request` in CI it compares with `HEAD^1` of the merge ref (the `unit` job
checks out two commits for this), and **fails closed** if that base cannot be read. Locally it compares
with the merge-base with `origin/main`, and skips if `origin/main` is absent. On a push to `main`, a
dispatch or a schedule it does not run: a red `main` would withhold the production deploy (the release
gate), and there is no base to compare with. The weekly refresh's branch (`codex/weekly-deps-refresh-*`)
is exempt, since the seven-day window deliberately rolls back an entry `main` took younger than that
and its PR table lists every one.

**The route when it fails: replace the pull request, never repair it.**

1. Close it.
2. Make the same manifest change (`package.json`) on a `codex/` branch cut from `main`.
3. Run `node scripts/remote-check.mjs lockfile` in the background. It regenerates the lockfile on
   GitHub and moves nothing but what the manifests changed. Commit the files it writes.
4. Push and open the pull request. PR 6493 and PR 6595 are the worked examples.

**A rollback you meant** (a bad release being backed out) goes in `scripts/deps-refresh/allowed-downgrades.txt`,
one line per package, exactly as the failure prints it: `name from -> to`. An entry clears only that
exact rollback, so it is inert afterwards; delete it in the next pull request.

**Why not the other routes.**

- *Regenerate a Dependabot PR's lockfile in a workflow.* Commits pushed with a workflow's
  `GITHUB_TOKEN` start no CI, and a Dependabot PR's token is restricted. The PR would sit with stale checks.
- *Lower Dependabot's cooldown, or set `minimumReleaseAge` in `pnpm-workspace.yaml`.* The first removes
  the compromised-release protection `dependabot.yml` exists for. The second would break frozen installs,
  because `main` holds entries three to six days old.
- *Put the gate in `regenerate` mode.* That mode is how a person brings a deliberate young bump in.

**The gap that remains.** A `regenerate` run is not windowed, so a manual bump can still land a version
younger than seven days. The next Monday's Dependabot lockfile would roll it back, and the gate now
stops that from landing silently. The first weekly refresh after this change may likewise roll back
entries `main` took younger than seven days; they appear in its PR table like any other move.

## Commands

| Task | Command |
| --- | --- |
| Install or re-install the task | `powershell -ExecutionPolicy Bypass -File scripts\deps-refresh\install-task.ps1` |
| Another day or time | `... install-task.ps1 -Day Monday -At 09:30` |
| Remove the task | `... install-task.ps1 -Remove` |
| Rehearse without opening a PR | `node scripts/deps-refresh/refresh.mjs --dry-run` from a spare checkout; it switches that checkout to a new branch, and deletes the remote branch it pushed |
| Read what the last run did | `~/.claude/scripts/deps-refresh-task.log` |

A floor in `pnpm-workspace.yaml` is still how an advisory is answered on the day it lands. The refresh
is what stops the next allow-but-resolve-below advisory from needing one.

Pinned by `tests/deps-refresh.test.ts` and `tests/lockfile-downgrade-gate.test.ts`; `refresh.mjs`'s flag
gate by `tests/unknown-flag-gates.test.ts`.
