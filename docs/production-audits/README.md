# Repo-Based Production Audit Tracking System

## What This Is
This folder is a simple, repository-based way to track production readiness for Phoenix Workforce.

It saves:
- Module audits
- Fix cycles
- Verification results
- Scores and launch verdicts
- A management-friendly dashboard

Everything is stored as files inside this GitHub repository. No external note-taking tools are required.

## Why This Helps Management and HR
This system is written so that a manager or HR leader can quickly understand:
- Which modules are ready
- Which modules are risky
- What blocks launch
- What needs to be fixed next
- Whether each module is GO / CONDITIONAL GO / NO GO

## What You Will Use
- The registry (data): `docs/production-audits/_registry/audit-registry.json`
- The dashboard (simple view): `docs/production-audits/MANAGEMENT-DASHBOARD.md`
- The templates (starting points): `docs/production-audits/_templates/`

## How To Add A Module Audit
1. Copy the template file:
   - `docs/production-audits/_templates/module-audit-template.md`
2. Save it as a real module audit file, for example:
   - `docs/production-audits/<module-slug>/audit-cycle-1.md`
3. Fill it in using simple business language for the manager summary, and detailed evidence in the rest of the file.
4. Update the registry entry in:
   - `docs/production-audits/_registry/audit-registry.json`
5. Regenerate the dashboard.

## How To Add A Fix Cycle
1. Copy:
   - `docs/production-audits/_templates/module-fix-template.md`
2. Save it as:
   - `docs/production-audits/<module-slug>/fix-cycle-1.md`
3. Update the registry to point to the latest fix file and to reflect the current stage.
4. Regenerate the dashboard.

## How To Add A Verification Cycle
1. Copy:
   - `docs/production-audits/_templates/module-verification-template.md`
2. Save it as:
   - `docs/production-audits/<module-slug>/verification-cycle-1.md`
3. Update the registry to point to the latest verification file and to reflect the current stage.
4. Regenerate the dashboard.

## How The Dashboard Updates
The dashboard is generated from the registry. After you update the registry:
- Run the validator to make sure the registry is correct
- Run the dashboard generator to update `MANAGEMENT-DASHBOARD.md`

## Commands
- Validate the registry:
  - `npm run audit:validate`
- Generate the management dashboard:
  - `npm run audit:dashboard`

## What The Scores Mean
- 9.0–10 = Ready / strong
- 8.0–8.9 = Almost ready
- 7.0–7.9 = Needs fixes before launch
- Below 7 = Not ready

## What The Verdicts Mean
- GO: Ready to launch with normal monitoring
- CONDITIONAL GO: Can launch only after specific fixes are completed and verified
- NO GO: Must not launch until major risks are fixed and verified
- NOT AUDITED: No formal audit evidence recorded yet

## Why No Notion Or External Tool Is Needed
- The files live with the code, so audits stay close to what they describe.
- Git history shows when decisions changed and why.
- Reviews can happen using normal pull requests.
- No API tokens, secrets, or external accounts are required.

## Example Registry Record (Copy/Paste Pattern)
This is a simplified shape of one record (the real file is JSON):

```json
{
  "moduleName": "Payroll — Expenses",
  "moduleSlug": "payroll-expenses",
  "auditCycle": 1,
  "currentStage": "AUDIT COMPLETED",
  "score": 8.4,
  "simpleAverageScore": 8.2,
  "weightedAverageScore": 8.6,
  "verdict": "CONDITIONAL GO",
  "criticalIssues": 0,
  "highIssues": 2,
  "mediumIssues": 3,
  "lowIssues": 4,
  "blocksLaunch": true,
  "requiredNextAction": "Fix access control in approval flow and verify with tests.",
  "managerSummary": "This module is close to ready, but approval access control needs fixing before launch.",
  "topBusinessRisks": [
    {
      "risk": "Incorrect approvals",
      "businessImpact": "Expenses could be approved by the wrong people.",
      "requiredAction": "Tighten access control and re-verify."
    }
  ],
  "latestAuditFile": "docs/production-audits/payroll-expenses/audit-cycle-1.md",
  "latestFixFile": null,
  "latestVerificationFile": null,
  "lastUpdated": "2026-05-31T00:00:00.000Z"
}
```

The example uses a module name as an illustration only. Do not copy scores for real modules unless you have real audit evidence.
