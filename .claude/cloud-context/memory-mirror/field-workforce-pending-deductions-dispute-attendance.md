---
name: field-workforce-pending-deductions-dispute-attendance
description: "🔴 STILL LIVE 2026-09-04 — July 2026 no-activity deductions remain undecided: 484 candidates across 62 employees, every one Pending, nothing ever published. Do NOT check field_workforce_compliance_decisions, which is now EMPTY and so reads as resolved — the pipeline moved to deductions_candidates + deductions_decisions"
metadata: 
  node_type: memory
  type: project
  originSessionId: c8217a8f-ead4-4534-8079-481b0e017f4f
  modified: 2026-08-01T10:03:11.865Z
---

Found 2026-08-01 while clearing the 2026-07-22 clarifications. The **FIELD_WORKFORCE** deduction
pipeline (separate from the Private Calendar / MANUAL_HR one) holds `no_activity` candidates for
`month_key = 2026-07`, all created **2026-08-01 08:50 UTC**, all with **`decision_status = null`**
— undecided, nothing pushed to payroll yet.

**8 employees have 60 claimed no-activity days that fall on days they have fingerprint punches:**

| Employee | Days claimed | Days with a punch |
| --- | --- | --- |
| a-9 Hossam Mohamed Reda AboElftouh | 20 | **16** |
| a-12 Ali Moh Ali | 13 | **10** |
| a-10 Nahed Tarek Hassan Omar Hattab | 13 | **8** |
| b-122 Amr Naguib | 9 | **8** |
| b-155 Ahmed Sharaf | 7 | **7 (every single one)** |
| a-8 Rasha Sabry | 16 | **6** |
| a-7 Ahmed ElKawas | 10 | **4** |
| b-117 Sameh Shabaan El Hoseiny | 2 | 1 (double visit) |

Largest undisputed claims are also worth eyeballing: b-156 Sara Samir **24 days**, ai-0003 Soad
Atef **21**, ai-0001 Momen **15**, ai-0002 Ahmed Nabil **15** — near-total-month deductions.

**✅ VERIFIED 2026-08-01 — this is a DESIGN GAP, not a code defect.** The FWC no-activity
recommendation is built purely from CRM timeline cells (`cell.countedAsNoActivityCandidate`,
`recommendations.ts:490-496`); grepping that file for `crossCheck|punch_no_visits|visits_no_punch`
returns **zero matches**. Fingerprint attendance is never consulted when generating a payroll
deduction recommendation. So the days are "correct" by the module's own rule and factually
contestable at the same time.

**The sharp part:** the contradiction signal already exists and is already computed —
`computeAttendanceCrossCheck` (`attendance-cross-check.ts:178`) emits **`punch_no_visits`** for
exactly this case (`cell.status === "N" && punched`). It feeds the preview only; nothing wires it
into the deduction recommendation. Closing that gap is a small code change, not a data fix.

**Status: all 54 FWC July no-activity candidates (259 days total) are `:pending` drafts** — none is
an `Approved for Payroll Deduction Report` decision, and `decision_status` is null on every one.
Nobody has approved anything; no money is at risk today. The risk is a bulk approval in the
deductions-governance UI.

Caveat kept for calibration: earlier in the same session I wrongly called 77 clarifications false by
assuming solo CRM visits counted as coverage — they do not. Check the module's own coverage rule
before calling anything false. See [[prove-it-fails-verify-which-assertion-fired]].

**How to apply:** before any FIELD_WORKFORCE approval for 2026-07, cross-check each claimed date
against `attendance_raw_punches` (Africa/Cairo date) and `ireports360_visits_effective`
(double_hr_id not null). Related: [[no-activity-report-cross-employee-suppression-bug]].

## 2026-09-04 — still live, five times bigger, and the table named above is now EMPTY

**`public.field_workforce_compliance_decisions` holds 0 rows.** The FWC pipeline was folded into
the unified deductions model, so the check this memory prescribed now answers *nothing pending* for
a month that has 484 pending items. **An empty table is the most dangerous possible answer**: it
looks exactly like the risk having been resolved.

Where it lives now — `public.deductions_candidates` joined to `public.deductions_decisions`:

| | recorded 2026-08-01 | live 2026-09-04 |
| --- | --- | --- |
| July no-activity candidates | 54 | **484** |
| employees | (8 disputed of them) | **62** |
| decision status | `null` on every one | **`Pending` on every one** |
| ever published | no | **no — `deductions_publications` is EMPTY** |

The grain changed too: it is now **one candidate per day** (484 candidates = 484 days), not one per
employee-recommendation carrying a `days_count`. A sweep that sums `days_count` across candidates
will double-count against the old shape.

**What has NOT changed:** no no-activity candidate for July is approved, and no publication exists
at all, so **no money has moved**. 123 July candidates *are* `Approved for Payroll` — all in other
categories (`crm`, `fingerprint`, `other`, `unpaid_vacation`), none in `no_records_activity`.
July's full candidate set is 1,664 across five categories; August has 226.

**The design gap recorded above is unverified as of today** — the cross-check finding
(`punch_no_visits` computed but never wired into the recommendation) was measured against code that
has since been reorganised, and the per-employee dispute table above is from the old 8-row shape.
**Re-derive the disputed days before quoting any of them to the owner.** The standing rule is
unchanged and is what matters: the system FLAGS, it never auto-rejects, and a deductions month is
never auto-published.
