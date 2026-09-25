---
name: jq-not-installed-monitor-scripts-silently-do-nothing
description: "RESOLVED 2026-08-10 — jq 1.8.2 is now installed via scoop; the bash-guard C4 block was retired. Keep the underlying lesson about silent pipeline failures."
metadata:
  node_type: memory
  type: reference
  originSessionId: d7876385-32d4-4aa5-880a-8afbb11a769b
  modified: 2026-08-10T03:16:40.985Z
---

**RESOLVED 2026-08-10. `jq` IS installed now — 1.8.2, via `scoop install main/jq`, at
`~/scoop/shims/jq.exe`. Verified: `echo '{"n":42}' | jq -c '.n + 1'` → `43`.**

Two things were changed with it, so nothing keeps asserting the old fact:

- `.claude/hooks/bash-guard.mjs` check **C4** used to DENY any standalone `jq` command. It was
  retired in the same change — a guard that asserts something untrue costs every session a wasted
  round trip and teaches a false fact. C1 (recursive grep) is untouched and still fires.
- The stale claim was live for 6 days after the tool situation changed.

**The original lesson still stands and is the reason to keep this file:** `Monitor` treats only
**stdout** as its event stream. Any missing binary in a poll pipeline fails to **stderr**, so the
loop produces ZERO notifications, runs its full count, and ends with a bland "stream ended" — which
looks exactly like "the thing I'm watching hasn't happened yet". That is the most dangerous failure
mode a watcher has. On 2026-08-03 four CI monitors in one session were all silently inert this way.

**How to apply:** before arming a Monitor with any shell filter, `command -v` every binary in the
pipeline — don't assume, including about `jq` itself if PATH changes. `gh --jq` remains fine
independently (gh embeds its own). Per
[[background-task-notification-exit-code-is-the-wrappers]], never read success from the wrapper's
exit code — read the output file. See [[shell-grep-unusable-use-git-grep-or-rg]] for the guard that
is still active.
