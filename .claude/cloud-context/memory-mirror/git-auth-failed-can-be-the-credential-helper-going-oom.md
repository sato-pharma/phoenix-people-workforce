---
name: git-auth-failed-can-be-the-credential-helper-going-oom
description: "\"Invalid username or token / Authentication failed\" from git can mean the credential helper crashed on low RAM, not that the token is bad — check the Go panic above it and free memory before touching any credential."
metadata:
  type: project
---

`git fetch`/`push` can fail with what looks like a dead token and be a **memory** failure:

```
fatal error: out of memory allocating heap arena map
runtime.throw(...)
internal/cpu.doinit()          <- died during STARTUP, before doing anything
...
remote: Invalid username or token. Password authentication is not supported for Git operations.
fatal: Authentication failed for 'https://github.com/...'
```

`credential.helper` is `manager` (Git Credential Manager), a separate binary. When free RAM is gone it cannot even allocate its initial heap, so it dies at `internal/cpu.doinit` and hands git **nothing**. Git then attempts the request anonymously, and GitHub answers with the message it gives any password-less HTTPS attempt. **The token was never presented, let alone rejected.**

Observed 2026-08-23 at **0.55 GB free physical / commit charge 31.43 of 31.79 GB**, 13 node processes. The same command had worked minutes earlier with the same credentials.

**Why this one is dangerous:** the visible error names authentication, so the obvious next moves are all wrong and some are destructive — regenerating a PAT, running `gh auth login` (which can replace a working credential), clearing the credential store, or editing `.git/config`. All of that churns real secrets to fix a problem that is a closed session away. It also resembles [[git-push-oom-is-a-500mb-postbuffer-in-repo-config]] but is NOT the same fault: that one was git itself allocating a 500MB `http.postBuffer` up front (fixed, now 8MB). Here git is fine and the **helper** is what starves.

**How to apply:** before believing any git auth error, scroll UP for a Go/.NET panic and check free memory. If a runtime panic precedes the auth line, or free RAM is under ~1 GB, it is memory — close a session and retry, and change no credentials. Confirm with `Get-CimInstance Win32_OperatingSystem` (FreePhysicalMemory) and `git config --get credential.helper`. Sanity check that auth is actually intact with something that does not need the helper, e.g. `gh auth status` or an already-authenticated `gh api user`.

Related: this machine's RAM is soldered at 16 GB and thrashes past ~4 sessions — see AGENTS.md §5 and [[turbopack-500s-with-0xc0000142-when-commit-is-full]], which is the same root cause wearing a different error.
