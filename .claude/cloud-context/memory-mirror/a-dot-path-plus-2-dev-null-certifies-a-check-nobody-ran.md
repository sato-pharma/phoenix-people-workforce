---
name: a-dot-path-plus-2-dev-null-certifies-a-check-nobody-ran
description: "On MSYS a git pathspec whose FIRST character is a dot gets rewritten, so `git cat-file -e \"origin/main:.claude/...\" 2>/dev/null` fails on stderr and the redirect turns a fatal into a confident NOT-ON-MAIN. Prefix `MSYS_NO_PATHCONV=1`, or `./`, and never swallow stderr on a check whose negative answer authorises a delete. The CLASS is wider than the negative direction: re-measure any result you are about to report, in the direction you did not expect - five instances in one day, four reading as nothing-is-there and one as something-IS-there."
metadata:
  node_type: memory
  type: project
  originSessionId: f8ae6f5c-9f6a-423a-af23-a21c4bec1582
  modified: 2026-10-03T05:22:00.345Z
---

**Reported by a peer session on 2026-10-03** (`Fix the numbers on Phoenix CRM manager reports`), which hit
it while deciding whether seven untracked cloud-mirror notes already existed on `main`:

```
git cat-file -e "origin/main:.claude/cloud-context/memory-mirror/<slug>.md" 2>/dev/null
```

MSYS rewrites a pathspec whose **first character is a dot**, git then fails loudly on **stderr**, and the
`2>/dev/null` turns that fatal into a clean non-zero exit — which the caller reads as *"not on main"*.
All seven came back NOT-ON-MAIN. `git ls-tree` proved **five of them were already there**. Acting on the
verdict would have deleted five notes believing they were unique.

**The fix is either half:** `MSYS_NO_PATHCONV=1` (and `MSYS2_ARG_CONV_EXCL='*'`) in front of the command,
or a `./` prefix on the path so it does not start with a dot. The deeper rule is the second half: **never
swallow stderr on a check whose NEGATIVE answer authorises a destructive action.** Redirect to a file and
read it, or let the error surface — a fatal that looks like a clean "no" is the worst shape a check can
take.

**It is the same family as [[a-deregistered-worktree-folder-answers-git-from-the-primary]]**, found the
same day from the other direction: there a gate compared `main` with `main` and reported every file
`same`; here a gate could not read the path at all and reported every file absent. Both **passed having
looked at nothing**, and in both the output was indistinguishable from the true answer. A check that can
fail silently must carry a POSITIVE CONTROL — print the bytes or the count actually read, so a zero-hit
result is only believable beside a non-zero one.

**Three more instances of the same instrument error, measured in one session on 2026-10-03**, which is
why this is a class and not a one-off: a diff inspected with `grep -v "^[+-][+-]"` silently dropped every
ADDED line (`+- \`slug\``) and read as *"the notes were never filed"*; a markdown section sliced with
`/\n\*\*[A-Z]/` matched the first bold span of the first bullet and reported an 11,560-byte cluster as
**224 bytes with everything missing**; and `innerText` on a **detached cloned** DOM node returned `''`,
reading as an empty page. **None of the three was a defect in the thing being measured.**

🔴 **AND THE CLASS IS NOT ONLY THE NEGATIVE DIRECTION — a peer session's instance of it read as
"something IS there".** Reported 2026-10-03 by `Fix the numbers on Phoenix CRM manager reports`: it read
`phoenix_crm_countable_visits` on Delta (1)'s go-live morning and told the owner that one rep had 1 AM and
3 PM visits on the last working day. Those four rows were her **test persona** — the view drops one base
row and says nothing about `is_test`, and it carries an `is_test` column, which a view that had filtered
it would have no reason to do. A view's NAME is not its WHERE clause
([[phoenix-crm-countable-visits-does-not-exclude-test-rows]], and
[[head-office-sales-are-absent-from-phx-monthly-achievement]] is the same error with absent rows read as a
real zero).

**So state the rule in the direction-neutral form, which is the peer's wording and better than the one
this note started with: RE-MEASURE ANY RESULT YOU ARE ABOUT TO REPORT, IN THE DIRECTION YOU DID NOT
EXPECT** — with a different instrument, not a second run of the same one. An empty result that should
have been full and a full one that should have been empty come from the identical root cause: an
instrument assumed to have done a filter, an escape or a layout pass it never did.
