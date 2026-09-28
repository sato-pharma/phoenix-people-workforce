---
name: mains-required-checks-are-four-not-six-checks-carries-the-suite
description: "main's required status checks are FOUR - validate, checks, mobile, secret-scan - because #4527 folded lint+typecheck+test into one `checks` job; the list has rotted four times, so read it live from the protection API and never count to a number a doc gave you"
metadata:
  node_type: memory
  type: project
  originSessionId: 7509adda-7142-43a9-b3e4-1dd559563d31
  modified: 2026-09-27T19:18:24.048Z
---

`main`'s `required_status_checks.contexts`, read live from the protection API on 2026-09-27:

```
["validate","secret-scan","mobile","checks"]
```

**`lint`, `typecheck` and `test` no longer exist as check names.** #4527 folded all three into the
single job **`checks`** (5-6 min on a code PR) to stop paying GitHub's per-job minute rounding four
times over. The unit suite is a STEP inside `checks`, not a job. `sast-scan` and `full-e2e` appear in
`gh pr checks` reading `skipping` and are not gates.

**THE DURABLE LESSON IS NOT THE NUMBER - IT IS THAT THE NUMBER ROTS.** This list has changed four
times: **4 → 5 → 6 → 4**. Every change left some doc stating the old one, and it has failed in both
directions:

- **2026-09-18**: `test` was split out of `validate` and nobody added the new name to protection, so
  for a day a red unit suite showed four green required checks and merged (#3950).
- **2026-09-27**: the three names were folded into `checks` while `AGENTS.md` and the `ship` skill
  still said six. A session following the skill counted to six, waited for three checks that no
  longer existed, and had to read the API to settle that a fully green PR was green. That session was
  this one, on PRs 4545 and 4549.

So: **read `gh api repos/Gawish-1997/phoenix-people-workforce/branches/main/protection --jq
'.required_status_checks.contexts'` and count passes against what it returns.** Never quote a doc,
this memory included, as the source.

**Both docs were corrected the same night** (verified on `origin/main` at 4c7f9a25c): `AGENTS.md:73`
now says four, carries the 4→5→6→4 history and forbids quoting itself; `AGENTS.md:467` says the unit
suite is a step inside `checks`; `.claude/skills/ship/SKILL.md` line 55 names the four and its
description says to read them live. **Corrected 2026-09-27: an earlier version of this memory said
the docs had NOT been corrected** - that was true when written and stale within the hour, because the
rewrite landed on `origin/main` while this session held a checkout from before it. A doc claim read
from a loaded copy is a point-in-time note, not current state.

CI and the gate docs are the **Repository health audit** session's domain by the owner's instruction;
other sessions stand down from editing them.

Related: [[verify-the-emitted-artifact-never-the-source]].
