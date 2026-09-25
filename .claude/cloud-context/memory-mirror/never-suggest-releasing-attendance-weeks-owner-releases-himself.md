---
name: never-suggest-releasing-attendance-weeks-owner-releases-himself
description: "Never suggest releasing weekly attendance digest weeks — the owner releases what he wants himself; releasing is his decision, never a Next-step suggestion."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0d7236c0-9467-4c94-9e96-8abff9b22db7
  modified: 2026-09-22T20:03:52.102Z
---

Never suggest that the owner **release** weekly attendance digest weeks/employees — not in the reply body, not in the **Next step:** box, not as ghost text. He said (2026-09-22): "NEVER SUGGEST ME TO RELEASE, WHAT I WANT TO RELEASE WILL RELEASE FROM MYSELF."

**Why:** Releasing a flagged attendance week starts a real deduction path (unanswered → auto-settle to salary). Which employees to release, and when, is his own judgment call — like every approval, the decision is his click ([[never-approve-for-the-ceo]], [[b-10-is-the-owner-himself]]). Reporting that N employees sit at `awaiting_release` is fine as *state*; framing "release them" as his next action is not.

**How to apply:** Report the digest state plainly (who received, who is awaiting release, who is settled/pending, amounts, deadlines). Stop there. Do not put "release the remaining flagged employees" or any release verb in the Next-step quoted words. If nothing else genuinely needs him, quote a non-release, non-money, new informational action instead. The attendance digest feature lives in `src/lib/attendance/` (digest-service, digest-bridge); deductions only materialise after month-end via the Fingerprint connector + bridge.
