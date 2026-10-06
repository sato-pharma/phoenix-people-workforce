---
name: a-c10-refusal-is-not-proof-the-merge-did-not-happen
description: "bash-guard C10 refused a `gh pr merge` whose PR a PEER SESSION had merged seconds earlier, and its message explains the refusal as \"THIS PR IS NOT GREEN YET\" — which sent the reader at the PR's SIZE and its roll-up options instead of at its STATE. Re-read `gh pr view <n> --json state,mergedAt,mergeCommit` after ANY merge refusal before standing the clause down with PHX_MERGE_OK=1; a merge that already happened needs no stand-down, and the second `gh pr merge` would only have answered \"already merged\" anyway."
metadata:
  node_type: memory
  type: project
  originSessionId: 6c3f711f-4e48-4a68-9908-6dabfddf966b
  modified: 2026-10-06T09:49:32.893Z
---

Measured 2026-10-06 on #5377. The ship sequence read the PR at **09:32** — `state: OPEN`,
`mergeStateStatus: CLEAN`, `validate` and `checks` both SUCCESS against the live protection list.
The dependabot read came next, then `gh pr merge … --match-head-commit`, which
`.claude/hooks/bash-guard.mjs` clause **C10** refused on size (3 files). The PR had been merged at
**09:33:04Z** by a peer session holding the same `merge #5377` approval — the owner's instruction
reached more than one live session, which is normal here and documented.

**The trap is the refusal's own explanation.** C10 prints
`🔴 THIS PR IS NOT GREEN YET — that is the only reason you are reading this`, because its
stand-down for an already-green PR is real: a green open PR goes straight through. But the PR WAS
green, so that sentence was false, and everything around it — fold this in, run `rollup-prs.mjs`,
`PHX_MERGE_OK=1` if it must ship alone — points at PR SIZE and consolidation. None of that was the
situation. A session that follows the message as written either stands the clause down for a merge
that has already happened, or spends a turn re-litigating the batching rule.

**What to do instead, on ANY merge refusal:** re-read the PR before reacting to the reason given.

    gh pr view <n> --json state,mergedAt,mergeCommit --jq '{state,mergedAt,sha:.mergeCommit.oid}'

`state: MERGED` ends it — settle and verify shipped (`.claude/skills/ship/verify-shipped.mjs <n>`),
and never re-merge or redeploy. This also costs nothing when the refusal IS about size: one extra
read before a stand-down a session cannot un-spend.

Why the refusal's reason cannot be trusted here: a merged PR's `mergeStateStatus` reads `UNKNOWN`,
so whatever a size-or-greenness clause computes from the mergeability signals changes the moment the
merge lands — the refusal is evaluated against a PR that is no longer in the state the message
describes. The ordering is invisible from inside the hook.

Companion facts already recorded: an idempotent duplicate is free (a second `gh pr merge` answers
`was already merged` and changes nothing), so two sessions on one merge approval is not a race worth
preventing — see AGENTS.md §2.1, Parallel sessions. And `mergedBy` naming the owner is NOT evidence
of a human click: every session's `gh` token is his.

Related: [[the-small-pr-merge-guard-and-the-classifier-deadlock]]
