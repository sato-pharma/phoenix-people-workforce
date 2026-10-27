---
name: mains-required-checks-are-four-not-six-checks-carries-the-suite
description: "main's required status checks are TWO as of 2026-09-29 - validate and checks; mobile and secret-scan were dropped. The list has now rotted FIVE times (4-5-6-4-2) and every doc naming a number is stale, so read it live from the protection API and never count to a number a doc or this memory gave you"
metadata:
  node_type: memory
  type: project
  originSessionId: 7509adda-7142-43a9-b3e4-1dd559563d31
  modified: 2026-10-01T00:00:00.000Z
---

🔴 **THE FILENAME SAYS FOUR AND IT IS WRONG — the list is TWO.** Read live from the protection API
on **2026-09-29**, twice, on the full protection object as well as the `contexts` shortcut:

```
["validate","checks"]        strict:false  enforce_admins:true
```

**`mobile` and `secret-scan` are no longer REQUIRED.** They may still run — being dropped from
protection does not delete the job — but neither one blocks a merge any more, so a PR touching
`mobile/` can go in with the Expo typecheck red, and a secret-scan finding no longer gates. Say that
plainly rather than reporting "all required checks green" as though it still covered them.

**The previous reading, 2026-09-27:** `["validate","secret-scan","mobile","checks"]`.

**`lint`, `typecheck` and `test` no longer exist as check names.** #4527 folded all three into the
single job **`checks`** (5-6 min on a code PR) to stop paying GitHub's per-job minute rounding four
times over. The unit suite is a STEP inside `checks`, not a job. `sast-scan` and `full-e2e` appear in
`gh pr checks` reading `skipping` and are not gates.

**THE DURABLE LESSON IS NOT THE NUMBER - IT IS THAT THE NUMBER ROTS.** This list has now changed
**five** times: **4 → 5 → 6 → 4 → 2**. 🔴 **This memory itself asserted "four" for two days and was
wrong, which is the whole argument for reading the API** — a memory is a point-in-time note, and
this one is named after a number it no longer holds. Every change left some doc stating the old one,
and it has failed in both directions:

- **2026-09-18**: `test` was split out of `validate` and nobody added the new name to protection, so
  for a day a red unit suite showed four green required checks and merged (#3950).
- **2026-09-27**: the three names were folded into `checks` while `AGENTS.md` and the `ship` skill
  still said six. A session following the skill counted to six, waited for three checks that no
  longer existed, and had to read the API to settle that a fully green PR was green. That session was
  this one, on PRs 4545 and 4549.

So: **read `gh api repos/it-gawish-hr/phoenix-people-workforce/branches/main/protection --jq
'.required_status_checks.contexts'` and count passes against what it returns.** Never quote a doc,
this memory included, as the source.

🔴 **AS OF 2026-09-29 EVERY DOC IN THE REPO IS STALE AGAIN** — `AGENTS.md` §2 and §7 both state four
and name `mobile` and `secret-scan` as required, and `MEMORY.md`'s hook says FOUR. They were correct
on 2026-09-27 and were not touched since; the protection changed under them. **Not corrected here on
purpose:** CI and the gate docs are the Repository health audit session's domain (below), so this was
reported to the owner instead of edited.

**Both docs were corrected the same night** (verified on `origin/main` at 4c7f9a25c): `AGENTS.md:73`
now says four, carries the 4→5→6→4 history and forbids quoting itself; `AGENTS.md` says the unit
suite is a step inside `checks`; `.claude/skills/ship/SKILL.md` line 55 names the four and its
description says to read them live. **Corrected 2026-09-27: an earlier version of this memory said
the docs had NOT been corrected** - that was true when written and stale within the hour, because the
rewrite landed on `origin/main` while this session held a checkout from before it. A doc claim read
from a loaded copy is a point-in-time note, not current state.

CI and the gate docs are the **Repository health audit** session's domain by the owner's instruction;
other sessions stand down from editing them.

Related: [[verify-the-emitted-artifact-never-the-source]].
