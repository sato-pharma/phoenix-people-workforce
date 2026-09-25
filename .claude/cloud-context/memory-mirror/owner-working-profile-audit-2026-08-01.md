---
name: owner-working-profile-audit-2026-08-01
description: "Measured profile of how the owner actually works (60 transcripts, 90d of git) — the evidence behind the tailored AGENTS.md"
metadata: 
  node_type: memory
  type: user
  originSessionId: c8217a8f-ead4-4534-8079-481b0e017f4f
  modified: 2026-08-01T09:10:54.145Z
---

Audit of 60 recent session transcripts (1,622 owner messages) and 90 days of git, run 2026-08-01.

**Delivery:** 2,731 commits/90d (~30/day), **1,244 fix vs 903 feat** — more than half of all work
repairs earlier work. 4.7 files/commit. 26 reverts. Hot: `src/lib` > `src/components` > `app/api` >
`supabase/migrations`.

**What he asks for:** shipping/merge/deploy **21%** of messages (by far the largest; "merge" is the
2nd most common opening word after "task"), verify/prove **11%**, "did you finish it all" **11%**,
corrections **9%**, urgency 8%, frustration 4%. 61% of messages are under 60 characters.

**When and how long:** peak activity at **midnight and 04:00 Cairo**, quietest at 17:00. Sessions
run **6.5h median, 79h at p90, 8.9 days max** — context compaction is guaranteed, which is why
[[compaction-replay-mistaken-for-live-state]] keeps recurring. 496 transcripts / 2 GB on disk.

**Why:** the top request is proof, and the fix:feat ratio is what happens without it. The tailored
AGENTS.md § 1 ("the five rules that prevent the rework") is derived directly from these numbers.

**How to apply:**
- The audit found **only 4 of 15 sampled owner rules were in the rulebook**; the other 11 lived only
  in memory files that load unpredictably. They are now written into AGENTS.md § 4 "Standing owner
  rules". **When the owner states a new standing preference, put it in AGENTS.md § 4, not only in a
  memory file** — otherwise it will not reliably reach a session.
- Two conflicts were reconciled there and should not be re-broken:
  **(a)** [[validate-once-at-done-not-per-edit]] (typecheck+lint once after a batch of page edits) vs the
  Validation Matrix (full gate) — resolved as *cadence applies to UI iteration, matrix is the floor
  for risky tiers*; **(b)** [[never-skip-ask-until-resolved]] (ask hundreds of questions) vs
  [[owner-heavy-parallel-workload-reduce-friction]] (fewer asks) — resolved as *ask when the answer
  changes the outcome, decide when it does not*.
- Statusline now shows **session age** (hidden <1h, shown 1–4h, "START A FRESH ONE" past 4h), fed by
  a session-start stamp written by the SessionStart hook into `~/.claude/.session-starts/`.
  See [[laptop-m17r2-ram-soldered-16gb-ceiling]].
