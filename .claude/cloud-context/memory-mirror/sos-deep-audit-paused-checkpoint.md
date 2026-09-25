---
name: sos-deep-audit-paused-checkpoint
description: "The 20-agent Source of Sales audit is PAUSED mid-verification; all 247 findings are salvaged to disk with a ready-to-run resume script"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8d5735d9-1340-4674-aeb1-0d842aeb1331
  modified: 2026-08-09T18:07:47.578Z
---

On 2026-08-09 a 20-agent audit of the whole Source of Sales hub (12 tools + 8 cross-cutting sweeps)
finished its finder phase and produced **247 unique findings**. The owner stopped it part-way through
adversarial verification to save usage. Resume was planned for the week of 2026-08-16.

Everything lives in
`C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\sos-audit-2026-08-09\`
— read `CHECKPOINT.md` there first. It holds the findings JSON, the deferred set, per-agent coverage
notes, and `resume-verify.js`.

**Why:** the finder phase is the expensive, irreplaceable part and it is complete. Re-running it would
burn the same usage again for the same answers.

**How to apply:**
- Resume with `Workflow({ scriptPath: ".../resume-verify.js", args: <parsed scope-…-calc.json> })`.
  **Never `resumeFromRunId`** — that is same-session only and run `wf_2a126511-113` is gone.
- The narrowed scope the owner asked for is mapping + normalization + calculations only
  (159 of the 247); the other 88 are parked in `deferred-findings.json`, not dropped.
- Findings are **unverified**. Early verification killed ~14% (10 of the first 71), so treat every
  one as a lead, not a fact, until it survives. Related: [[dont-trust-agent-findings-without-verification]].
- One finding IS already confirmed with production SQL and is not in the 159: July 2026 reads
  556,009.45 EGP differently on the CEO Command Center than on the SoS dashboard, because
  `source_of_sales_import_summaries` and `source_of_sales_fact_rollup` are written independently and
  nothing re-reconciles them after a row-level correction.

See also [[list-migrations-reports-ledger-not-reality]] and
[[repointing-a-block-area-leaves-crosswalk-and-directory-stale]] — several of the mapping findings are
deeper instances of that same stale-stamp family.
