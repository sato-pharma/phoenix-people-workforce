---
name: a-watchers-exit-code-is-a-verdict-about-the-watcher
description: "A wait-for-production script's non-zero exit says the SCRIPT failed, never that the deploy did — twice on 2026-10-02 a shipped deploy read as STILL NOT LIVE, once because `git merge-base --is-ancestor` compared shas the primary had not fetched and once because git is not on PATH for node launched from the scratchpad (spawnSync ENOENT). Keep a watcher git-free: let it report only what /api/healthz says, and run the ancestry test by hand in the repo."
metadata:
  node_type: memory
  type: project
  originSessionId: 47e0759c-ce68-4b3d-9b7d-157208b1fa69
  modified: 2026-10-02T12:19:35.094Z
---

**Two false negatives about PRODUCTION in one session, both from the watcher rather than the deploy.**
Each printed a sentence that reads as a finding — and §2.3's recovery for a genuinely withheld deploy
is *do nothing*, so acting on either one would have meant `railway redeploy` or a re-merge, both
forbidden.

**The first.** A node poller called, with `cwd` set to the primary checkout:

```
git merge-base --is-ancestor <my merge sha> <the live revision>
```

It never fetched. The merge had happened seconds earlier through `gh`, which touches no local ref, so
the shas were not yet in the primary's object store; `is-ancestor` exits non-zero on an unknown
object exactly as it does on "not an ancestor", the `catch` read that as *not shipped yet*, and after
14 minutes it printed `STILL NOT LIVE`. Its own log had already recorded `live 2a173801b` — the merge
commit itself — one poll earlier. **The deploy had shipped, and the watcher's verdict said the
opposite of its own evidence.**

**The second, while fixing the first.** A `sed` insertion put `execFileSync("git", ["fetch", …])` at
module top level, and the script died immediately:

```
Error: spawnSync git ENOENT
```

Git is not on PATH for a node process launched from the session scratchpad on this machine. The
background task reported `failed with exit code 1`, which again reads as a statement about
production.

🔴 **The rule: a watcher must report only what it OBSERVED, and never convert an error into a
verdict.** The replacement polls `/api/healthz`, prints the revision when it CHANGES, and shells out
to nothing:

```js
if (rev && rev !== KNOWN) { console.log("MOVED: live is now " + rev); process.exit(0); }
```

The ancestry test is then one command run by hand **in the repository**, where git exists and
`git fetch` has just run:

```
git fetch -q origin main
git merge-base --is-ancestor <merge sha> <live revision>
```

Three things that follow from this and are easy to get wrong:

- **`is-ancestor` cannot distinguish "not an ancestor" from "I have never heard of that object".**
  Fetch first, or the test is meaningless — and a watcher that cannot fetch cannot run it at all.
- **Never test for an EXACT sha.** A later merge legitimately overtakes yours, so the live revision is
  often a descendant; `MOVED` plus a hand ancestry check covers both shapes, an equality test reports
  a false failure every time a second merge lands first.
- **A timeout is not a withheld deploy.** Classify on the suites and the deployment's own state
  history (`any(.[].state; . == "success")`, newest-first), never on a wait loop giving up —
  `in_progress` for twenty minutes happened twice this day and both finished fine.

Related: [[background-task-notification-exit-code-is-the-wrappers]] — the sibling in the other
direction, where a shell's exit status hides a real failure; and
[[a-no-commit-merge-probe-actually-merges-in-the-shared-primary]] —
a command that reports what it ran rather than what it did.
[[a-superseded-deploy-reached-success-a-withheld-one-never-did]] is the classification this protects.
