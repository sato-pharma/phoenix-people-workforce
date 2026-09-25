---
name: dont-foreground-watch-long-pipelines
description: "Owner feedback 2026-07-30: don't burn wall-clock polling CI/deploy runs in the foreground — launch them in the background and report at the end"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 754fd1a7-c721-44c9-a3f6-4ec9eeebba77
  modified: 2026-07-30T03:03:50.254Z
---

Owner said "everything very slow still" and, asked what they meant, picked **"This session — I'm
taking too long"** — not the pipeline, not the app. The cause was my working style, not the work:
I ran foreground polling loops (`for i in $(seq 1 40); do ... sleep 30; done`) to watch CI and
deploy runs complete, three separate times in one session. Each cycle is ~13 min of the owner
staring at a spinner while I add nothing.

**Why:** verifying against real runs is right (it caught that my `.next/cache` "optimization" did
nothing, and that my 46%-faster estimate was really ~20%). The mistake was doing that verification
**synchronously in the owner's turn** instead of in the background. The evidence was worth having;
the live watching was not.

**How to apply:**
- Long external waits (CI, deploys, Cloud Build, cron) → `run_in_background: true`, or just kick it
  off and move on. I get notified on completion. Never `sleep`-poll one in the foreground.
- While something builds, do the *next* piece of work — don't block on it.
- Batch the decision points. I interrupted with three separate `AskUserQuestion` calls here; this
  owner runs heavy parallel work and wants fewer, bigger checkpoints
  ([[owner-heavy-parallel-workload-reduce-friction]]).
- Report the measured result once at the end, not a running commentary of each poll.

Applies to any pipeline in this repo: CI is ~4 min, prod deploy ~9 min, merge→live ~13 min — all
far too long to watch live. [[deploy-speed-levers-audit-2026-07-30]]
