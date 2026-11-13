---
name: four-employees-are-never-company-insured
description: "Ahmed Farag, Rasha Sabry, Reham Mahmoud and Samaa Mosaad are NOT company-insured and never will be (owner, 2026-11-13) — never suggest insuring them"
metadata:
  node_type: memory
  type: project
  originSessionId: a64601b5-33aa-477a-b58e-713fdebee67b
  modified: 2026-11-13T15:50:11.708Z
---

Owner, 2026-11-13 (Cairo): "Ahmad Farag is not insured and will not be. Rasha Sabri is also like this. Riham and Sama Musad are also like this."

His reason: they are on a government assignment (تكليف). The government insures them, they bring him the papers, and the company does not insure them. This is about social insurance only.

Applied 2026-11-13 17:49 Cairo on his instruction ("remove their social insurance and insurance wage"): all four now have status no, wage empty, SI 0, and gross = base + tax. Change-log actor is `ops:uninsured-20261113`.

Not company-insured, permanently: Ahmed Farag (AI-0020), Rasha Sabry Khalifa (A-8), Reham Mahmoud Elwiy (OF-0004), Samaa Mosaad Said Khalil (A-3). Nahed Tarek Hattab (A-10, resigned) was the same (9 Nov secondment ruling). NOT Samaa AbdelRahman (AI-0014), who is a different person.

**Why:** a session read Ahmed Farag's insurance number and start date and told him to "mark him as insured". That was wrong.

**How to apply:** payroll files from `social_insurance_wage`, falling back to the stored `social_insurance`; the status alone files nothing (`.claude/rules/payroll.md`). An uninsured person's correct record is status `no`, wage EMPTY, social insurance 0, as Rasha's is. The Employee Master autofill refills the wage and SI whenever net salary is re-typed, whatever the status, so those two boxes must be cleared again after any salary edit. Never flag their empty wage, and never propose insuring them. Related: [[payroll-reads-the-insurance-wage-never-the-status]]
