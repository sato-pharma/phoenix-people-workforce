# Branch Restructure Audit - 2026-05-24

## Purpose

This document records the GitHub and Vercel branch cleanup performed on 2026-05-24 for the Phoenix Workforce repository.

The goals are:
- preserve all important work before cleanup
- keep `main` stable until QA signoff
- define one clear QA branch for team testing
- reduce stale branch and preview noise
- standardize future branch naming by module/domain

## Protected Branches

These branches are protected from cleanup in this pass:

- `main`
- `integration/latest-features-20260523`
- `release/qa-2026-05-24`
- `safety/local-snapshot-2026-05-24`
- `codex/readiness-preview-20260522-215937`
- `codex/github-audit-remediation`
- `codex/mobile-expense-submit-polish`
- `codex/fix-typescript-type-errors-in-pages`
- `codex/fix-database-error-during-login`
- `claude/fix-typescript-errors-klXf0`
- `dependabot/npm_and_yarn/next-16.2.6`
- `dependabot/npm_and_yarn/ws-8.20.1`
- `dependabot/npm_and_yarn/qs-6.15.2`

## Team QA Branch

The branch used for team QA after this cleanup is:

- `release/qa-2026-05-24`

Rules:
- `main` does not receive this integration bundle until QA signoff is complete.
- Vercel preview and branch-based testing should use `release/qa-2026-05-24`.
- `integration/latest-features-20260523` remains the source integration branch until promotion is complete.

## Archive Namespace

Branches archived in this cleanup are preserved under tag refs using this namespace:

- `archive/pre-cleanup/local/<branch-name>`
- `archive/pre-cleanup/remote/<branch-name>`

This preserves old heads without keeping them as active GitHub branches or Vercel preview sources.

## Archived and Deleted Local Branches

The following local branches are archived to tags and then deleted:

- `11may`
- `12maybad`
- `audit`
- `backup-before-return-20260523`
- `backup-before-rollback`
- `checkpoint-main-20260522-1830`
- `claude/admiring-agnesi-7e718b`
- `claude/admiring-hellman-b1ab0a`
- `claude/brave-snyder-ce8ddd`
- `claude/busy-swartz-80f6ac`
- `claude/competent-thompson-346d29`
- `claude/cool-banach-1f009d`
- `claude/gracious-curran-3d5cc6`
- `claude/happy-benz-3a83e4`
- `claude/heuristic-hellman-8fe4fc`
- `claude/infallible-banach-35681c`
- `claude/modest-rhodes-f865b9`
- `claude/nervous-noyce-b38601`
- `claude/nifty-meninsky-6387bd`
- `claude/nostalgic-torvalds-4120b6`
- `claude/silly-gates-0fd623`
- `claude/suspicious-wozniak-69fcdf`
- `claude/sweet-liskov-cea3a5`
- `claude/tender-banach-7965ad`
- `claude/wizardly-kowalevski-297c02`
- `codex-github-audit-remediation`
- `codex/2`
- `codex/audit-data-and-system`
- `codex/copy`
- `codex/marketing-request`
- `codex/payslip-incentive-privacy`
- `codex/readiness-safety-20260522-215937`
- `codex/reconcile-main-local-baseline-20260522`
- `codex/spark`
- `feature/outstation-expense-policy`
- `feature/workforce-sales-classification`
- `integration/latest-features-20260523-copy`
- `phoenix-plan-b`

## Archived and Deleted Remote Branches

The following remote branches are archived to tags and then deleted because they are stale and not tied to active PRs:

- `claude/mobile-friendly-employee-portal-AxTZ2`
- `integration/latest-features-20260523-copy`
- `v0/phoenix-key-cards-fac298ea`

## Future Branch Model

Use short-lived branches from fresh `main`.

Examples:
- `feature/auth/<task>`
- `feature/employees/<task>`
- `feature/employee-portal/<task>`
- `feature/payroll/<task>`
- `feature/outstation/<task>`
- `feature/attendance/<task>`
- `feature/vacation/<task>`
- `feature/notifications/<task>`
- `feature/reports/<task>`
- `feature/sales/<task>`
- `feature/pending-approvals/<task>`
- `feature/offers/<task>`
- `feature/contracts/<task>`
- `feature/admin/<task>`
- `fix/<module>/<task>`
- `hotfix/<module>/<task>`

Rules:
- every task starts from fresh `main`
- one task per branch
- merge after review and testing
- delete branch after merge
- for cross-cutting work, use `feature/platform/<task>`

## Vercel Policy

- active previews should remain for `main`, `release/qa-2026-05-24`, and active PR branches only
- deleted stale branches should no longer be used as preview sources
- archive tags are for preservation only and should not be treated as deployable branches
