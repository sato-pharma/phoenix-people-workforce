---
name: harden-check
description: Classify the current diff against AGENTS.md's Validation Matrix, run the matching pnpm validation scripts, flag Role-Based Testing requirements for permission-sensitive changes, and produce a report in AGENTS.md's Reporting format. User-invoked only via /harden-check, meant to run right before a commit, push, PR, migration, or deploy.
disable-model-invocation: true
---

# Harden Check

Validates the current diff the way this repo's `AGENTS.md` already requires, using
its `package.json` scripts instead of an ad hoc filtered command typed out by hand.
This skill deliberately does not copy AGENTS.md's Validation Matrix table or
Role-Based Testing role lists — it re-reads both sections live, every run, so it
can't silently go stale if AGENTS.md changes. Treat AGENTS.md as the authoritative
source for row definitions and role lists; this file only bridges them to concrete
commands and a report shape.

## 1. Gather the diff

```bash
git status
git branch --show-current
git diff
git diff --cached
git fetch origin main --quiet 2>/dev/null
git diff origin/main...HEAD 2>/dev/null || git diff main...HEAD
```

"The current diff" is the union of uncommitted changes (working tree + staged) and
any commits already made on this branch that aren't yet in the base branch — a user
running this right before opening a PR has usually already committed some of the
work. If all of the above come back empty, say so and stop; there is nothing to
validate.

## 2. Classify against AGENTS.md's Validation Matrix

Read the live `## Validation Matrix` table in `AGENTS.md` (repo root) — don't rely
on memory or a paraphrase, it may have been edited since this skill was written.
Map each changed file to a row by path/content, for example:

- `docs/**`, `*.md`, `AGENTS.md`, `CLAUDE.md` → documentation/instructions only
- `supabase/migrations/**`, other `supabase/*.sql` → DB migration/view/function/RPC/grant/policy
- `src/lib/auth/**`, `src/lib/payroll/**`, `src/lib/sales/**`, resignations/probation/contracts/offers/vacation-leave domains, the permission matrix, or executive-reporting dashboards → auth/RLS/payroll/HR-lifecycle/sales/permissions/executive-reporting
- `app/api/**/route.ts`, `middleware.ts`, `next.config.ts`, deployment workflows, env config → shared runtime/API route/server component/env/deployment behavior
- `app/**` pages, `src/components/**` → UI workflow
- everything else under `src/**/*.ts(x)` not covered above → narrow TypeScript/JavaScript change

A single diff commonly matches more than one row (a migration that also touches
payroll RLS, say). Apply the union of every matched row's validation, and treat the
highest-risk matched row as controlling for the report and for step 4 below.

## 3. Run the matching scripts

Prefer the named `package.json` scripts over improvised commands — AGENTS.md is
explicit that repository scripts come before ad hoc ones.

| Matched row | Run |
| --- | --- |
| Documentation/instructions only | none — review the diff, formatting, links, and secret exposure by hand |
| Narrow TypeScript/JavaScript change | `pnpm run lint`, `pnpm run typecheck` (`pnpm run check:edit` is just the typecheck half, for a faster loop mid-edit), `pnpm run test` |
| UI workflow | same as narrow TS/JS, plus browser verification at desktop and mobile sizes (`docs/editing-guide.md`) |
| Shared runtime / API route / server component / env / deployment behavior | `pnpm run check:harden` (equivalently `pnpm run ci`) |
| DB migration / view / function / RPC / grant / policy | `pnpm run check:migrations`, plus manual SQL/schema/security review and target-project confirmation — do not apply the migration yourself, that needs its own explicit approval per AGENTS.md |
| Auth/RLS/payroll/HR-lifecycle/sales/permissions/executive-reporting | `pnpm run check:harden`, plus the role-based-testing reminder in step 4 and an explicit risk callout in the report |

If the union of matched rows reaches "shared runtime" or higher, just run
`pnpm run check:harden` once — it's a superset (`check:routes` + `check:migrations`
+ `check:no-stale-domains` + `lint` + `next typegen` + `typecheck` + `test` +
`build`) and already covers every narrower row's scripts. Only reach for
`pnpm run check:edit` (typecheck-only) when the whole diff is confined to the two
lowest rows and the user is mid-edit rather than about to commit/push/open a
PR/migrate/deploy.

`pnpm exec playwright test` (e2e) is available but isn't part of `check:harden` —
call it out as optional/manual for UI-workflow changes rather than running it
automatically; it needs a live app and can be slow.

## 4. Permission-sensitive changes: role-based testing

If step 2 matched the auth/RLS/payroll/HR-lifecycle/sales/permissions/
executive-reporting row for any file, re-read the live `## Role-Based Testing`
section of `AGENTS.md` and:

1. State which domain(s) apply (Sales / Coaching / HR workflows) based on the files touched.
2. Quote that section's matching minimum role set verbatim.
3. Ask the user directly whether that manual/browser role testing — including denial
   paths — has actually been done. Don't infer or assume it from code inspection:
   AGENTS.md says plainly, "Do not claim role safety from code inspection alone
   when practical role testing is available."
4. Carry their answer (done / not done / partial) into the report's risk section —
   don't drop it silently.

## 5. Report

Close with a report shaped exactly like AGENTS.md's `## Reporting` section:

- What changed and why.
- Validation results, with any pre-existing failures explicitly separated from
  failures introduced by this diff (if it's ambiguous whether a failure predates
  the change, check it against the base branch rather than guessing).
- Risk and staging/production impact, including the step 4 answer if it applies.
- Actions completed automatically (which scripts ran, pass/fail).
- Actions still requiring approval or unavoidable manual work (migration apply,
  staging verification, browser role testing, e2e, etc.).
- An explicit statement of anything not tested, not deployed, or not verified.

Keep it proportional to the change, per AGENTS.md: "Do not force a large template
onto a small change." A docs-only diff earns a couple of sentences, not the full
template.

## Notes

- This skill only classifies and validates — it never applies migrations, commits,
  pushes, merges, or deploys. Delivery actions still follow AGENTS.md's Execution
  And Approval Matrix.
- If `node_modules` isn't present in this worktree, say so before a script fails
  opaquely for that reason.
