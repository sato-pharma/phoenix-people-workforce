# Production Readiness Closure System

Security, RLS, and auth hardening are intentionally excluded from this build-stage checklist unless a feature cannot work without them.

## Purpose

Phoenix Workforce should not keep revisiting the same finished function every time a new module is added.

The rule is:

```text
A module is not production-ready because the screen works.
A module is production-ready when its business rule is centralized, linked, tested, and documented.
```

## Definition Of Done

Every finished function or module must pass these gates before we call it closed.

| Gate | Required result |
| --- | --- |
| Workflow closed | The full create/update/approve/reject/exit/import/export flow is known and documented. |
| Source of truth closed | The module uses one canonical service or domain function for business logic. |
| Cross-module linkage closed | All modules that should hear the change are connected to the same source. |
| UI boundary closed | Components/pages display DTOs and do not own reusable business calculations. |
| Data ownership closed | Each important number has one owner and one meaning. |
| Regression tests closed | Core business rules have tests, especially rules that previously broke. |
| Failure behavior closed | Common bad inputs, missing data, duplicates, and partial states behave predictably. |
| Score updated | The module scorecard is updated after the work is complete. |

## Gap Format

For every module, gaps should be written in this format:

```text
Module:
Function/workflow:
Current score:
Target score:
Current behavior:
Expected production behavior:
Source of truth:
Linked modules affected:
Business risk:
Fix:
Tests required:
Closure status:
```

This keeps the work manageable and prevents vague fixes.

## Production Scores

Use this score meaning:

| Score | Meaning |
| --- | --- |
| 5/5 | Closed. Business logic is centralized, linked, tested, and safe to build on. |
| 4/5 | Strong. Mostly production-ready, but one gap remains. |
| 3/5 | Works, but logic/linkage is incomplete or duplicated. |
| 2/5 | Risky. Workflow is partial or business rules are not reliable. |
| 1/5 | Not production-ready. Needs redesign or major repair. |

## Phase Close-Out Report

After every phase, the final report must include:

1. Scope completed.
2. Files changed.
3. Business rules centralized.
4. Modules connected.
5. Gaps fixed.
6. Tests added or updated.
7. Verification results:
   - typecheck
   - tests
   - build when relevant
8. Old score to new score.
9. Remaining gaps, if any.
10. Next recommended phase/prompt.

## Module Closure Report

When a module reaches production-ready status, record:

```text
Module:
Closed workflows:
Canonical services:
Linked modules:
Protected business rules:
Regression tests:
Remaining non-blocking work:
Final score:
```

## Rule For New Features

Before adding a new feature to a module, check:

1. Is the old workflow closed?
2. Does a canonical service already exist?
3. Will the new feature reuse the existing source of truth?
4. Does the new feature change another module's numbers or workflow?
5. Which regression test should protect this change?

If the answer is unclear, close the old workflow first.

## Current Delivery Guardrail

Current branch and deployment state is documented in [Current Operating State](F:/Phoenix%20Workforce/phoenix-workforce/docs/current-operating-state.md).

New production work must follow this flow:

1. Work on `codex/work-from-production`, not `main`.
2. Validate with typecheck, tests, build, and audit when code or dependencies change.
3. Test the Vercel preview deployment.
4. Promote or merge only after approval.
5. Verify `https://phoenix-workforce.vercel.app` after production deployment.

Do not use old Vercel deployments for validation. The project should keep only production `main` and the `codex/work-from-production` preview active.

## Current Immediate Closure Target

Phase 1 should close:

```text
Workforce Lifecycle + Sales Seat Continuity
```

This means:

- manual employee add
- bulk employee upload
- accepted offer approval
- resignation
- termination
- probation termination
- vacancy opening/closing
- organogram continuity
- payroll eligibility continuity
- sales territory/seat continuity
- command center/data health structure totals

This phase is not complete until the employee lifecycle can be changed from every source and the same business result appears everywhere it should.
