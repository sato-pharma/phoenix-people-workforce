# The nightly cloud-mirror refresh

The account behind `scripts/cloud-mirror/`. The rule is one line in `.claude/rules/sessions.md`; this
file holds the evidence, the choices and what to do when a run goes wrong.

## What the mirror is, and why its freshness is the whole point

A **cloud** session is an isolated git clone. It gets the repository and its prompt and nothing else —
no `~/.claude/CLAUDE.md`, no auto-memory. Both are mirrored into the repo so it is not Phoenix-blind:

- `.claude/cloud-context/memory-mirror/` — the laptop's memory index and every note
- `.claude/cloud-context/global-standing-rules.md` — the owner's standing rules
- `.claude/cloud-context/laptop-hooks/` — the handful of `~/.claude/hooks/*.mjs` a repo test pins

A cloud session reads the mirror **as of the commit it clones**, so the mirror is only ever as fresh as
its last *merged* refresh. Until 23 October 2026 refreshing it was something a person had to remember:
the SessionStart banner measured the drift and said so, and the fix was a hand-run
`node scripts/sync-cloud-context.mjs` plus a PR. On 23 October the banner read **9 files behind** — 2
stale, 7 missing — and every one was a fact a cloud session would have answered with, wrongly and
confidently: the merge-burst deploy `failure` rows, the stale Auto-fix head, the `pg_stat_statements`
marker trap, the event-loop stall alert, the `CRON_SECRET` realignment, the system-audit ledger
exceptions.

The owner's instruction that day: *"widen 6337 with an automatic nightly mirror refresh"*.

## What runs, and when

| Piece | What it is |
| --- | --- |
| `scripts/cloud-mirror/refresh.mjs` | the job: mirror, prove healthy, scan, commit, push, open **or update** one PR |
| `scripts/cloud-mirror/run-refresh.mjs` | the scheduled launcher, copied to `~/.claude/scripts/cloud-mirror-run.mjs` |
| `scripts/cloud-mirror/install-task.ps1` | registers the Windows task **Phoenix nightly cloud mirror refresh** |
| `~/.claude/scripts/cloud-mirror-task.log` | every run's own record, in Cairo time |

Install or move it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\cloud-mirror\install-task.ps1
```

**04:07 Cairo, daily.** Clear of every other scheduled job on this laptop — the memory fold's
09:00/15:00/21:00, the CRM field day's 21:00, the weekly dependency refresh's Sunday 10:00, the 06:36
Needs You digest — and the quietest hour on a box where free RAM is what binds. Daily on purpose,
Sunday included, because a cloud session started on a Sunday reads the same mirror as any other day.
`-WakeToRun` and `-StartWhenAvailable` mean a shut lid is a late run, not a silent miss, and
`-MultipleInstances IgnoreNew` means a slow run is never overlapped.

Rehearse it without touching GitHub:

```bash
node scripts/cloud-mirror/refresh.mjs --dry-run
```

## Why a laptop task and not a workflow cron

Two independent reasons, either one enough:

1. **The source is not in any repository.** It is `~/.claude/projects/<slug>/memory/` and
   `~/.claude/CLAUDE.md` on this laptop. A GitHub runner has neither.
2. **A pull request opened by a workflow's `GITHUB_TOKEN` starts no CI.** Its required `validate` and
   `checks` would never report, so it could never merge. `scripts/deps-refresh/install-task.ps1` carries
   the same reasoning for the weekly dependency refresh, and this job is that one's sibling by design —
   same launcher shape, same bounded fetch retry, same task settings.

## How it relates to `bash-guard.mjs` C20 — they cover different halves

C20 refuses a **push that touches `.claude/`** unless that push carries a mirror refresh (owner,
2026-10-23: *"make it mechanical"*). It is the better of the two mechanisms, because the refresh then
rides a PR that is going to merge anyway. What it cannot cover is the quiet stretch: when nobody pushes
a `.claude/` file for days, the mirror drifts and nothing opens anything — which is how it reached 9
files behind. This job covers exactly that stretch, and neither replaces the other. **Do not "fix"
either one into the other**, and do not read a nightly refresh PR as licence to skip C20 on your own
push: an unmerged refresh PR leaves `main`'s mirror exactly as stale as it was.

## The four things it refuses

- **A second refresh PR while one is open.** It pushes onto the open one instead. The owner is never
  handed two of the same PR, and a `.claude`-only PR is never put to him at all (AGENTS.md §6) — the
  refresh PR lands by being rolled up with real work, or on his own word.
- **An unhealthy module-memory tree.** `node scripts/module-memory/build.mjs --check` must print
  `module memory: healthy` before anything is pushed. A PR that cannot go green would also block every
  later night on the one-open-PR guard.
- **Key material.** The laptop's gitleaks guard (`bash-guard.mjs` C12) reads *bash* commands, and this
  job pushes from node, so nothing else stands between a credential a memory note happened to quote and
  a public branch. The staged text is scanned for six shapes — an OpenAI-style key, a JWT, a GitHub
  token, a Supabase access token, a private-key block, an AWS key id — and deliberately not for prose
  like "service-role", which eleven mirrored notes legitimately discuss.
- **A night that moved nothing.** Nothing is committed, nothing is pushed, no PR is touched.

## 🔴 The commit carries three paths, always

`sync-cloud-context.mjs` mirrors the notes **and** runs `module-memory/build.mjs --file-new`, which
files every new slug in `scripts/module-memory/assignments.json` and rebuilds each module's generated
notes block. So a refresh commit stages all three of:

- `.claude/cloud-context`
- `.claude/rules`
- `scripts/module-memory/assignments.json`

Staging the mirror alone ships notes no module claims — an **orphan** — and `build.mjs --check` is
inside the required `validate` job. That is not theoretical: PR #5182's refresh on 2 October 2026
carried four new notes and no assignments change, `main` failed CI on three consecutive commits
(`8b2921549`, `3c83db4e9`, `be32d06dc`), and because the deploy is gated on that suite all three merges
were **withheld** from production. The cure was one commit filing the four slugs. The job stages through
`STAGE_PATHS`, and `tests/cloud-mirror-refresh.test.ts` pins the list so the three cannot drift apart.

## When a run goes wrong

| What you see | What it means |
| --- | --- |
| `NOCHANGE` in the log | the mirror already matched the laptop — the normal quiet night |
| `pushed onto #N` | a refresh PR was already open; this night's drift went onto it |
| `REFUSED — module memory is not healthy` | fix the orphan or stale block by hand, then rerun the job |
| `REFUSED — the refresh carries …` | a memory note quotes key material: redact it on the laptop, then rerun |
| `WAITING — origin/main has no …` | the PR carrying the job has not merged yet (the task is installed the day the job is written, because a cadence in a doc is not an installed job). After the merge, the same line means the script was renamed or removed |
| `FAILED — …` | the launcher's own line, with the reason and the last lines of output |
| nothing in the log at all | the task did not run: `Get-ScheduledTaskInfo -TaskName "Phoenix nightly cloud mirror refresh"` |

A manual run is always available from any local checkout:

```bash
node scripts/cloud-mirror/refresh.mjs
```

The SessionStart banner remains the independent reading — it measures the mirror against live memory and
owes nothing to this job, so a banner that still says the mirror is stale after a night means the
refresh PR has not **merged** yet, which is the one part no automation here will do.
