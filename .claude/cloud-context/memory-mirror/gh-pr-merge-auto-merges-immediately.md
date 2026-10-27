---
name: gh-pr-merge-auto-merges-immediately
description: "`gh pr merge --auto` is banned here; and when a merge IS refused, gh names `--admin` in its own error text — that flag bypasses every required check on the branch that ships straight to production (the gate is TWO as of 2026-10-01, validate and checks — read the protection API, never a count from a doc)"
metadata:
  node_type: memory
  type: reference
  originSessionId: 754fd1a7-c721-44c9-a3f6-4ec9eeebba77
  modified: 2026-10-01T00:00:00.000Z
---

Two separate traps on `gh pr merge` in `it-gawish-hr/phoenix-people-workforce`.

## 1. `--auto` does not mean "merge when green"

`gh pr merge <n> --squash --auto` does **NOT** wait for checks. Auto-merge is not enabled on the
repository (`allow_auto_merge: false`), so gh falls back to an immediate merge, prints **nothing**,
and exits 0. Confirmed 2026-07-30: PR #1483 merged at 03:16:56Z while `validate` was still
`in_progress`. Afterwards `autoMergeRequest` is `null` and `state` is `MERGED` — the tell that it
merged rather than armed. **Never use it.** Poll until checks settle, then merge plainly.

## 2. When a merge is refused, gh SUGGESTS the bypass — do not take it

Observed 2026-08-22 on PR #2290:

```
X Pull request …#2290 is not mergeable: the base branch policy prohibits the merge.
To have the pull request merged after all the requirements have been met, add the `--auto` flag.
To use administrator privileges to immediately merge the pull request, add the `--admin` flag.
```

Both suggestions are wrong here. `--auto` is trap 1. **`--admin` bypasses every required check
on the branch that deploys straight to production** — it is the single most destructive flag
available in this repo, and gh recommends it by name at exactly the moment a tired session wants
the merge to just work. The refusal is the gate doing its job.

The real cause of that particular refusal was benign and is worth recognising: **the head SHA had
moved** (another session pushed mid-flight), so CI was re-running from scratch and no required
check had passed on the NEW head yet. `mergeable: MERGEABLE` with `mergeStateStatus: BLOCKED` is
the signature. The fix is to wait, never to bypass — see
[[merge-blocked-says-checks-but-means-behind]] for the other cause of BLOCKED.

## Two claims this file used to make that are now FALSE

Both were true when written and are not any more. Do not act on the old versions:

- ~~"`main` has no branch protection and no rulesets"~~ — **`main` IS protected**, `enforce_admins:
  true`, with two required checks (`validate`, `checks`). Proven by the
  refusal above: a merge was actually blocked. *(Corrected 2026-10-01 — the gate is TWO, `validate` and `checks`; read the protection API, never this line.)*
- ~~"production is protected independently — the deploy gate refuses any commit whose ci.yml
  conclusion is not success"~~ — **there is no such gate.** A merge to `main` is the production
  deploy, at full traffic, within minutes. Measured 2026-08-22: #2291 merged as `f1b26f09` and
  `/api/healthz` reported that revision live at 18:23:07 Cairo. See
  [[railway-merge-is-the-production-deploy]].

**How to apply:** merge plainly, only after `gh pr checks <n>` shows all four green **on the
current head SHA**, and re-read `headRefOid` immediately before merging — it moves. If the merge is
refused, find out why; never reach for `--admin`.

## 2026-09-03 — `--auto` now ERRORS instead of silently merging (do not relax the rule)

Trap 1's mechanism has changed. On PR #2963 I ran, without having recalled this file:

```
gh pr merge 2963 --squash --auto --delete-branch
GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)
```

It refused cleanly and merged **nothing** — PR stayed `OPEN`, `autoMergeRequest: NOT ENABLED`.
That is the opposite of the 2026-07-30 observation, where it fell through to an immediate merge
while `validate` was still running.

**The rule is unchanged and the reason is stronger, not weaker.** I used the banned flag and was
saved by a gh/GitHub behaviour change, not by judgement. Both behaviours share one root cause —
`allow_auto_merge: false` on this repo — and which one you get depends on the gh version in the
session. Never use `--auto` to mean "merge when green"; you cannot know from inside a session which
of the two you will get, and one of them ships an unvalidated commit to production.

**What to do instead** — this worked well on #2963 and is worth copying: a background poll that
merges only when BOTH hold, (a) `gh pr checks` shows zero `pending` and zero `fail`, and (b) the
head SHA still equals the exact commit you reviewed. The SHA guard is the important half — a peer
session pushing mid-flight is common here, and without it a green-on-a-new-head merge ships code no
one read. Tell the peer session to hold off pushing once the watcher is armed, or a well-meant
follow-up commit costs a full CI cycle. See [[a-merge-mid-session-orphans-your-next-push-silently]].
