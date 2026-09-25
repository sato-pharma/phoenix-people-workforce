---
name: deduction-rules-are-written-in-comments-implemented-half
description: "Every deduction policy question is already answered in the codebase — the recurring failure is a guard that states the rule in a comment and implements half of it"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd6c2994-f622-4563-b891-87464fa64cea
  modified: 2026-08-01T15:15:02.213Z
---

**Owner rule (2026-08-01): "don't leave anything without a rule — deep search the
codebase, you'll find answers to all your questions."** He was right. Every
policy question I was about to ask him was already written down. The recurring
defect is not a missing rule — it is a guard that **documents the rule in a
comment and implements only part of it**, then fails open.

**The authoritative answers, with where they live:**

| Question | Answer | Source |
| --- | --- | --- |
| Does a fingerprint punch cancel a CRM no-activity deduction? | **NO — it CORROBORATES it** ("corroborates a genuine no-activity day rather than a CRM logging gap") | `field-workforce-compliance/types.ts` ~L131-136 |
| Can fingerprint + CRM both deduct the same day? | **YES, two distinct breaches.** The cross-check is *"Informational only — never affects severity, status, or deduction candidates"* | same file |
| Does an approved excuse cancel an attendance deduction? | **YES** — *"Used to cancel an attendance deduction"* / `if (hasApprovedExcuse) return {action:"skip"}` | `attendance/approved-excuse-days.ts`, `attendance/digest-reconcile.ts` |
| Who is off on Saturday? | Everyone **except** Medical Rep / District Manager (those are Friday-only-off) | `field-workforce-compliance/weekend-policy.ts` |
| Employee with no CRM signal at all? | **Data-mapping gap — exclude, don't flag every workday** | `deductions/connectors/no-records-activity.ts` header |
| Who is field workforce? | Sales + Marketing (incl. **Product Manager, Group Product Manager**, Marketing Manager, Training Manager). **PMs DO field visits** (owner-confirmed) | `field-workforce-compliance/eligibility.ts` |
| Are field reps on fingerprint devices? | **NO** — device-mapped ≈ Head Office staff | `attendance-cross-check.ts` header |

**✅ ALL THREE MERGED 2026-08-01 as `baee0489` (#1584)** — verified present on
`main`. NOT deployed (prod is cron-driven) and NOT retroactive: the 119
candidates already in prod keep the old numbers until re-collected.

**Three half-implemented guards found and fixed (PR #1584):**
3. `derivePrivateCalendarExceptions` treats a CRM **Double** Visit as
   self-proving attendance ("no fingerprint needed") but only that feed was
   wired in. Field reps aren't on devices at all, and **86% of field work is
   solo**: 1,700 rep-days carrying **15,429 real logged visits** (101 employees)
   read as "No Activity Recorded". Added `field_visit` as a 6th coverage source
   — wired into **BOTH** load sites in `private-calendar/service.ts` (line ~449
   workspace + ~591 company-wide); fixing only one would have corrected the UI
   and left the deduction feed wrong.
1. `fingerprint-report.ts` fetched the approved-excuse map, computed
   `hasApprovedExcuse`, rendered it as a LABEL, and deducted anyway. Approved
   *exception* zeroed the charge; approved *excuse* did not. **1,666.66 EGP.**
2. The zero-signal guard tests `crm_id IS NULL` only — catching the unmapped
   employee, missing the mapped-but-never-used one. **53,161 EGP**: A-9 20 days
   /30,967.74 and A-8 (Rasha) 16 days/22,193.55, both with ZERO CRM rows all
   month while punching in 36 and 13 times. B-155 has 44 CRM rows ⇒ his 7 days
   are real and correctly kept.

**🔴 I was wrong twice by reasoning instead of reading**, and told the owner so:
I claimed B-155's 5,871 EGP was invalid because he punched in (it is VALID —
punches corroborate), and called the 13 fingerprint+CRM overlaps
double-deductions (they are by design). **Read the type/header comments before
declaring a deduction wrong.**

**Rasha Sabry (A-8) "special situation" = mapped crm_id (1185) but zero CRM
usage**, so the Tier-0 guard missed her and she was billed nearly the whole
month. Same shape as A-9. See [[deductions-module-god-mode]].
