---
name: hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces
description: "Owner ruling 2026-09-29: batch a whole feature into ONE PR even when he asks for it surface by surface, and even when a narrower PR already has his merge approval. Six PRs shipped one feature that day, ~168 billable CI minutes; three of them changed five files or fewer."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d0d4dd58-19c5-4a93-ae08-8323d3ea9bba
  modified: 2026-09-29T10:10:15.672Z
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
