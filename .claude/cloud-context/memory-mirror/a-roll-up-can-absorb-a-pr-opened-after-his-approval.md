---
name: a-roll-up-can-absorb-a-pr-opened-after-his-approval
description: "`rollup-prs.mjs --apply` takes in every disjoint PR still open when it BUILDS, not when you asked — on 2026-10-23 his \"merge the roll-up of 6385 and 6386\" became #6388 carrying the 21:00 memory fold #6387 too, so re-ask (MCQ) before merging. And a member that merged on its own first does not void the roll-up: diff its files roll-up vs main, merge if byte-identical, then `--settle` closes the rest."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2beeae33-d9ef-4939-a1a9-5009a5477182
  modified: 2026-10-23T18:14:34.624Z
---

On 2026-10-23 at 21:01 Cairo the owner approved "merge the roll-up of 6385 and 6386 when green".
`rollup-prs.mjs --apply` waited ~6 minutes for checks, and in that window the 21:00 memory fold
opened as #6387 — so the roll-up it built (#6388) carried THREE PRs. Merging it on the two-PR
approval would have merged work he never named. Asked as an MCQ; he chose "Merge all three".

Then #6386 merged on its own (his account, 21:07:43 Cairo) before #6388 was green. AGENTS.md §6 says
a roll-up whose members landed first is CLOSED, never merged — but that is for when they ALL landed.
With one landed, `git diff --stat origin/main origin/<rollup-branch> -- <its files>` was empty, so
merging #6388 changed exactly the other two PRs' 19 files and nothing on main. After the merge,
`node scripts/rollup-prs.mjs --settle` closed #6385 and #6387 (it closes only PRs whose every file
is byte-identical on main).

**Why:** his approval names PRs; the roll-up's membership is decided later, by the script, from
whatever is open at build time.

**How to apply:** before merging a roll-up, compare its member list with the PRs he named — a new
member means a fresh MCQ. If a member merged first, diff that member's files roll-up vs main: empty
→ merge the roll-up; any difference → close it and rebuild. Afterwards run `--settle`, never
`gh pr close` by hand. In MSYS bash, `git rev-parse origin/main:<path>` is mangled into a Windows
path — use `git diff --stat` with `--` instead.
Related: [[re-read-the-pr-before-widening-its-branch]].
