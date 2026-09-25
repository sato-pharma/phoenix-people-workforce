---
name: continue-verifying-resumes-sos-audit
description: "\"continue verifying\" is the owner's trigger phrase to resume the paused Source of Sales audit from its checkpoint — never restart it"
metadata:
  type: feedback
---

When the owner says **"continue verifying"** (or continue the verification / continue the audit), that
is a standing instruction to resume the paused Source of Sales audit **from where it stopped** — never
to re-run the finder phase.

**Why:** the 20 finder agents completed on 2026-08-09 and produced 247 findings over 101+ files plus
live production forensics. That phase is the expensive, irreplaceable half. Re-running it burns the
same usage again for answers already sitting on disk. The owner stopped the run specifically because
of usage, so silently restarting would repeat the exact cost he was avoiding.

**How to apply:**
1. Read `C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\sos-audit-2026-08-09\CHECKPOINT.md`.
2. Load the scope file the owner asked for — default is
   `scope-mapping-normalization-ai.json` (58 findings: mapping, normalization, AI normalizer).
   Wider option is `scope-mapping-normalization-calc.json` (159). Everything else is in
   `deferred-findings.json` (88) — parked, not dropped.
3. Run `Workflow({ scriptPath: "<that folder>/resume-verify.js", args: <the parsed JSON object> })`.
4. **Never `resumeFromRunId`** — it is same-session only and run `wf_2a126511-113` is gone.
5. After a run finishes, write the survivors back into that folder as a NEW file (never overwrite the
   inputs) and update `CHECKPOINT.md` so the next resume starts from the new position.

The folder is locked: every file is READ-ONLY, a `DO-NOT-DELETE.md` marker sits inside, and a mirror
copy lives at `F:\Phoenix Workforce\_audit-vault-sos-2026-08-09`. Both are OUTSIDE the git work tree
so `git clean` and `repo:doctor --fix` cannot reach them — never move them inside the repo, and never
clean, prune, or overwrite them.

Related: [[sos-deep-audit-paused-checkpoint]], [[dont-foreground-watch-long-pipelines]].
