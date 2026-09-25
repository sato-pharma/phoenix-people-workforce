---
name: a-utc-timestamp-compared-against-cairo-manufactures-a-false-signal
description: "gh/API timestamps are UTC and git log prints local Cairo — comparing them without converting invents a 2-3h gap that reads as evidence, and it made squash residue look like post-merge work"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 68e76cae-f802-47c9-a773-009123bf6ccf
  modified: 2026-08-28T10:08:11.190Z
---

**`gh` and every REST API here return UTC; `git log --date=format:` and `date` print Africa/Cairo.
Egypt is UTC+3 in summer, so mixing them silently shifts an event by three hours** — and the shift
lands in whichever direction makes a stale reading look freshly confirmed.

Measured 2026-08-28. A worktree audit read:

- `gh pr view 2554 --json mergedAt` -> `2026-08-28T09:51:22Z` (**UTC**)
- `git log --date=format:'%H:%M'` -> commits at `12:09` – `12:44` (**Cairo**)

and concluded the six commits were written **three hours after their own merge** — which cannot be
squash residue, so it read as proof the branch held new, unpushed work. `09:51Z` **is** `12:51`
Cairo: every commit predated the merge by seven minutes. The branch was fully merged.

**Why this one is dangerous rather than merely wrong:** it does not fail loudly. It produces a
plausible, specific, *corroborating* number that hardens two other errors into a confident verdict.
In the 2026-08-28 case it converted the two documented false alarms in
[[repo-doctor-no-origin-ref-is-usually-squash-residue]] — `ls-remote` returning 0, and `git cherry`
marking every commit of a multi-commit squash `+` — from "suspicious readings I should test" into
"three independent signals agreeing". The audit then told **10 live sessions** to push merged
branches; only peer pushback stopped three conflicting PRs.

**Why:** AGENTS.md §4 already says report in Cairo and never raw UTC, but that rule is about
**presentation**. Nothing warned about mixing the two inside a **comparison**, which is where the
damage happens — the wrong number never reaches a human to be spotted, it just changes the verdict.

**How to apply:** never subtract or order two timestamps from different tools without normalizing
first. Convert to one zone explicitly and say which:

```bash
gh pr view <n> --json mergedAt --jq '.mergedAt'                 # UTC, ends in Z
git log -1 --date=iso-strict --format='%ad' <ref>               # local, carries +03:00
git log -1 --date=format-local:'%Y-%m-%d %H:%M %Z' <ref>        # force local, labelled
TZ=UTC git log -1 --date=iso --format='%ad' <ref>               # force UTC on both sides
```

Prefer `--date=iso-strict` in any check: it carries the offset, so the mistake becomes impossible
rather than merely unlikely. Keep the trailing `Z` visible when quoting an API time, and convert to
Cairo only at the moment of reporting to the owner. **A timing gap that seems to prove something
surprising is the signal to re-read both zones**, not to act. Related:
[[merged-branch-checks-must-be-squash-aware]] ·
[[reusing-a-squash-merged-branch-makes-a-conflicting-pr]]
