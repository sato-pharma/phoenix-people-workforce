# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

**[AGENTS.md](AGENTS.md) is the source of truth for operating rules** — branching, approval,
validation, worktrees, deployment, and data safety. This file stays deliberately thin: daily
commands, the two rules worth loading on every turn, and the protected-file gate. Everything else
lives in `docs/` and is read on demand.

@AGENTS.md

## Commands

All commands run from the repo root.

| Task | Command |
| --- | --- |
| Dev server (Turbopack) | `pnpm run dev` |
| Production build | `pnpm run build` |
| Lint | `pnpm run lint` |
| Typecheck | `pnpm run typecheck` |
| Unit/integration tests | `pnpm run test` |
| Fast editing gate (typecheck only) | `pnpm run check:edit` |
| Full hardening gate (lint + typecheck + test + build) | `pnpm run check:harden` |
| CI gate (same as harden) | `pnpm run ci` |

**Validate once per task, not once per step.** Finish the work first — no lint, typecheck, test, or
build between edits. Then run `check:harden` once, immediately before you push (and again before a
migration or a production deploy). Local commits on a feature branch do not each need it: CI re-runs
the same gate on the PR and blocks a red merge. `check:edit` is an optional fast typecheck mid-task,
not a per-edit ritual.

## The two rules that apply to every change

- **Domain-first.** Business logic lives in `src/lib/<domain>/`. Pages and components **call domain
  services**; they must not re-implement payroll, leave, expense, outstation, HR, or sales rules
  inline. When changing behavior, start in `src/lib/<domain>/`.
- **Server-side access control is the security boundary.** `system-navigation.ts` hiding a link is
  UX only. Always enforce with `assertPermission(ctx, resource, action)` in the route handler,
  before any mutation.

## Global edit points (don't hunt)

| Change | File |
| --- | --- |
| Brand, URLs, email defaults | `src/config/system-settings.ts` |
| Sidebar, nav, role routing | `src/config/system-navigation.ts` |
| Design tokens | `src/styles/tokens.css` + `app/globals.css` |
| Shared UI primitives | `src/components/ui/` |

## Where the detail lives

| Topic | Doc |
| --- | --- |
| Layout, auth trio, API route convention, workflows, cron, conventions, env, tests | [docs/architecture.md](docs/architecture.md) |
| Full edit-point table and editing policy | [docs/editing-guide.md](docs/editing-guide.md) |
| Migration safety harness, RLS, role alignment | [docs/security/](docs/security/) |
| Deploy triggers and verification | [docs/deployment.md](docs/deployment.md) · [docs/observability.md](docs/observability.md) |
| Test wiring — a test not registered in `tests/run-tests.ts` never runs | [docs/testing.md](docs/testing.md) |

## Protected Files — OWNER APPROVAL REQUIRED

These three files are **permanently locked** by the owner. No AI session, developer, or automated
tool may read-then-edit, refactor, rename constants, adjust formulas, or change any value inside
them without the owner explicitly approving that specific change in the active conversation first.

| File | What it protects |
| --- | --- |
| `src/lib/incentives/scheme-2026.ts` | 2026 incentive payout curve, achievement thresholds, semester target formula |
| `src/lib/payroll/policy.ts` | `BASIC_SALARY_RATE` (70%), and all salary derivation formulas (base → basic → net → gross) |
| `src/components/employee-portal/identity-card.tsx` | Employee portal identity banner — must always use `PhoenixSignatureCard`; do NOT swap it for another component |

**If any request would touch one of these files** (fix, refactor, rename, extend, delete): STOP. Show
the owner the exact change you intend to make and why it is necessary, and continue only after the
owner approves that specific change in the conversation.

**This lock is now behavioral, not mechanical.** `.claude/settings.json` still lists these paths
under `permissions.ask`, but the owner set `permissions.defaultMode: "bypassPermissions"` in
user-level settings on 2026-08-01, so **no approval prompt fires for them any more**. Nothing but
the agent's own compliance stops an edit. Treat the absence of a prompt as silence, never as
approval.

A shared unlock passphrase used to live in this section. It was removed on 2026-07-31 because it sat
in a committed file — anyone who could read the repo could read the phrase and "unlock" the file, so
it authenticated nobody. **Do not reintroduce a passphrase here.** Approval belongs in the
conversation, not in version control.
