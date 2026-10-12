---
name: hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces
description: "Owner ruling 2026-09-29, reaffirmed 2026-09-30: batch a whole feature into ONE PR even when he asks for it surface by surface, and even when a narrower PR already has his merge approval. Extends to a TOOL repaired defect-by-defect — the roll-up script took 8 merges in one day, ~224 billable CI minutes. HARDENED 2026-10-12 — 'i will not merge a small pr': a small PR is never put to him at all, so it is never a Next step line; it waits for a roll-up or is absorbed into a wider branch, and a lone small PR with nothing to roll up gets widened by the work that is already in hand."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d0d4dd58-19c5-4a93-ae08-8323d3ea9bba
  modified: 2026-10-12T18:38:34.638Z
---

🔴 **Owner ruling, 2026-09-29 — his words: "batch the next feature into one PR, not six".** It
resolves a tension the older `AGENTS.md` §6 rule left open, and it resolves it toward COST.

**What happened.** One feature — the one-press hire from an open seat — shipped as **six** PRs in a
morning: #4723 (organogram, 10 files), #4727 (admin vacancies report, 4), #4731 (portal page, 5),
#4736 (candidate picker, 5), #4737 (narrowed query, 3) and #4740 (pinning his ruling, 2). Every
merge pays a full CI run on the PR **and** another on `main`, about 28 billable minutes each, so
roughly **168 minutes** for what is one feature. Three of the six changed five files or fewer —
exactly the pattern §6 already names as the whole bill.

**Why it happened, because the reasons were not stupid ones.** He asked for the surfaces one at a
time ("add the same one-press hire to the vacancies report rows", then "…to the portal page too"),
so each arrived as its own instruction. And twice I deliberately chose a NEW PR over widening one
that already carried his `merge <n> when green` — on the grounds that merging content he had not
approved is worse than paying for another run. He has now weighed those two against each other
himself and chosen the cheaper side.

**Why:** ~28 billable minutes per merge is the entire Actions bill (§6), and a feature delivered in
six instalments pays it six times for one piece of work. The finer-grained approval he was getting
in exchange is worth less to him than the minutes.

**How to apply.** When a request is plainly one feature arriving in instalments — the same
mechanism on another surface, a follow-up he names in the same breath, a pin of a ruling he just
gave — **hold the parts and open ONE PR when the feature is whole.** Say in one line that you are
holding, so he can override. Keep splitting only where AGENTS.md §6 already says to: a migration, a
locked file, a protected rule needing its own approval, or one urgent part among slow ones. When
his `merge <n> when green` is already on a PR and you then widen it, **say so plainly and let him
re-confirm** — that half has not been retired, it just stops being a reason to open a second PR.
See [[recommendation-goes-first-not-last]] and
[[never-put-his-physical-actions-in-the-next-step-box]].

## 🔴 It also covers a TOOL repaired defect-by-defect — reaffirmed 2026-09-30

**His words that day: "batch the next rollup-tool change into one PR instead of three".** This is a
DIFFERENT shape from the 09-29 case and the distinction is the useful part. There, one feature was
asked for in instalments. Here nobody asked for instalments at all: one script was changed again and
again as each new defect was discovered, mostly by different sessions, each discovery arriving as its
own honest "this is broken, fix it".

**Measured on `main`, 2026-09-30 — the roll-up tool took 8 merges in ONE DAY** (`git log --since`
over `scripts/rollup-*.mjs` and `tests/rollup-*.test.ts`, excluding the 3 commits that are roll-ups
rather than tool changes): #4820 built it, then #4827 (a carried PR is never rollable), #4876
(`--settle`), #4885 (branch name unique across history), #4886 (never roll up a red PR), #4888
(survive a member merging mid-build), #4906 (wait for members' checks) and #4922 (refuse a duplicate
roll-up, and never nest one). At ~28 billable minutes a merge that is roughly **224 minutes**, on a
script whose entire purpose is to REDUCE merges.

**Why this shape is easy to miss.** Every one of those PRs was individually justified — a real
defect, found by running the tool, fixed with a test. Nothing about any single one looks like
salami-slicing, which is exactly why the rule has to be applied to the DAY rather than to the PR in
front of you.

**How to apply.** When you fix a defect in a tool that is itself under active repair, **check
`gh pr list` for an open PR already touching that file before opening a second one, and widen it
instead.** Within one session, hold a newly found defect in the same area and ship it with the one
already in flight — that is what #4922 did with its two rules, and it was right. Across sessions,
widening someone else's open PR is not yours to do, so say so and let him choose. The give-away that
this rule applies is a file appearing in your `git log --since=today` more than twice.

## 🔴 Hardened 2026-10-12 — "i will not merge a small pr"

**His words, 21:4x Cairo, when #5802 (3 files, a regenerated cloud-context mirror) was put to him as
the only open PR and therefore as one clean merge: "i will not merge a small pr".** He did not ask
which one, he did not weigh it — he refused the shape.

**What this changes.** The 09-27 and 09-30 rules were about how Claude BUILDS: batch the work, roll
the strays up. This one is about what reaches HIM. A small PR is no longer a merge he declines — it
is a merge he never sees. So it never appears in a `Next step:` line, never in quoted words, and
never as "it is the only open PR, so it is one merge" — that sentence was precisely the mistake. It
waits.

**Why the roll-up script does not cover this case.** `rollup-prs.mjs` needs two or more open PRs with
disjoint files; with exactly one open it correctly reports nothing to roll up, and a session then
reads "nothing to roll up" as permission to hand over the single PR. It is not. With one small PR
open and no second one, the answer is to WIDEN it — commit the next piece of work onto the same
branch so the PR stops being small — or to leave it parked until a second PR exists.

**How to apply.** Before putting any merge to him, ask whether the diff would read as small to him:
a handful of files, a regenerated artifact, a doc, a mirror refresh, one line of config. If yes,
do not ask. Either add the work already in hand to that branch, or park it and say in one line that
it is parked and what it is waiting for. He is never asked to judge whether a PR is big enough; that
judgement is Claude's, exactly as "what counts as small" has been since 2026-09-30.

**A second-order cost he did not have to name.** On 2026-09-30, #4923 squash-merged an EARLIER state
of the roll-up branch onto `main` while the fix was still open, which put the open PR into conflict
AND briefly shipped a known-broken guard — one that made `--apply` refuse every build. Instalments
do not just cost minutes; they create windows in which a half-finished repair is what production has.
