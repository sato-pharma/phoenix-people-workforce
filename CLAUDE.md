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
| Full hardening gate (5 domain/DB checks + lint + typegen + typecheck + test + build) | `pnpm run check:harden` |
| CI gate (same as harden) | `pnpm run ci` |

**Validate ONLY when the owner says so. Never on your own judgement.**

No lint, no typecheck, no tests, no build until he says the work is done. Not between edits, not
"once per task", not because a change feels finished — **he decides when the work is finished, not
you.** Replaced the old "validate once per task" wording on 2026-08-10 at his instruction: it still
left the agent deciding where a task ended, so the gate kept firing while he was mid-iteration.

He iterates in long sessions and often changes the same file many times. Re-validating work that is
about to change again proves nothing and costs him minutes of a 16GB machine he is still typing on.

When he says done: run `check:harden` once, then push. Migrations and production deploys get their
own run immediately before the action, because CI does not cover those. Verifying a UI change in the
browser is not validation and does not need permission — reload and look.

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

These files are **permanently locked** by the owner. No AI session, developer, or automated
tool may read-then-edit, refactor, rename constants, adjust formulas, or change any value inside
them without the owner explicitly approving that specific change in the active conversation first.

| File | What it protects |
| --- | --- |
| `src/lib/incentives/scheme-2026.ts` | 2026 incentive payout curve, achievement thresholds, semester target formula |
| `src/lib/payroll/policy.ts` | `BASIC_SALARY_RATE` (70%), and all salary derivation formulas (base → basic → net → gross) |
| `src/components/employee-portal/identity-card.tsx` | Employee portal identity banner — must always use `PhoenixSignatureCard`; do NOT swap it for another component |
| `src/lib/sales/office-allocation.ts` (the `GOLDEN RULE · LOCKED` region) | The Office allocation golden rule — units spread by each area's share of the line's non-Office **value**. **Enforced mechanically**, not just behaviourally: see below |

**The Office golden rule is the one lock a session cannot talk itself past.** Locked 2026-08-11 at
the owner's instruction. `tests/office-golden-rule-lock.test.ts` pins the formula with a source
fingerprint, a behaviour fingerprint, and four verbatim clause checks, and it runs in the required
CI `validate` job — so a PR that changes the rule goes red and cannot merge. Changing it needs the
owner's password via `pnpm run office-rule:unlock`; the password exists only as a scrypt verifier and
is not recoverable from this repository. Do not re-pin the fingerprints by hand, and do not "fix" a
red lock test by editing `src/lib/sales/office-golden-rule.ts` — that edit is precisely what the
check exists to catch. The rule itself is documented clause by clause in that same file.

**If any request would touch one of these files** (fix, refactor, rename, extend, delete): STOP. Show
the owner the exact change you intend to make and why it is necessary, and continue only after the
owner approves that specific change in the conversation.

**This lock is now behavioral, not mechanical.** `.claude/settings.json` still lists these paths
under `permissions.ask`, but the owner set `permissions.defaultMode: "bypassPermissions"` in
user-level settings on 2026-08-01, so **no approval prompt fires for them any more**. Nothing but
the agent's own compliance stops an edit. Treat the absence of a prompt as silence, never as
approval.

**Do not reintroduce a passphrase here.** A shared one was removed 2026-07-31 (it sat in a committed
file, so it authenticated nobody); approval belongs in the conversation, not in version control.
