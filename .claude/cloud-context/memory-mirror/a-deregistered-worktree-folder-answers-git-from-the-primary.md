---
name: a-deregistered-worktree-folder-answers-git-from-the-primary
description: "A worktree removed while a session still has its folder open leaves a DEREGISTERED directory, and `cd` into it plus a bare git command silently resolves against the PRIMARY checkout on main — so the branch-deletion gate 'every file byte-identical on origin/main' compares main with main and PASSES VACUOUSLY. Prove ownership with `git rev-parse --absolute-git-dir`, or run the gate from the primary against the archived tip."
metadata:
  node_type: memory
  type: project
  originSessionId: f8ae6f5c-9f6a-423a-af23-a21c4bec1582
  modified: 2026-10-03T04:20:51.763Z
---

**Measured 2026-10-03, on `_wt-crm-mirror-refresh`.** The worktree was removed while this session had
it open (the app had been restarted; `git worktree list` no longer named it and
`.git/worktrees/<name>` was gone, but the folder survived carrying only its dangling `node_modules`
junction). `node scripts/new-session.mjs --remove` refused correctly — *"not a registered worktree"* —
and `repo-doctor.mjs` names the mechanism in its own husk section:

> Close the holder first; a worktree removed under a live session leaves it in a DEREGISTERED folder,
> where bare git commands resolve against the primary checkout on `main`.

**Why it is dangerous rather than merely untidy.** The three gates before deleting a branch
(`docs` / AGENTS §5) include *"every file the branch changed is byte-identical on `origin/main`"* — the
one gate that also holds for a roll-up member, which lands CLOSED rather than merged. Run from a
deregistered folder, `git log origin/main..HEAD` and `git rev-parse HEAD:<file>` answer **for the
primary, on main**, so the comparison is `main` against `main`: twelve files, all `same`, `0` differing,
and the gate reports PASS **having looked at nothing**. It fails OPEN, in the shape of a clean result —
the same family as the Validation cluster's *absent answer arriving as a negative one*.

Nothing warns you. The commands succeed, print plausible hashes, and `cd` into the folder works because
the directory still exists.

**How to apply.**

- Before trusting any git reading taken inside a `_wt-*` folder, prove whose repository answered:
  `git rev-parse --absolute-git-dir` must end in `.git/worktrees/<that task>`, and
  `git branch --show-current` must be that branch. One extra line, and it is the only thing that
  distinguishes a live worktree from a husk that answers anyway.
- A gate on a branch is safest run **from the primary**, naming the tip explicitly:
  `git show --name-only --pretty=format: <tip>` for the file list, then
  `git rev-parse <tip>:<file>` against `git rev-parse origin/main:<file>`. That holds even after the
  branch is deleted, provided the tip was archived first — which is why
  [[refs-deleted-is-not-automatic-archive-before-deleting]] matters here and not only for recovery.
- Clear the husk itself with care: its `node_modules` is a **junction**, and `Remove-Item -Recurse` or
  `rm -rf` can follow a reparse point into the primary's real `node_modules`. Remove the link ALONE —
  `(Get-Item -LiteralPath $link -Force).Delete()`, or `cmd /c rmdir <link>` with no `/s`
  ([[a-concurrent-pnpm-install-makes-node-modules-look-broken]] reaches the same conclusion from the
  other direction) — then the empty folder. 🔴 **And do not read the entry count afterwards as proof
  either way:** it read 61 immediately after and 63 a minute later, with `next` and `.pnpm` both
  present throughout, because a concurrent `pnpm install` moves that number on its own. A reparse-point
  delete cannot touch the target, so the junction is not what to suspect.

**It cost nothing this time, and only by luck:** the gate was re-run from the primary against the
archived tip `94a991fba` afterwards, and all twelve files genuinely were byte-identical, so #5199's
branch was safe to delete. The vacuous pass and the true pass were indistinguishable at the time.
Related: [[a-background-poller-dies-with-the-worktree-it-runs-in]] — same cause, a session outliving
its worktree, surfacing as a crash there and as a false green here.
