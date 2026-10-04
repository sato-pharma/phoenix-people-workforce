---
name: uncommitted-worktree-work-is-snapshotted-hourly
description: "Every uncommitted file and unpushed commit in every Phoenix worktree is copied hourly to F:\\PHX backup\\08-worktree-uncommitted by ~/.claude/scripts/worktree-uncommitted-snapshot.mjs (task \"Phoenix Worktree Snapshot - Hourly\") — content-addressed, never deletes, read-only on the worktrees, frozen paths left alone; a failure now reaches the owner on Telegram via ~/.claude/scripts/worktree-snapshot-watch.ps1 (task \"Phoenix Worktree Snapshot - Failure Alert\", hourly, --dry-run to read its verdict without sending)."
metadata:
  node_type: memory
  type: project
  originSessionId: 1baaa0f5-9436-457f-8907-da9439516d28
  modified: 2026-10-04T04:42:22.416Z
---

Built 2026-10-04 at the owner's instruction, after a one-off copy proved a snapshot goes stale within
minutes: `_wt-perf-remaining` read **19** uncommitted files when measured and **30** by the time they
were copied, and `_wt-headwind-upload-limit` went from 3 uncommitted files to 0 plus one unpushed
commit while the copy was running.

- **Script:** `~/.claude/scripts/worktree-uncommitted-snapshot.mjs` — `--quiet`, `--dry-run`,
  `--root <dir>`, `--dest <dir>`. Exit 0 when sound (including "nothing changed"), **1 only on a real
  failure**, which is what any alert should key on.
- **Task:** `Phoenix Worktree Snapshot - Hourly` — `conhost.exe --headless node.exe "<script>"
  --quiet`, hourly indefinitely, `StartWhenAvailable`, batteries allowed, Priority 7, `PT30M` limit,
  `IgnoreNew`, satoh/Interactive/Limited — the same shape as `Phoenix xlsx Snapshot - Hourly`.
- **Destination:** `F:\PHX backup\08-worktree-uncommitted\<YYYY-MM-DD_HHmm>\<worktree>\<path>`, plus
  `_tracked-changes.patch` and `_unpushed-commits.bundle` per worktree and a `manifest.json`
  (per file: git state, size, sha256; per worktree: branch, HEAD, unpushed commits, skips + reasons).
- **Log / heartbeat:** `~/.claude/scripts/worktree-snapshot.log` (capped at 1,500 lines) and
  `worktree-snapshot.alive`.

**Four things not to "fix" back:**

- 🔴 **It NEVER deletes and has no retention sweep.** The snapshots are full of `.md`, which the
  owner's standing rule protects in every folder. Growth is bounded by **content addressing**
  instead: each distinct content is stored once under `_blobs/<ab>/<sha256>` and every snapshot
  hard-links to it. Proven the same day — a second run one minute later stored **0 new / 48 reused**.
- 🔴 **It is read-only on every worktree.** No stage, no commit, no push, no checkout. Unpushed
  commits are captured with `git bundle create <out> origin/main..HEAD`, which creates no ref and
  moves no branch — copying working-tree files misses them entirely.
- 🔴 **Frozen paths are skipped, not copied** (`mobile/`), matching how `rollup-prs.mjs` holds a
  frozen path out of anything it handles in bulk.
- 🔴 **It is NOT disk-failure protection** — see [[there-is-only-one-disk-so-no-local-backup-covers-a-disk-failure]].
  It guards a `git clean`, `reset --hard`, `stash -u`, `checkout --` and a worktree removal.

**The failure alert is wired — `~/.claude/scripts/worktree-snapshot-watch.ps1`, task `Phoenix
Worktree Snapshot - Failure Alert`, hourly, built 2026-10-04.** It needed a watcher of its OWN
rather than an env override of `xlsx-snapshot-watch.ps1`, because that one parses the xlsx log's
`===== ` header format with an xlsx-specific message body and hardcodes its `$LOG` and `$STATE`
(only `PHX_XS_SNAPLOG` was parameterised). The new one makes **all four** overridable —
`PHX_WS_TASK`, `PHX_WS_SNAPLOG`, `PHX_WS_LOG`, `PHX_WS_STATE` — precisely so each branch can be
exercised against a fixture **on the file that actually runs**.

- It inherits the xlsx design on purpose: **it judges the TASK's recorded result, not the script's
  own report** (a killed run never reaches its last line — and this snapshot writes ONE log line, at
  the END, so a run reaped at the 1,800 MB floor leaves nothing in its own log at all); it
  **deliberately does not alert on a missed run** (laptop asleep, `StartWhenAvailable` catches up, a
  noisy alert gets muted) but does report a DISABLED or DELETED task; Telegram, not email; and it
  never throws — every failure path logs and exits 0.
- `--dry-run` prints the verdict and sends nothing. **There is no `--test` send** — a test send
  reaches his phone and is banned, and the channel needs no fresh proof: same credentials, same
  `employees → telegram_connections` lookup, same Bot API call as the xlsx alert since 2026-09-09.
- Five branches proven on the real file, 2026-10-04: healthy, task deleted, task disabled, a real
  non-zero `LastTaskResult` (a throwaway task made to exit 1), and a `FAIL` line in the snapshot log
  (fixture) — which reports the `PROBLEMS:` text, so the message names WHAT broke where the bare
  exit code cannot.
- Same `$STATE` signature de-duplication with a 12-hour repeat, and a RECOVERED message when it
  comes back.

🔴 **The one branch that could not be induced is `unreadable`** — see
[[get-scheduledtaskinfo-without-taskpath-can-return-null-and-read-as-healthy]], the trap that
branch exists for.

**One bug worth remembering, because it failed in the direction that still looks right:** reading
`git status --porcelain` through a helper that `.trim()`s the whole stdout eats the **leading status
space of the first line only** — ` M path` becomes `M path`, so `slice(3)` returns `ath` and that one
file is silently skipped. The signature is exactly one truncated path per worktree
(`.claude/…` → `claude/…`, `app/…` → `pp/…`), caught only because the dry run printed the paths.
Strip trailing newlines only. See [[a-break-that-passes-may-be-rescued-not-correct]] for the wider
class.
