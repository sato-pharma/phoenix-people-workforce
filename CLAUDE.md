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
| Typecheck — **CI's job, not yours** (see below) | `pnpm run typecheck` |
| Unit/integration tests | `pnpm run test` |
| Whole gate, by hand — **only when the owner names it** | `pnpm run ci` |

**CI is the gate. Do not run a local full validation** — no "quick subset" of lint + typecheck
before pushing, no `pnpm run ci` as a pre-push ritual. Push the branch and let the PR's six
required checks answer. Migrations and production deploys are the two things CI never sees. Full
rule, the retired `check:harden`, and the per-change matrix: [AGENTS.md §7](AGENTS.md).

🔴 **A local typecheck is no longer a "fast editing gate" — it does not fit on the owner's machine,
and `check:edit` is retired as an editing habit.** Measured 2026-09-25: a cold `tsc` needs 4.0–4.5 GB
of heap and OOMs at node's own 4.1 GB default after 155 s, and `mem-watchdog.ps1` then reaps it as
the largest node job — and **every one of the 23 kills its log still held was a typecheck**, not one
other kind of node job among them, each printing nothing, so the session simply ran it again. (The
log rotates at 800 lines, about a day and a half here, so it can only ever show the recent window —
never read its start date as the date the trouble began.) Raising `--max-old-space-size` makes it the FIRST victim
(4096, 5120, 6144 and 7168 were all tried, all reaped). It grew with the repo: 5,065 → 6,048
`.ts/.tsx` files in 13 days, CI's own cold run 125 s → 183 s. **Push the branch — the PR's
`typecheck` check is cold, clean and ~3 min.**

**And since 2026-09-25 it is a DENY, not a rule:** `.claude/hooks/bash-guard.mjs` clause **C8**
refuses a local typecheck in every spelling. The rule alone could not hold, because a reaped run
prints nothing and exits non-zero — a session cannot tell that from a typo, so it tries the next
spelling. `PHX_TYPECHECK_OK=1 <cmd>` (`$env:PHX_TYPECHECK_OK=1; <cmd>` in PowerShell) stands it down
for one command. Pinned by `tests/local-typecheck-guard.test.ts`.

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
`test` job — so a PR that changes the rule goes red and cannot merge. Changing it needs the
owner's password; it exists only as a scrypt verifier in `src/lib/sales/office-golden-rule.lock.json`
and is not recoverable from this repository. **ARMED 2026-09-05 — before that date no verifier
existed at all**, and `unlock` refused rather than re-pinning (it fails closed), so a session reading
this line would have believed a password was in place when none was. Do not re-pin the fingerprints
by hand, and do not "fix" a red lock test by editing `src/lib/sales/office-golden-rule.ts` — that
edit is precisely what the check exists to catch.

🔴 **NEVER run the unlock as `pnpm run office-rule:unlock` from a worktree** — §5's pnpm rule applies
and this is its worst case. `pnpm` runs its deps check first, sees the moved lockfile, and offers to
delete **the PRIMARY's `node_modules`** (the worktree's is a junction to it), breaking every session
on the machine. It happened on 2026-09-05 and was answered `N` with one second to spare. Invoke node
directly instead, from the folder holding the change:
`node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs scripts/office-rule-unlock.ts --unlock`
(`--set-password` first, one time, if no verifier exists). **The folder matters more than it looks:**
run it in the primary while the edit sits in a worktree and it re-pins the UNCHANGED source — a
silent no-op that prints success.

**The other three locks are behavioral ONLY — no prompt backs them.** `permissions.ask` is empty, so
no dialog fires on any of those paths. **Never read the absence of a prompt as approval:** ask the
owner in plain words and wait for a plain answer. Do not reintroduce a passphrase here — a shared one
was removed 2026-07-31 because it sat in a committed file and authenticated nobody. Full history of
the settings changes, and how to recover the pre-2026-08-14 file:
[docs/agents-incident-history.md](docs/agents-incident-history.md).
