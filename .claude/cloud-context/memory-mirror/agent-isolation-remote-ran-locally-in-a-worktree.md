---
name: agent-isolation-remote-ran-locally-in-a-worktree
description: "From a desktop session the Agent tool's `isolation: \"remote\"` did NOT reach a cloud machine — the helper ran on this 16 GB laptop in a temporary `.claude/worktrees/agent-<id>` worktree, with npm and node, and nothing said it had fallen back. It is no way past the RAM floor; read the helper's own paths before telling the owner where work ran."
metadata: 
  node_type: memory
  type: project
  originSessionId: 48fa2908-468d-4a5c-822d-89d713129da3
  modified: 2026-09-17T08:59:46.129Z
---

**Measured 2026-09-17.** Free RAM sat under the heavy-queue floor for an hour, so a session
launched `Agent` with `isolation: "remote"` (the tool describes it as a remote cloud environment,
"availability is gated") to re-run a small test proof off the laptop, and told the owner nothing
would run locally. The launch result said only "Async agent launched successfully"; no notice of a
fallback. The helper's own report then showed it had run HERE:

- its clone was `F:\Phoenix Workforce\phoenix-workforce\.claude\worktrees\agent-<id>`;
- it wrote into the PARENT session's scratchpad and `npm install`ed typescript there;
- this machine's bash guard refused one of its commands.

The worktree was removed automatically afterwards (not registered, no folder, no branch left).
**Not always (a second session, same day):** its helper junctioned `node_modules` from the primary
and the worktree STAYED — registered, detached, plus a local `worktree-agent-<id>` branch.
`new-session.mjs --remove` refuses any `.claude/worktrees` path, so after owner approval: `cmd /c
rmdir <worktree>\node_modules` (no `/s` — drops only the link), `git worktree remove <worktree>`,
then `git branch -D worktree-agent-<id>` once its tip is an ancestor of `origin/main`.

**Why:** the owner routes heavy work off this laptop because it hard-freezes under ~1.8 GB free
([[laptop-m17r2-ram-soldered-16gb-ceiling]]). A silent local fallback both loads the machine and
makes the session's "it runs in the cloud" report false.

**How to apply:** never tell the owner work runs in the cloud on the strength of
`isolation: "remote"`. Read the helper's reported paths first — an `F:\` path or a
`.claude\worktrees\agent-` folder means it ran locally. Treat such a helper as a local job that
respects the RAM floor; work that truly must leave the laptop goes to a real cloud session
([[parallel-work-model-2026-07]]). Related: [[verify-the-emitted-artifact-never-the-source]]
