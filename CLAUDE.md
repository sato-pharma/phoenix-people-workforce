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
| Dev server (auto: webpack on Windows) | `pnpm run dev` |
| Production build | `pnpm run build` |
| Lint | `pnpm run lint` |
| Typecheck | `pnpm run typecheck` |
| Unit/integration tests | `pnpm run test` |
| Fast editing gate (typecheck only) | `pnpm run check:edit` |
| Whole gate, by hand — **only when the owner names it** | `pnpm run ci` |

**CI is the gate. Do not run a local full validation.** `check:harden` was retired on 2026-08-18 at
the owner's instruction, together with the `ask-before-validation` hook. Do not reintroduce them and
do not invent a replacement — no "quick subset" of lint + typecheck before pushing, no `pnpm run ci`
as a pre-push ritual. **Push the branch and let the PR's checks answer**; `validate`, `lint`,
`typecheck` and `secret-scan` are required checks that block the merge. Migrations and production
deploys are the two things CI never sees — those still get a check immediately before the action.
Verifying a UI change in the browser is not validation at all — reload and look. Full rule and the
per-change matrix: [AGENTS.md §7](AGENTS.md).

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

These files are **permanently locked** by the owner. No AI session, developer, or automated tool may
read-then-edit, refactor, rename constants, adjust formulas, or change any value inside them without
the owner explicitly approving that specific change in the active conversation first.

| File | What it protects |
| --- | --- |
| `src/lib/incentives/scheme-2026.ts` | 2026 incentive payout curve, achievement thresholds, semester target formula |
| `src/lib/payroll/policy.ts` | `BASIC_SALARY_RATE` (70%), and all salary derivation formulas (base → basic → net → gross) |
| `src/components/employee-portal/identity-card.tsx` | Employee portal identity banner — must always use `PhoenixSignatureCard`; do NOT swap it for another component |
| `src/lib/sales/office-allocation.ts` (the `GOLDEN RULE · LOCKED` region) | The Office allocation golden rule — units spread by each area's share of the line's non-Office **value**. **Enforced mechanically**, not just behaviourally: see below |

**If any request would touch one of these files** (fix, refactor, rename, extend, delete): STOP. Show
the owner the exact change you intend to make and why it is necessary, and continue only after the
owner approves that specific change in the conversation.

**The Office golden rule is the one lock a session cannot talk itself past.** Locked 2026-08-11 at
the owner's instruction. `tests/office-golden-rule-lock.test.ts` pins the formula with a source
fingerprint, a behaviour fingerprint, and four verbatim clause checks, and it runs in the required CI
`validate` job — so a PR that changes the rule goes red and cannot merge. Changing it needs the
owner's password via `pnpm run office-rule:unlock`; the password exists only as a scrypt verifier and
is not recoverable from this repository. Do not re-pin the fingerprints by hand, and do not "fix" a
red lock test by editing `src/lib/sales/office-golden-rule.ts` — that edit is precisely what the
check exists to catch.

**The other three locks are behavioral ONLY — no prompt backs them.** `permissions.ask` is empty, so
no dialog fires on any of those paths. **Never read the absence of a prompt as approval:** ask the
owner in plain words and wait for a plain answer. Do not reintroduce a passphrase here — a shared one
was removed 2026-07-31 because it sat in a committed file and authenticated nobody. Full history of
the settings changes, and how to recover the pre-2026-08-14 file:
[docs/agents-incident-history.md](docs/agents-incident-history.md).
