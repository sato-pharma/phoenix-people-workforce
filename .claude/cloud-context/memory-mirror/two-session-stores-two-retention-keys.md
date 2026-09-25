---
name: two-session-stores-two-retention-keys
description: "Claude Code keeps TWO session stores, not one - ~/.claude/projects holds the conversation text and AppData\\Roaming\\Claude\\claude-code-sessions holds one metadata record per session PER ACCOUNT reaching back months; they are pruned by two SEPARATE settings keys, so a session told \"everything is lost\" has usually only looked at the first one."
metadata: 
  node_type: memory
  type: project
  originSessionId: a508021d-327c-4abf-84c3-8e7f542eb230
  modified: 2026-09-21T02:15:01.639Z
---

**There are TWO stores, pruned by TWO different keys.** Never conclude that session
history is gone after looking only at `~/.claude/projects`.

| Store | Holds | Pruned by |
| --- | --- | --- |
| `~/.claude/projects/<slug>/*.jsonl` | the CONVERSATION TEXT | `cleanupPeriodDays` |
| `AppData\Roaming\Claude\claude-code-sessions\<accountUuid>\` | one JSON per session: title, cwd, model, effort, `completedTurns`, `isArchived`, and a `prs` array carrying each PR's number, branch and state - **no message text** | `desktopSessionCleanupPeriodDays` |

**The second store is PER ACCOUNT and much deeper.** Measured 2026-09-21: 3,410
records across 8 account folders, 9 May -> 21 September, 3,631 distinct PRs, 3,229
of them Phoenix. The owner has used several accounts - `87292b52` is
oagaweesh@gmail.com, `9b516841` is phoenixx.oag@gmail.com, and `dc571dfc` (712
sessions, 9 May -> 4 Aug) is **his OLD account, confirmed by him 2026-09-21**
along with `e1276ba8` and `b7c40aef`: *"dc571dfc is my old account, keep all
three"*. `~/.claude/relay/accounts.json` maps uuid -> email but only began
tracking on 2026-09-17, so anything older carries no email and is NOT a stranger.

**A third store, `~/.claude/file-history/<sessionId>/<hash>@vN`, keeps every
version of every file a session edited** and is pruned by neither key.

🔴 **Neither `cleanupPeriodDays` nor `desktopSessionCleanupPeriodDays` existed
before 2026-09-21 03:15/03:17**, when both were set to 7. The first drove a
hand-applied sweep at 03:23 that destroyed 1,771 files / 3.877 GB / 628 sessions
- unrecoverably: the Recycle Bin was bypassed, and this machine has no Volume
Shadow Copies and no restore points. **The deletion record
`~/.claude/backups/deleted-transcripts-2026-09-21.txt` is a FULL manifest** (mtime,
bytes, path for all 1,771), so what was lost is always itemisable even though the
text is not.

**Two copies, on purpose.** The MASTER is `F:\Claude Recovery 2026-09-21\`, kept OUTSIDE
any git tree because `git clean -fdx` overrides ignore rules by design. A verified
working copy sits in the repo folder at
`F:\Phoenix Workforce\phoenix-workforce\claude-recovery-2026-09-21\` (5,092 files,
237 MB, counts identical), gitignored - the 237 MB payload must never enter git
history, where deleting it later would not remove it. The readable record IS
committed, as `docs/recovery-2026-09-21.md` (PR #4161), so it reaches every session
and worktree without depending on one folder on one disk.

**Changing either key is a `settings.json` edit - always the owner's own paste,
never via sed or node.** See [[automode-allow-cannot-authorize-editing-the-permission-config]].
