---
name: hr-operations-specialist-seat-owner-decisions
description: "owner 2026-10-20 — role key \"HR Administration\" shown \"HR Operations Specialist\" (Yasmeena, HR-009) is salary-blind everywhere except the renewal annex, prints 8 papers, reviews Daily & Weekly Reports in DAYS only; a manager's own visits COUNT in that manager's own row of her field report; \"HR Operations\" is shown \"HR Generalist\" and stays empty for a hire, its alerts falling to the Super Admin."
metadata:
  node_type: memory
  type: project
  originSessionId: 061d8c97-37ba-4e99-8b5d-a309001b06a0
  modified: 2026-10-20T05:58:04.642Z
---

Built 2026-10-20 (branch `codex/yasmeen-seat`, plan `~/.claude/plans/go-start-every-spicy-quiche.md`). His multiple-choice answers that day:

- Seat key `HR Administration`, title **HR Operations Specialist**; the old `HR Operations` seat is renamed on screen **HR Generalist** everywhere, access unchanged, empty until a future hire.
- She never sees a salary, allowance, insurance or tax amount, nor any EGP deduction — the one exception is the **contract renewal annex**. Bank name, account and payment mode stay visible.
- Papers she may print (8): renewal annex, non-renewal, resignation request, employee clearance, company clearance, handover record, **deemed resignation, mutual termination** (the last two added on his "Add both").
- Daily & Weekly Reports: every line confirm / reject / recommend edit with a reason, days only, he decides; weekly = field Sat–Thu, head office Sun–Thu; visits to date = month to date; covers everyone who visits.
- **A manager's own visits (phoenix_crm_manager_visits) COUNT in that manager's own row** of her field report (his pick from an example: "Show the 6 visits") — never credited to anyone else. Consistent with the locked rule that own visits count only in the manager's own report. See [[a-managers-own-visit-never-requires-gps-or-a-live-photo]].
- **Interview Calendar: she can VIEW it only** (his pick, 2026-10-20) — a Viewer like the CEO via `seesWholeInterviewCalendar`; ownership stays with the HR Operations seat (empty, so the Super Admin alone). Never re-propose making her its admin again.
- Arabic title for the empty HR Generalist seat: **أخصائي موارد بشرية** (his pick, confirmed); hers stays اخصائي موارد بشرية.
- **Bank details** (2026-10-20, his words "can change bank account but never a paymode"): she may change bank name/account; she NEVER changes payment mode — and payroll eligible is locked for her too (Claude's call, same reason: it decides whether a person is paid).
- **Resignation Complete stays HIS** ("You press Complete", 2026-10-20): she marks for review and follows up; Complete is approval-level like Approve/Reject. She also may NOT re-date a resignation (the last working day moves leaver pay — past the 25th pays the month in full).
- **Office days the weekly review never lists** (absent/no punch, single punch, late with 0 policy days): "Mark them not carried" — listed with her answer, his decision kept for the record, "not carried to payroll", no EGP; the month-end Fingerprint connector stays the ONLY writer of fingerprint deductions.
- 🔴 Migration `20261020064831` (seat) goes to production only AFTER the new code serves: the workflow registry runs roles through parseRoleStrict, so old code skips the whole module and every leave/contract/resignation transition fails.
- Probation Day 30/60/75 emails → to him only. Vacation notices + business cards → the HR Generalist seat holder, him while empty; every other alert of that seat → him while empty.

**Why:** a tailored account so she does HR operations without payroll or salary; he keeps every decision.
**How to apply:** never widen her salary view beyond the annex; never move a decision to her; a manager's own visits in HR ops reports count in his own row only.
