---
name: system-flags-expenses-never-rejects
description: "Owner rule 2026-08-09 — the system must never auto-reject an outstation expense; every failed check flags it for the Super Admin, who decides."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d3d7ff0c-7077-426c-bc7c-4f0b250fec8d
  modified: 2026-08-09T08:28:54.402Z
---

**The system FLAGS an expense, it never REJECTS one.** Owner rule, stated 2026-08-09:
*"do not reject any expense you flag to admin and he decide."*

Every automated check in `submitOutstationRequest` still runs and still records its reason — but a
failure now HOLDS the claim as `submitted` in the pending approvals queue carrying that reason.
`rejected_by_system` is no longer reachable from the submit path; only a human rejects, as
`rejected_by_admin`. The submit-time rejection email is gone with it.

**Why:** every one of these checks reads a signal that can be MISSING rather than false — an
unwritten CRM record, an unmeasured distance, an unresolved governorate, a ticket an offline
capture could not carry. The system cannot tell "this is wrong" from "I could not see it yet", so
it must not be the one to refuse a person's money. It was set right after the double-visit rule
auto-rejected four genuine same-day claims worth 2,018.60 EGP (see
[[dv-evidence-window-same-day-submits]]), one of which — Sally Saied's — had 6 real double-visits
land in the CRM hours after she submitted.

**How to apply:** never reintroduce an automatic rejection into an expense submit path. When a new
rule is added, wire its reason into `reviewHoldReasons`, never into a rejection branch. The
opposite failure matters just as much: a rule that is neither enforced nor surfaced has been
*deleted*, not relaxed — the reason must still reach the approver. `tests/outstation-decision.test.ts`
pins both halves against the submit slice. The pure engine in `decision.ts` still CLASSIFIES a
breach as `rejected_by_system`; that is the analysis, and only the live path was changed.
