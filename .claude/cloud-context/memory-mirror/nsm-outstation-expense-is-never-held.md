---
name: nsm-outstation-expense-is-never-held
description: "Owner rule 2026-08-28 — a National Sales Manager's outstation expense is never held for any reason; once submitted, once accepted. NSM only, not the three photo-waived roles."
metadata: 
  node_type: memory
  type: project
  originSessionId: bc34ce50-bd97-40f5-a61a-7ce5181e99c6
  modified: 2026-08-28T12:47:51.826Z
---

**A National Sales Manager's outstation expense request is NEVER held, for any reason.** Owner
rule, 2026-08-28, in his words: *"Don't hold the expenses of the national sales manager for any
reason. Once submitted, once accepted."* He emphasised the scope twice — **only** the national
sales manager, nobody else.

**What he was looking at.** Magdy El Senosey (`AI-0008`, NSM Anti Infective) had request **101**
(2026-08-26, EGP 935.87) sitting on `workload_gate_status = 'pending_workload'`. That hold could
never have cleared: the workload gate matches the AM/PM visit count out of the CRM, an NSM runs no
doctor list, so there is nothing to match. **Every NSM claim was one un-asked-for manual workload
entry away from ever being paid, with no error raised anywhere.**

**Why:** he is the top of a sales line and reports to the CEO; his claim has no manager below him to
confirm it and no field workload to prove. A control that cannot be satisfied is not a control, it
is a leak of somebody's money.

**How to apply:**
- The rule lives in `src/lib/outstation/nsm-no-hold.ts` and is **an allowlist of ONE role**. It is
  deliberately narrower than the photo waiver in `evidence-waiver.ts`, which waives PHOTOS for
  three roles (Product Manager, Group Product Manager, National Sales Manager). **Do not merge the
  two** — widening the photo waiver must never widen this.
- Three enforcement points: the gate (`expense-gate.ts`, above every other test), the submit-time
  hold reasons, and the workflow status (`accepted_by_system`, then released into payroll as the
  SYSTEM — the payroll write asserts a manual-approval permission the submitter does not hold).
- **The checks still RUN and still record what they saw** — only the hold is removed. Same shape as
  the owner's 2026-08-09 "the system flags, it never rejects" rule.
- **Every other role still waits for a human** (owner decision 2026-08-08). This is the single
  exception to it. A session tightening payroll controls must not "fix" it back.
- Pinned by `tests/outstation-nsm-no-hold.test.ts`, registered in `tests/run-tests.ts`. Shipped in
  [PR #2580](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2580).
- Only **two people** hold this role in production (Anti Infective and CNS) — see
  [[nsm-title-is-held-once-per-line-not-company-wide]].
- **The backlog was released 2026-08-28 — do NOT release it again.** All 8 stuck claims (45, 52,
  60, 67, 77, 83, 94, 101 — EGP 6,962.05; Amr Naguib `B-122` 3,957.95 and Magdy `AI-0008` 3,004.10)
  were accepted on the owner's "release them all" and pushed into `outstation_expenses` with
  `hr_approved = true`, none yet imported into a batch. Request 92 was already accepted before that.
  Done by calling `approveOutstationRequestForPayroll(id, systemAccessContext)` locally against
  production from the fix's worktree — request 101 needed the new gate, which was not yet deployed.
  The write is an **upsert on `trip_id`**, so a re-run would not duplicate the expense row, but it
  would rewrite `approval_reason` and log a second audit trail for a decision already made.
- **BOTH filing routes, not one — extended the same day (PR #2586).** The first build exempted only
  `submitOutstationRequest` and deliberately left `createManagerExpenseAsAdmin` waiting, reasoning
  that the queue is where an amount an admin typed gets confirmed. The owner overruled it in one
  line: *"yes do the admin created ones too."* His claim was instant when he filed it himself and
  queued when an admin filed it for him — the same money treated two ways for a reason that has
  nothing to do with him, and 3 of the 8 stuck claims had arrived by that route. **The allowlist
  never widened — still one role; what widened was the set of paths honouring it.**
  `tests/outstation-nsm-no-hold.test.ts` pins `isOutstationNoHoldRole(` at **exactly 2 call sites**,
  so a third filing path cannot quietly inherit the exemption. `submitMedicalRepSimpleExpenseRequest`
  still has no exception at all.
