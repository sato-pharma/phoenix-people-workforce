---
name: the-sidebar-is-per-account-and-seeded-at-app-startup
description: "Code-tab sidebar sessions are files under Claude-Data/<profile>/claude-code-sessions/<accountUuid>/<orgUuid>/, so switching accounts hides them; the app seeds its list at STARTUP, so files copied in are invisible until it reopens."
metadata:
  node_type: memory
  type: project
  originSessionId: 839b265c-3488-4f15-88d1-073f42da754a
  modified: 2026-11-05T22:21:37.562Z
---

Each account keeps its own sidebar store at
`C:\Users\satoh\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\claude-code-sessions\<accountUuid>\<orgUuid>\`
— one `local_<id>.json` per session plus `archived-sessions.idx`; a session file names no account, so the
folder IS the account scoping and a copy between folders is a valid move. The account uuids on this laptop:
`9b516841-…` = phoenixx.oag@gmail.com (org `49b621c0-…`), `87292b52-…` = oagaweesh@gmail.com (org
`a9f7fee4-…`, the one `CLAUDE_CODE_ORGANIZATION_UUID` carries). A session is in the sidebar when its file
says `isArchived: false` AND its id is absent from that store's `archived-sessions.idx`.

🔴 **The running app serves `list_sessions` from memory seeded at STARTUP** — files copied into the store
answer `Session … not found` to `get_session` and never appear until the app is reopened, so a copy is only
half the job and HE does the reopen (never Claude; the RAM-meter rule). A session already in the store but
archived is the other case, and `unarchive_session` fixes that one live, no reopen.

**Why:** 2026-11-04 he asked for the other account's sidebar on this one. 50 of its 56 live sessions had no
file here, 4 were archived here, 2 were already live.
**How to apply:** copy ONLY the missing `local_*.json` (the importer does it:
`import-account-sessions.mjs --into <this account> --account <other> --apply`; `--into` exists because
`~/.claude.json` names the CLI's login, not the app's — 2026-11-06 they differed and a plain run went backwards),
then tell him to quit and reopen Claude — and never read the sidebar as the proof until he has.
🔴 **NEVER unarchive a session that is archived on the TARGET account** (owner, 2026-11-06, angry): he archived
it there himself, on purpose; "active on the other account" does not override his archive here. On 2026-11-06 I
unarchived 8 such sessions and had to re-archive them.
Transcripts are keyed by project path, not account ([[b-10-is-the-owner-himself]] account aside), so every
copied row resumes: 50/50 had a live `.jsonl` under `~/.claude/projects`.
