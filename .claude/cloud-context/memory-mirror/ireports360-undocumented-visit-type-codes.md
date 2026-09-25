---
name: ireports360-undocumented-visit-type-codes
description: "iReports360 sends 7 visit-type codes its API doc never defines; the labels were ALREADY owner-confirmed 2026-07-14 and are now shared repo-wide (#2251) — only the payroll \"counts as\" question is still open"
metadata:
  type: project
---

The vendor's API doc defines exactly **9** visit-type codes — `0, -1, -2, -4, -8, -9, -11, -12, -15`.
Production receives **7 more it never documented**, and for every one the `visitTypeDescription` the
vendor sends is the literal string **`"Unknown"`** — 2,965 of 122,814 visits (measured 2026-08-21).

| code | visits | reps | what the reps typed | resolved label |
| --- | --- | --- | --- | --- |
| `-5` | 1,633 | 201 | Eid al-Fitr / Sham El-Nessim / Sinai Liberation — **`ampm` empty on all 1,633** | Vacations & Leaves |
| `-30` | 868 | 31 | real visit notes naming doctors, pharmacies, products | Pharmacy Visit / Regular *(by comment)* |
| `-20` | 171 | 21 | "Admin work" | Admin Work |
| `-7` | 148 | 55 | "Sales day", also "اجازه" | *by comment* — Health Day / Leaves / Meetings / Admin |
| `-19` | 91 | 19 | "Meeting with my team", "Weekly meeting" | Meetings |
| `-21` | 28 | 12 | "BRM CAIRO", "Business review in the office" | Business Review (BRM) |
| `-6` | 26 | 17 | "Casual Leave", "Morning Excuse" | Vacations & Leaves |

🔴 **CORRECTION — the earlier version of this note was wrong, and cost a re-investigation.** It said
the labels were unknown and an XLSX was "awaiting the owner". They were **not** unknown: the owner
confirmed all 7 on **2026-07-14 (PR #1061)** by the same method — reading hundreds of real `comment`
rows — and the answers had been live in `classifyVisit` ever since. **Before asking the owner what a
CRM code means, grep the repo for the code first.** The knowledge was simply siloed: it lived in
`employee-360/service.ts`, so Employee 360 said "Admin Work" while the CRM master, the employee
portal, the NSM board and SFE analytics all said "Unknown" for the same row, and three rival label
maps disagreed.

**Now shared.** #2251 moved the classifier to **`src/lib/crm/visit-types.ts`** (`classifyVisit` +
`resolveVisitTypeLabel`); `employee-360/service.ts` re-exports it unchanged. The vendor's own
description still wins wherever it says something real — this only fills the `"Unknown"` gap.

🔴 **NEVER write a resolved label back into `ireports360_visits.visit_type_description`.** The CRM
master's vacations dataset selects with `.ilike("visit_type_description", "%vacation%")`, so storing
`"Vacations & Leaves"` would silently pull all 1,659 `-5`/`-6` rows into Vacations. This is why the
ingest+backfill shape that was correct for `ampm` (#2247) is **wrong** here — labels are display-only.
A test in `tests/crm-visit-type-labels.test.ts` pins that consequence.

**SETTLED 2026-08-21 — all 7 count as WORKING time.** The owner ruled that `-5` (Public Holiday) and
`-6` (Casual Leave) are working days; the other five were never in question. All 7 map to **`"CP"`** in
`VISIT_TYPE_TO_STATUS` (`field-workforce-compliance/ireports360-source.ts`) and its lockstep copy in
`automated-payroll/recommend.ts`. `-5`/`-6` used to rely on the `?? "CP"` default; #2253 made them
explicit and break-verified them. **`-4` is the ONLY genuine leave type.** Full rule and why it costs
real salary: [[public-holiday-and-casual-leave-are-working-days]].

**Why:** the labels are a vendor gap Phoenix already closed; the payroll meaning is a business rule
only the owner can set.

**How to apply:** add new codes to `src/lib/crm/visit-types.ts` only. Related:
[[ireports360-dead-columns-are-hidden-not-deleted]].

Settled the same night, do NOT re-investigate: `ampm` casing is normalized at ingest (`normalizeAmpm`
in `crm/sync.ts`, #2247, live) and the 97 mis-cased rows were backfilled; `visit_date_time` is a
100%-midnight placeholder the code already refuses to use. Correction to the old note: the description
does **not** feed the half-day duration maths — that keys on `ampm`. It feeds vacations-dataset
membership via the ilike above.
