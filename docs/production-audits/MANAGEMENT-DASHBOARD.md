# Phoenix Workforce — Production Readiness Dashboard

## Overall Launch Status
Launch is possible only after specific fixes

Some modules are close to ready, but require specific fixes and verification before launch. Treat these as mandatory conditions.

## Module Readiness Summary
| Module | Current Stage | Score | Verdict | Critical Issues | High Issues | Blocks Launch? | Required Next Action |
|---|---|---:|---|---:|---:|---|---|
| Automated Payroll | FIX REQUIRED | 7.7 | CONDITIONAL GO | 0 | 4 | No | Rule on findings 1, 6-13, 21, 24, 25, 28 and 19. Cycle 2 established that they cannot be recovered by any means available - the audit document that named them was never saved. The decision owed is whether to close them on the record as permanently unrecoverable, or keep them open indefinitely. It is a decision, not a fix. |

## What the Scores Mean
- 9.0–10 = Ready / strong
- 8.0–8.9 = Almost ready
- 7.0–7.9 = Needs fixes before launch
- Below 7 = Not ready

## What the Verdicts Mean
- GO: Ready to launch with normal monitoring
- CONDITIONAL GO: Can launch only after specific fixes are completed and verified
- NO GO: Must not launch until major risks are fixed and verified

## Current Top Risks
| Risk | Affected Module | Business Impact | Required Action |
|---|---|---|---|
| Fourteen findings can never be accounted for | Automated Payroll | Nobody can say whether findings 1, 6-13, 21, 24, 25, 28 and 19 were fixed, dismissed, folded into another finding, or dropped. Cycle 2 confirmed the record of what they were is gone, so if any of them touched money, the defect may still be live and there is no description of it to look for. | Rule on them: close them on the record as permanently unrecoverable, or keep them open. Either way, write the decision down so a third cycle does not re-litigate it. |
| A guard that the application disarms is invisible to everyone who trusts it | Automated Payroll | Finding 56 was a trigger doing exactly its job while the one code path that mattered switched it off on every call. Anyone reading the schema would have concluded a closed month was protected. The same shape can exist anywhere a bypass flag was added for a legitimate cascade. | When a migration adds a bypass for a guard, the function that sets it must re-assert the rule itself. Audit the remaining set_config bypasses in the schema against that standard. |
| The primary checkout is not a valid audit surface | Automated Payroll | It was 14 commits stale at the start of cycle 2 and still held a file a merged ruling had deleted. An audit run there produces findings about code that does not ship, and fixes for problems nobody has. | Confirm the surface against origin/main before reading a line of code, in every future cycle. |

## Next Recommended Actions
- Automated Payroll: Rule on findings 1, 6-13, 21, 24, 25, 28 and 19. Cycle 2 established that they cannot be recovered by any means available - the audit document that named them was never saved. The decision owed is whether to close them on the record as permanently unrecoverable, or keep them open indefinitely. It is a decision, not a fix.

## What Each Module's Score And Verdict Actually Mean
### Automated Payroll
SCORE MEANING: 7.7 is not a quality rating of the payroll module. It is the share of the audit's findings this repository can account for - 43 of 56. It measures the RECORD, not the code. Read the change from 7.6 carefully: the record did NOT improve. Cycle 2 added one new finding (56), which is fully accounted for and fixed, so both halves of the fraction grew by one. The fourteen findings nobody can account for are exactly as unaccounted for as they were. Cycle 1 ran 10-12 September 2026 and numbered 55 findings: 39 fixed with evidence anyone can check, 2 (30 and 36) claimed closed by earlier work that is not named anywhere, 1 (finding 19) mentioned only in passing, and 13 - findings 1, 6 to 13, 21, 24, 25 and 28 - appearing nowhere at all. Cycle 2 ran on 12 September 2026 because those 13 could not be recovered, and re-examined the module empirically instead. It found one new High finding: the only payroll-batch delete path the application uses switched off all three of the database guards that exist to stop a closed month being deleted, and then ignored the status it had just read. Every batch in production was in the protected state - 3 approved, 5 locked, 896 salary records between them - so nothing was legitimately deletable and everything was deletable, behind a single browser confirm, with no PITR behind it. That is fixed and verified in production. Cycle 2 could not, and did not, recover the fourteen; that is now a decision for the owner rather than an open piece of work. The severity counts below are a floor, not a total: they record only what a merged pull request stated in words, plus finding 56.

