# CLAUDE.md

Guidance for Claude Code in this repository. **[AGENTS.md](AGENTS.md) is the source of truth for operating
rules** and loads with this file. This file holds the daily commands, the two rules for every change and the
protected-file gate. Its full pre-2026-10-24 wording is in `docs/agents-md-full-2026-10-24.md`.

@AGENTS.md

## 🛑 The mobile app is FROZEN — the web app is the whole scope

Owner rule, 2026-09-29: **do not work in the mobile app, touch it, plan it, mention it or ask him about it**
until he lifts this in his own words — no edit under `mobile/`, no Expo/EAS build, no mobile PR, no words in a
`Next step:` line, plan or question. Full rule: [AGENTS.md §4](AGENTS.md), first bullet.

## Cloud sessions — read your Phoenix memory first

If `~/.claude/` is absent you are a cloud session: before your first substantive answer read
`.claude/cloud-context/memory-mirror/MEMORY.md` and `.claude/cloud-context/global-standing-rules.md` (ignore its
machine/RAM sections), and grep `.claude/cloud-context/memory-mirror/` for specific facts. Local sessions ignore this.

## Commands

All from the repo root (inside a worktree, invoke `node scripts/…` — never pnpm, AGENTS.md §5).

| Task | Command |
| --- | --- |
| Dev server | `pnpm run dev` (`node scripts/dev-server.mjs --port 3000` in a worktree) |
| Production build | `pnpm run build` |
| Lint | `pnpm run lint` |
| Typecheck — **CI's job, denied locally** (bash-guard C8) | `pnpm run typecheck` |
| Unit/integration tests | `pnpm run test` |
| Repo-wide contract gates + changed files' lint, ~8s | `node scripts/check-contracts.mjs` |
| What CI said about the pushed commit — read from GitHub | `node scripts/remote-check.mjs typecheck` (also `lint`, `test`, `build`, `all`; `--dispatch` starts a run) |
| Whole gate, by hand — **only when the owner names it** | `pnpm run ci` |

🔴 **The PR's own CI is the verdict** — `ci.yml` runs `validate` and `checks` (the two required names) on
GitHub-hosted runners in parallel. Commit, push, open the PR; run `remote-check` once with
`run_in_background: true` and act on the notification (exit 0 PASS, 1 FAIL, 2-9 NO VERDICT — never a pass).
The Hetzner CI box is retired (owner, 2026-10-19). Account: `docs/testing.md`, `.claude/rules/engineering.md`.

## The two rules that apply to every change

- **Domain-first.** Business logic lives in `src/lib/<domain>/`; pages and components call domain services and
  never re-implement payroll, leave, expense, outstation, HR or sales rules inline.
- **Server-side access control is the security boundary.** Hiding a link in `system-navigation.ts` is UX only;
  enforce with `assertPermission(ctx, resource, action)` in the route handler, before any mutation.

## Global edit points

| Change | File |
| --- | --- |
| Brand, URLs, email defaults | `src/config/system-settings.ts` |
| Sidebar, nav, role routing | `src/config/system-navigation.ts` |
| Design tokens | `src/styles/tokens.css` + `app/globals.css` |
| Shared UI primitives | `src/components/ui/` |

Detail on demand: [docs/architecture.md](docs/architecture.md) · [docs/editing-guide.md](docs/editing-guide.md) ·
[docs/security/](docs/security/) · [docs/deployment.md](docs/deployment.md) · [docs/testing.md](docs/testing.md)
(a test not registered in `tests/run-tests.ts` never runs) · [docs/needs-you.md](docs/needs-you.md).

## Protected Files — OWNER APPROVAL REQUIRED

Permanently locked by the owner. No session may edit, refactor, rename constants, adjust formulas or change any
value inside them without the owner approving **that specific change** in the active conversation first.

| File | What it protects |
| --- | --- |
| `src/lib/incentives/scheme-2026.ts` | 2026 incentive payout curve, achievement thresholds, semester target formula |
| `src/lib/payroll/policy.ts` | `BASIC_SALARY_RATE` (70%) and all salary derivation formulas (base → basic → net → gross) |
| `src/components/employee-portal/identity-card.tsx` | Employee portal identity banner — must always use `PhoenixSignatureCard` |
| `src/lib/sales/office-allocation.ts` (the `GOLDEN RULE · LOCKED` region) | The Office allocation golden rule — units spread by each area's share of the line's non-Office **value** |

**If a request would touch one of these: STOP**, show the owner the exact change and why, and continue only
after he approves it.

- **The Office golden rule is enforced mechanically** — `tests/office-golden-rule-lock.test.ts` pins it by
  fingerprint in the required CI; changing it needs the owner's password (a scrypt verifier in
  `src/lib/sales/office-golden-rule.lock.json`). Never re-pin by hand, never "fix" a red lock test.
  🔴 **Never run the unlock through pnpm from a worktree** (it offers to delete the PRIMARY's `node_modules`);
  run `node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs scripts/office-rule-unlock.ts --unlock`
  from the folder that holds the change.
- **The other three raise a PROMPT** — `.claude/hooks/protected-file-guard.mjs` answers any edit with `ask`.
  The prompt is not the approval: ask him in plain words first; a refused prompt is his answer. History:
  [docs/agents-incident-history.md](docs/agents-incident-history.md).
