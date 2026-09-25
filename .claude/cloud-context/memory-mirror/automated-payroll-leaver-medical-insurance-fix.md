---
name: automated-payroll-leaver-medical-insurance-fix
description: "Fixed leaver medical insurance silently never deducted when a resigned employee's whole settlement collapses into First Part with no Second Part left"
metadata: 
  node_type: memory
  type: project
  originSessionId: a18d5dc4-6334-443d-9a12-4265945f4a9c
  modified: 2026-07-26T04:41:00.583Z
---

**The bug (owner-reported 2026-07-26, same day as [[automated-payroll-resignation-crm-bug-fix]])**: `freezeFirstPart` in `src/lib/automated-payroll/split.ts` only ever subtracted medical insurance directly from First Part for ONE-PART employees. Two-part employees' medical insurance was always deferred to net against Second Part in Part 2. For a resigned (leaver) employee whose whole settlement collapses into First Part — no Second Part left at all (owner's examples: Amany Wasiem B-111, Eman Essam B-176) — there was nothing to net medical insurance against, so it fell into an "overpaid residual" meant to be recovered via carry-forward **next month**. A leaver has no next month — the deduction was silently never collected. Real case: Amany, medical_insurance=206 EGP, First Part read 4,064.52 instead of the correct 3,858.52.

**Owner's exact rule**: "لو الموظف هيقبض كله جزء أول ومالوش جزء تاني زي أماني وإيمان، لازم نديدكت (deduct) الـ medical insurance من الـ first part" — if a resigned employee gets everything in First Part with no Second Part, medical insurance must come out of First Part.

**Fix**: extended the EXISTING leaver shortfall-netting mechanism (built 2026-07-20 for CRM/vacation) to also include medical insurance for two-part leavers specifically. Netted against the leaver's own remaining Second Part first; any shortfall — including "no Second Part at all" — is pulled directly from First Part. One-part employees (already handled, unchanged) and continuing (non-leaver) two-part employees (medical stays deferred to a real future Second Part, unchanged) are explicitly covered by regression tests, so this doesn't touch anyone outside the leaver case.

**Verified against real production data** before shipping: ran the actual `freezeFirstPart`/`effectiveSalary` functions against Amany's real record — First Part corrects from 4,064.52 to 3,858.52, exactly the missing 206 EGP. Eman's medical_insurance is 0 on file, so her number is unaffected — she was just a correct example of the "collapses to First Part" *shape*, not a case with a live medical-insurance bug today.

**Shipped**: PR #1356, owner manually merged 2026-07-26 (commit `d4ad8c3b`), deployed to production as revision `phoenix-hr-00545-yog` (europe-west3, 100% traffic), zero `app_error_events` since promotion. Built in isolated worktree `F:\Phoenix Workforce\_wt-medical-insurance-leaver`, branch `codex/leaver-medical-insurance-first-part`, off latest `origin/main` (which already included PR #1355, the Resignations CRM tab).

**Pattern worth remembering**: this is the SECOND real bug this session traced to the same root shape — a leaver's settlement/deduction math implicitly assuming a real future Second Part exists to net against, when leavers routinely have none. Worth a mental checklist next time: any new leaver-related deduction must ask "what happens when this leaver's Second Part is already 0?"
