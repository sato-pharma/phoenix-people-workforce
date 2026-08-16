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

**Validate ONLY when the owner says so. Never on your own judgement.** No lint, no typecheck, no
tests, no build until he says the work is done — not between edits, not "once per task", not because
a change feels finished. **Before starting any long run, ask him in plain words: "Have you finished
editing?" — yes → run it, no → don't.** When he says done: `check:harden` once, then push. Verifying
a UI change in the browser is not validation and needs no permission — reload and look. The ask is
enforced by `.claude/hooks/ask-before-validation.mjs`, which turns every long command into a prompt.
Full rule, the reasoning, and the per-change validation matrix: [AGENTS.md §7](AGENTS.md).

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

**This lock is now behavioral ONLY — no prompt backs it any more.** On 2026-08-14 the owner
instructed that `permissions.ask` be emptied in `.claude/settings.json` (the `deny` list was cleared
that day too, then its one block on the untrusted `mcp__b345e47e-…` connector restored per
AGENTS.md §8 — a silent hard block, not a prompt), so the three file paths above no longer have an
entry there and **no dialog will fire on any of them.** (`office-allocation.ts` was never in that
list — it has the CI lock instead, which is untouched and still turns a PR red.) `permissions.defaultMode` is **`auto`** in user-level settings,
read live 2026-08-14, and auto mode auto-approves a great deal on its own. So nothing except the
agent's own compliance now stands between a request and an edit to a protected file. **Never read
the absence of a prompt as approval** — that was already the rule while the entries existed, and it
is the entire story now that they are gone. Ask the owner in plain words and wait for a plain answer.
The pre-2026-08-14 file is recoverable from the commit *before* the lists were emptied:
`git checkout 6fd35986^ -- .claude/settings.json` (`6fd35986` is the `chore(claude)` commit, #2117,
that emptied both lists). Plain `git checkout .claude/settings.json` will NOT work once that commit
is checked out — it only restores that commit's already-empty version.

**Do not reintroduce a passphrase here.** A shared one was removed 2026-07-31 (it sat in a committed
file, so it authenticated nobody); approval belongs in the conversation, not in version control.
