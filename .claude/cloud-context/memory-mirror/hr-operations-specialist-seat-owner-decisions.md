---
name: hr-operations-specialist-seat-owner-decisions
description: "owner 2026-10-20 — role key \"HR Administration\" shown \"HR Operations Specialist\" (built for Yasmeena, HR-009, moved BACK to HR Operations on 2026-10-21; Aya Tarek holds it since 2026-10-28) is salary-blind everywhere except HR Forms, which he opened to her whole on 2026-11-02 with the Hiring Documents grant (she sees and prints the salary there and cannot change it), reviews Daily & Weekly Reports in DAYS only; a manager's own visits COUNT in that manager's own row of her field report; \"HR Operations\" is shown \"HR Generalist\" and stays empty for a hire, its alerts falling to the Super Admin."
metadata:
  node_type: memory
  type: project
  originSessionId: 061d8c97-37ba-4e99-8b5d-a309001b06a0
  modified: 2026-10-27T22:09:29.491Z
---

🔴 **2026-11-02: THE EIGHT-PAPER LIMIT BELOW IS GONE** — owner: "OPEN IN HER ACCOUNT Contact the joiner, confirm papers and attendance time/ Receive the hiring papers/ OPEN HR FORMS FULL MODULE TO AYA". Current rule: `.claude/rules/hiring-documents.md`. Shipped as gawishtheit/phoenix-people-workforce#7, merged 2 Nov 18:20 Cairo on his word "merge 7 and 8 when green"; it is the old PR 6776 after the account move. She has not opened it yet (activity_events, read 3 Nov about 01:05 Cairo).

🔴 **2026-10-28: Aya Tarek (OF-0005, Office Coordinator) now HOLDS the `HR Administration` seat** — owner asked "add all modules in hr operations specialist account to the office coordinator account", then picked "Specialist seat, no salary" over Yasmeena's HR Operations seat. Four writes done (role, session_version 1→2, access profile SELF, both metadata blocks; she had no live sessions). The seat's alerts that fell to him while it was empty now reach her. Her `employees.job_title` stays "Office Coordinator".

🔴 **2026-10-21 (owner: "return to Yasmeena her original account and leave the new account seat as it is"): Yasmeena (HR-009) is BACK ON `HR Operations`** (shown HR Generalist) — login role, access profile, both auth-metadata blocks, session_version 10→11, her live sessions revoked. The `HR Administration` seat (HR Operations Specialist) is LEFT IN PLACE and now holds nobody: roles row, 3 CHECK constraints, 5 workflow actions and the resignation alert audience untouched. Her `employees.job_title` still reads "HR Operations Specialist" (set before 2026-10-20, unchanged). While she holds `HR Operations`, vacation notices, business cards and that seat's alerts reach her again, not him. Everything below describes the seat's design, not who sits in it.

Built 2026-10-20 (branch `codex/yasmeen-seat`, plan `~/.claude/plans/go-start-every-spicy-quiche.md`). His multiple-choice answers that day:

- Seat key `HR Administration`, title **HR Operations Specialist**; the old `HR Operations` seat is renamed on screen **HR Generalist** everywhere, access unchanged, empty until a future hire.
- She never sees a salary, allowance, insurance or tax amount, nor any EGP deduction — the one exception is the **contract renewal annex**. Bank name, account and payment mode stay visible.
- Papers she may print (8): renewal annex, non-renewal, resignation request, employee clearance, company clearance, handover record, **deemed resignation, mutual termination** (the last two added on his "Add both").
- Daily & Weekly Reports: every line confirm / reject / recommend edit with a reason, days only, he decides; weekly = field Sat–Thu, head office Sun–Thu; visits to date = month to date; covers everyone who visits.
- **A manager's own visits (phoenix_crm_manager_visits) COUNT in that manager's own row** of her field report (his pick from an example: "Show the 6 visits") — never credited to anyone else. Consistent with the locked rule that own visits count only in the manager's own report. See [[a-managers-own-visit-never-requires-gps-or-a-live-photo]].
- **Interview Calendar: she can VIEW it only** (his pick, 2026-10-20) — a Viewer like the CEO via `seesWholeInterviewCalendar`; ownership stays with the HR Operations seat (empty, so the Super Admin alone). Never re-propose making her its admin again.
- Arabic title for the empty HR Generalist seat: **أخصائي موارد بشرية** (his pick, confirmed); hers stays اخصائي موارد بشرية.
- **Bank details** (2026-10-20, his words "can change bank account but never a paymode"): she may change bank name/account; she NEVER changes payment mode — and payroll eligible is locked for her too (Claude's call, same reason: it decides whether a person is paid), and so is **employment status** (Claude's call: "inactive" turns payroll eligible off; resigned/terminated were already workflow-only). Save writes the stored values back; import blocks a row that changes any of the three.
- **Resignation Complete stays HIS** ("You press Complete", 2026-10-20): she marks for review and follows up; Complete is approval-level like Approve/Reject. She also may NOT re-date a resignation (the last working day moves leaver pay — past the 25th pays the month in full).
- **Office days the weekly review never lists** (absent/no punch, single punch, late with 0 policy days): "Mark them not carried" — listed with her answer, his decision kept for the record, "not carried to payroll", no EGP; the month-end Fingerprint connector stays the ONLY writer of fingerprint deductions.
- 🔴 Migration `20261020064831` (seat) goes to production only AFTER the new code serves: the workflow registry runs roles through parseRoleStrict, so old code skips the whole module and every leave/contract/resignation transition fails.
- Probation Day 30/60/75 emails → to him only. Vacation notices + business cards → the HR Generalist seat holder, him while empty; every other alert of that seat → him while empty.

**Why:** a tailored account so she does HR operations without payroll or salary; he keeps every decision.
**How to apply:** never widen her salary view beyond the annex; never move a decision to her; a manager's own visits in HR ops reports count in his own row only.
