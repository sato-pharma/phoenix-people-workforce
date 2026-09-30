---
name: hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces
description: "Owner ruling 2026-09-29, reaffirmed 2026-09-30: batch a whole feature into ONE PR even when he asks for it surface by surface, and even when a narrower PR already has his merge approval. Extends to a TOOL repaired defect-by-defect — the roll-up script took 8 merges in one day, ~224 billable CI minutes."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d0d4dd58-19c5-4a93-ae08-8323d3ea9bba
  modified: 2026-09-30T14:01:54.597Z
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

**A second-order cost he did not have to name.** On 2026-09-30, #4923 squash-merged an EARLIER state
of the roll-up branch onto `main` while the fix was still open, which put the open PR into conflict
AND briefly shipped a known-broken guard — one that made `--apply` refuse every build. Instalments
do not just cost minutes; they create windows in which a half-finished repair is what production has.
