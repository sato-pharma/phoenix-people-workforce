# Repository Cleanup Plan

**Date:** 2026-05-30
**Status:** Phases 1-3 executed (root cleanup, branch cleanup, Excel/binary List A). Employee photo cleanup and history rewrite remain pending approval
**Goal:** Make this repository look like a serious enterprise software project

### Phase 1 Completed Actions (root + artifacts)
- Moved 4 root docs to docs/ (audit, payroll guide, system overview, todo)
- Moved 3 root scripts to scripts/ (check-query.js, no-data-check.js, start-dev.ps1)
- Moved 1 stray SQL to supabase/
- Untracked 13 tool artifact files via git rm --cached (files remain locally)
- Fixed local Windows paths in moved docs, production-readiness doc, and attendance agent README
- proxy.ts kept at root (test dependency found in tests/phase21-security-hardening.test.ts)

### Phase 2 Completed Actions (branches)
- Deleted 14 stale local branches
- Deleted 18 stale remote branches (List A)
- Kept: main, codex/work-from-production, dependabot (open PR), seer/fix (open PR #15)

### Phase 3 Completed Actions (Excel/binary List A)
- Untracked `sato 4-2026/` (25 files, ~40.75 MB) via git rm --cached
- Untracked `output/` (2 files, ~3.15 MB)
- Untracked `mabretelasafraRTDrequest.xlsx` and `Outcome_VS_investment(Marchrequests)_2.xlsx`
- Total untracked: ~44 MB (files remain on disk)
- KEPT (required): Phoenix Pharmacy Database.xlsx + phoenix products.xlsx (CI test fixtures), Phoneix system template.xlsx (payroll app asset)
- Documented sato 4-2026/ local-only requirement in docs/scripts.md

### Pending Approval (future phases)
- Close PR #15, then delete origin/seer/fix/hr-specialist-portal-access
- Employee photo PII remediation + Supabase Storage migration (127 files, ~17 MB)
- shadcn stub consolidation (components/ui/button.tsx, lib/utils.ts)
- Git history rewrite (BFG/filter-repo) to permanently reclaim ~44 MB of binary history

---

## A) Executive Summary

The Phoenix Workforce repository contains **84 MB of tracked binary data** (45 MB Excel, 37 MB images, 2 MB screenshots), **20+ misplaced root files**, **9 employee photos with personal names**, **38 branches** (most stale/experimental), and multiple tool artifact directories. The root directory has 55 entries when a professional repo should have ~20. This plan proposes phased cleanup to reduce the root to essential files, remove binary bloat from tracking, clean up branches, and present a professional GitHub first impression.

---

## B) Current Repo Problems

| Problem | Severity | Impact |
|---|---|---|
| 84 MB of tracked binary data (xlsx + images + screenshots) | High | Clone takes minutes, repo size bloated permanently |
| 55 root-level entries (should be ~20) | High | Unprofessional first impression, confusing for new devs |
| 38 branches (most stale or experimental) | Medium | Cluttered branch list, confusing for contributors |
| 9 employee photos with personal-name filenames | Medium | PII risk (full names in git history) |
| Local development tool directories tracked (screenshots, notes, IDE config) | Medium | Exposes internal tooling, unprofessional |
| 5 root-level Excel files | Medium | Not source code, inflates repo |
| 6 scratch/debug files at root | Low | Clutter, unprofessional |
| 4 documentation files misplaced at root | Low | Disorganized |
| 1 stray SQL file at root | Low | Confusing location |
| Duplicate shadcn stubs (components/, lib/) | Low | Import confusion |

---

## C) Branch Cleanup Table

### Local Branches (5)

| Branch | Last Activity | Status | Action | Risk | Approval? | Command |
|---|---|---|---|---|---|---|
| `main` | 5 days ago | Production | **Keep** | -- | No | -- |
| `codex/work-from-production` | 13 min ago | Active working branch | **Keep** | -- | No | -- |
| `codex/github-audit-remediation` | 10 days ago | Feature (unmerged) | **Delete local** | Low | Yes | `git branch -d codex/github-audit-remediation` |
| `codex/readiness-preview-20260522-215937` | 6 days ago | Feature (unmerged) | **Delete local** | Low | Yes | `git branch -d codex/readiness-preview-20260522-215937` |
| `Orthopedic-Design` | 5 days ago | Unknown/experimental | **Delete local** | Low | Yes | `git branch -D Orthopedic-Design` |

### Local Branches — Stale Stream Branches (9)

| Branch | Status | Action | Command |
|---|---|---|---|
| `stream/admin` | Initialization only, 5 days stale | **Delete local** | `git branch -d stream/admin` |
| `stream/attendance` | Initialization only | **Delete local** | `git branch -d stream/attendance` |
| `stream/employee-portal` | Initialization only | **Delete local** | `git branch -d stream/employee-portal` |
| `stream/leave-admin` | Initialization only | **Delete local** | `git branch -d stream/leave-admin` |
| `stream/leave-employee` | Initialization only | **Delete local** | `git branch -d stream/leave-employee` |
| `stream/outstation` | Initialization only | **Delete local** | `git branch -d stream/outstation` |
| `stream/payroll` | Initialization only | **Delete local** | `git branch -d stream/payroll` |
| `stream/platform` | Initialization only | **Delete local** | `git branch -d stream/platform` |
| `stream/sales-reports` | Initialization only | **Delete local** | `git branch -d stream/sales-reports` |

All 9 stream/* branches contain only a single "chore(stream): initialize deployment" commit. **Risk:** Low. **Approval required:** Yes.

### Local Branches — Other Stale (2)

| Branch | Status | Action | Command |
|---|---|---|---|
| `release/qa` | 5 days stale | **Delete local** | `git branch -d release/qa` |
| `safety/local-snapshot-2026-05-24` | Safety snapshot, 5 days | **Delete local** after confirming codex/work-from-production has all work | `git branch -d safety/local-snapshot-2026-05-24` |

### Remote Branches — Recommend Deletion (after local cleanup)

| Remote Branch | Problem | Action | Command |
|---|---|---|---|
| `origin/claude/fix-typescript-errors-klXf0` | Tool-named, 10 days stale | **Delete remote** | `git push origin --delete claude/fix-typescript-errors-klXf0` |
| `origin/codex/fix-database-error-during-login` | 2 weeks stale | **Delete remote** | `git push origin --delete codex/fix-database-error-during-login` |
| `origin/codex/fix-typescript-type-errors-in-pages` | 2 weeks stale | **Delete remote** | `git push origin --delete codex/fix-typescript-type-errors-in-pages` |
| `origin/codex/github-audit-remediation` | 10 days stale | **Delete remote** | `git push origin --delete codex/github-audit-remediation` |
| `origin/codex/mobile-expense-submit-polish` | 7 days stale | **Delete remote** | `git push origin --delete codex/mobile-expense-submit-polish` |
| `origin/codex/readiness-preview-20260522-215937` | 6 days stale | **Delete remote** | `git push origin --delete codex/readiness-preview-20260522-215937` |
| `origin/seer/chore/gitignore-sentry-test` | Tool-named (seer), 2 days | **Delete remote** | `git push origin --delete seer/chore/gitignore-sentry-test` |
| `origin/seer/fix/hr-specialist-portal-access` | Tool-named (seer), 27h | **Review first** -- may have useful fix | `git push origin --delete seer/fix/hr-specialist-portal-access` |
| `origin/safety/local-snapshot-2026-05-24` | Safety snapshot | **Delete remote** after confirming | `git push origin --delete safety/local-snapshot-2026-05-24` |
| `origin/stream/*` (9 branches) | Initialization only | **Delete remote** | `git push origin --delete stream/admin stream/attendance ...` |
| `origin/release/qa` | Stale QA branch | **Delete remote** | `git push origin --delete release/qa` |

### Remote Branches — Keep

| Remote Branch | Reason |
|---|---|
| `origin/main` | Production |
| `origin/codex/work-from-production` | Active working branch |
| `origin/dependabot/npm_and_yarn/*` (4 branches) | Active dependency updates -- let Dependabot manage lifecycle |

### Branch Naming Note

The `codex/` prefix is the current branch naming convention. Future branches could use a neutral prefix (e.g., `dev/`, `feature/`, `fix/`) but renaming the active working branch requires coordinated CI + Vercel changes. Recommend as a separate future initiative.

---

## D) Root File Cleanup Table

### Files that belong at root (keep as-is)

| File | Purpose |
|---|---|
| `README.md` | Repository front page |
| `CONTRIBUTING.md` | Contributor guide |
| `SECURITY.md` | Security policy |
| `CHANGELOG.md` | Change log |
| `package.json` | Dependencies and scripts |
| `package-lock.json` | Lock file |
| `tsconfig.json` | TypeScript config |
| `next.config.ts` | Next.js config |
| `next-env.d.ts` | Next.js type declarations |
| `vercel.json` | Vercel deployment config |
| `.gitignore` | Git ignore rules |
| `eslint.config.mjs` | ESLint config |
| `postcss.config.mjs` | PostCSS config |
| `tailwind.config.ts` | Tailwind config |
| `playwright.config.ts` | Playwright E2E config |
| `components.json` | shadcn/ui config |
| `instrumentation.ts` | Sentry server instrumentation |
| `instrumentation-client.ts` | Sentry client instrumentation |
| `sentry.server.config.ts` | Sentry server config |
| `sentry.edge.config.ts` | Sentry edge config |
| `.env.example` | Environment variable template |
| `.env.github-secrets.example` | GitHub secrets template |
| `.env.staging.rls.example` | Staging RLS env template |
| `.mcp.json` | MCP server config |
| `CLAUDE.md` | Internal engineering reference |
| `AGENTS.md` | Internal operating rules |

### Files to MOVE to docs/ (4 files)

| File | Problem | Action | Command |
|---|---|---|---|
| `AUDIT-2026-05-09.md` | Security audit misplaced at root | Move to docs/ | `git mv AUDIT-2026-05-09.md docs/audit-2026-05-09.md` |
| `PAYROLL_PAYSLIPS_DETAILED.md` | Technical guide misplaced at root | Move to docs/ | `git mv PAYROLL_PAYSLIPS_DETAILED.md docs/payroll-payslips-detailed.md` |
| `SYSTEM_OVERVIEW.md` | System overview misplaced at root | Move to docs/ | `git mv SYSTEM_OVERVIEW.md docs/system-overview.md` |
| `TODO.md` | Task list misplaced at root | Move to docs/ | `git mv TODO.md docs/todo.md` |

**Risk:** Low. **Approval required:** Yes.

### Files to MOVE to scripts/ (4 files)

| File | Problem | Action | Command |
|---|---|---|---|
| `check-query.js` | Debug script at root | Move to scripts/ | `git mv check-query.js scripts/check-query.js` |
| `no-data-check.js` | Debug script at root | Move to scripts/ | `git mv no-data-check.js scripts/no-data-check.js` |
| `proxy.ts` | Dev proxy at root | Move to scripts/ | `git mv proxy.ts scripts/proxy.ts` |
| `start-dev.ps1` | Dev start script at root | Move to scripts/ | `git mv start-dev.ps1 scripts/start-dev.ps1` |

**Risk:** Low (proxy.ts may be imported -- verify first). **Approval required:** Yes.

### Files to MOVE to supabase/ (1 file)

| File | Problem | Action | Command |
|---|---|---|---|
| `20260511_add_missing_employee_fields.sql` | Stray SQL at root | Move to supabase/ | `git mv 20260511_add_missing_employee_fields.sql supabase/20260511_add_missing_employee_fields.sql` |

**Risk:** Low. **Approval required:** Yes.

### Files to REMOVE from git tracking (5 files)

| File | Problem | Size | Action | Command |
|---|---|---|---|---|
| `ChatGPT Image May 22, 2026, 05_14_54 PM.png` | Tool-generated image at root | 770 KB | `git rm --cached` | `git rm --cached "ChatGPT Image May 22, 2026, 05_14_54 PM.png"` |
| `skills-lock.json` | Tool lock file | < 1 KB | `git rm --cached` | `git rm --cached skills-lock.json` |

**Risk:** Low. **Approval required:** Yes. These are already in `.gitignore`.

### Duplicate source stubs to CONSOLIDATE (2 files)

| File | Problem | Action |
|---|---|---|
| `components/ui/button.tsx` | Duplicates `src/components/ui/button.tsx` | Verify `components.json` paths, then remove |
| `lib/utils.ts` | Duplicates `src/lib/utils.ts` | Verify `components.json` paths, then remove |

**Risk:** Medium (may break shadcn CLI). **Approval required:** Yes. Verify first.

---

## E) Binary / Data Cleanup Table

### Excel Files (32 tracked, 45.1 MB total)

| Group | Count | Size | Category | Action | Command |
|---|---|---|---|---|---|
| `sato 4-2026/*.xlsx` | 27 | ~40 MB | Operational data | `git rm --cached` | `git rm --cached -r "sato 4-2026/"` |
| `mabretelasafraRTDrequest.xlsx` | 1 | small | Operational data | `git rm --cached` | `git rm --cached mabretelasafraRTDrequest.xlsx` |
| `Outcome_VS_investment(Marchrequests)_2.xlsx` | 1 | small | Operational data | `git rm --cached` | `git rm --cached "Outcome_VS_investment(Marchrequests)_2.xlsx"` |
| `Phoneix system template.xlsx` | 1 | small | Operational data | `git rm --cached` | `git rm --cached "Phoneix system template.xlsx"` |
| `phoenix products.xlsx` | 1 | small | Seed data (used by scripts) | `git rm --cached` | `git rm --cached "phoenix products.xlsx"` |
| `Phoenix Pharmacy Database.xlsx` | 1 | small | Seed data (used by scripts) | `git rm --cached` | `git rm --cached "Phoenix Pharmacy Database.xlsx"` |
| `output/sales-template-analysis/*.xlsx` | 2 | ~2 MB | Generated output | `git rm --cached` | `git rm --cached -r output/` |

**Risk:** Low (files remain locally, .gitignore prevents re-tracking). **Approval required:** Yes.
**Note:** `phoenix products.xlsx` and `Phoenix Pharmacy Database.xlsx` are referenced by `scripts/seed-marketing-reference-data.ts`. Document alternative storage location before removing.

---

## F) Tool Artifact Cleanup Table

| Path | Files | Size | Problem | Action | Command |
|---|---|---|---|---|---|
| `.codex-artifacts/` | 7 PNGs | 2 MB | Development tool screenshots | `git rm --cached -r` | `git rm --cached -r .codex-artifacts/` |
| `memory/` | 2 files | < 1 KB | Development tool notes | `git rm --cached -r` | `git rm --cached -r memory/` |
| `trae/` | 1 file | < 1 KB | IDE troubleshooting log | `git rm --cached -r` | `git rm --cached -r trae/` |
| `.trae/` | 1 file | < 1 KB | IDE config | `git rm --cached -r` | `git rm --cached -r .trae/` |
| `.agents/skills/` | 38 files | ~100 KB | Database best-practices reference | **Review** -- not tool-branded but assess necessity | -- |
| `.claude/` | settings | < 1 KB | Mostly gitignored already | Verify nothing sensitive tracked | `git ls-files .claude/` |
| `skills-lock.json` | 1 | < 1 KB | Tool lock file | `git rm --cached` | `git rm --cached skills-lock.json` |
| `ChatGPT Image...png` | 1 | 770 KB | Tool-generated image | `git rm --cached` | `git rm --cached "ChatGPT Image May 22, 2026, 05_14_54 PM.png"` |

**All already in `.gitignore`** -- files remain locally after untracking.
**Risk:** Low. **Approval required:** Yes.

---

## G) Public Asset / Privacy Table

### Brand Assets (public/brand/, public/assets/) -- KEEP

| Path | Count | Size | Status |
|---|---|---|---|
| `public/brand/*.png` | 18 | ~15 MB | Required for app UI -- logos, icons, login emblem |
| `public/assets/branding/*.png` | 3 | ~3 MB | Email signatures, banners |

**Action:** Keep. These are legitimate UI assets. Consider optimizing large PNGs (sidebar logo is 2.2 MB) in a future PR.

### Employee Photos (public/images/hr/) -- MIGRATE LATER

| Metric | Value |
|---|---|
| Total files | 127 |
| Total size | ~17 MB |
| HR_ID-named (e.g., A-1.jpg, B-12.jpeg) | 118 |
| Personal-name-named | **9 (PII risk)** |

**Personal-name files (PII risk):**
- `Adel El Sayed.jpg`
- `fiby-wagdy-luka.jpg`
- `nada-ali.jpg`
- `omar-anwar-gawish.jpg`
- `taha-mohamed.jpg`
- `youmna-kotb.jpg`
- `AA.jpg`, `AB.jpeg` (ambiguous)
- `admin-HR.jpg` (role descriptor)

**Risk:** Medium -- personal names in git history are a PII concern. HR_ID-named files are lower risk.
**Action:** Phase 3 -- migrate all photos to Supabase Storage with access control. Requires app code changes (`/images/hr/` URL references). Rename personal-name files to HR_ID format as an interim step.
**Approval required:** Yes.

---

## H) Documentation Cleanup Table

### Root docs to MOVE to docs/

Already listed in Section D. Four files: `AUDIT-2026-05-09.md`, `PAYROLL_PAYSLIPS_DETAILED.md`, `SYSTEM_OVERVIEW.md`, `TODO.md`.

### Docs with local Windows paths

| File | Lines with paths | Action |
|---|---|---|
| `AUDIT-2026-05-09.md` | Multiple `F:\Phoenix Workforce\...` references | Update paths when moved to docs/ |
| `docs/current-operating-state.md` | Line 111 reference | Update to relative path |
| `docs/production-readiness-closure-system.md` | Line 111 | Update to relative path |
| `local-attendance-agent/README.md` | `cd "F:\Phoenix Workforce\..."` | Update to relative path |

### Docs with tool-name references (already cleaned in Phase 1)

README.md, CONTRIBUTING.md, docs/README.md, docs/troubleshooting.md, .github/pull_request_template.md -- all cleaned.

### Planning docs to consider archiving

| File | Status | Recommendation |
|---|---|---|
| `docs/workforce-lifecycle-phase-1-plan.md` | Planning doc | Keep -- still relevant |
| `docs/marketing-requests-mvp.md` | Planning doc | Keep -- still relevant |
| `docs/archive/employee-portal-launch-remediation-plan.md` | Completed remediation plan | **Archived** to docs/archive/ and marked as a historical record; tool-brand names neutralized |
| `docs/image-evidence-storage-report.md` | Analysis report | Keep for reference |

---

## I) Scripts Cleanup Table

### Root-level scripts to MOVE

Already listed in Section D: `check-query.js`, `no-data-check.js`, `proxy.ts`, `start-dev.ps1`.

**Important:** Verify `proxy.ts` is not imported by app code before moving. Check:
```bash
grep -r "proxy" src/ app/ --include="*.ts" --include="*.tsx" -l
```

### Scripts directory inventory

| Script | Category | Risk | Status |
|---|---|---|---|
| `scripts/seed-marketing-reference-data.ts` | Seed data | Caution | Wired in package.json -- keep |
| `scripts/export-supabase-to-xlsx.js` | Utility | Caution | Uses CJS require, undocumented deps -- document |
| `scripts/audit-image-evidence-storage.ts` | Audit | Caution | Read-only -- keep |
| `scripts/build_sales_database_foundation.py` | Utility | Safe | Only Python file -- document purpose |
| `scripts/employee-portal-launch-smoke.mjs` | Test | Safe | Keep |
| `scripts/phase13-*.mjs` through `scripts/phase27-*.ts` | Migration pipeline | Caution-Danger | Keep -- document in docs/scripts.md |
| `scripts/phase28-phase36*.ts` | Production migration | **Danger** | Keep -- document safety level |

### test/scripts/ inventory

All files in `tests/scripts/` are RLS validation and staging test harnesses. They are wired into `db:*` npm scripts. **Action:** Keep, already documented in `docs/scripts.md`.

---

## J) Recommended Final Repo Structure

After cleanup, the root should contain only:

```
app/                              # App Router (unchanged)
src/                              # Source code (unchanged)
supabase/                         # SQL migrations + historical scripts
tests/                            # Unit, integration, and E2E tests
docs/                             # All documentation
scripts/                          # All scripts and utilities
public/                           # Static assets (brand, images)
local-attendance-agent/           # Standalone .NET attendance agent
.github/                          # CI, templates, Dependabot

README.md                         # Repository front page
CONTRIBUTING.md                   # Contributor guide
SECURITY.md                       # Security policy
CHANGELOG.md                      # Change log
.env.example                      # Environment template
.env.github-secrets.example       # GitHub secrets template
.env.staging.rls.example          # Staging RLS env template
.mcp.json                         # MCP server config
.gitignore                        # Git ignore rules

package.json                      # Dependencies
package-lock.json                 # Lock file
tsconfig.json                     # TypeScript config
next.config.ts                    # Next.js config
next-env.d.ts                     # Next.js type declarations
vercel.json                       # Vercel config
eslint.config.mjs                 # ESLint config
postcss.config.mjs                # PostCSS config
tailwind.config.ts                # Tailwind config
playwright.config.ts              # Playwright config
components.json                   # shadcn/ui config
instrumentation.ts                # Sentry server
instrumentation-client.ts         # Sentry client
sentry.server.config.ts           # Sentry server config
sentry.edge.config.ts             # Sentry edge config

CLAUDE.md                         # Internal engineering reference (not visible in docs)
AGENTS.md                         # Internal operating rules (not visible in docs)
```

**Root entries reduced from 55 to ~33** (all legitimate config/governance files).

---

## K) Approval Checklist

Before executing any cleanup, the owner must approve:

- [ ] Branch deletion list (Section C)
- [ ] Root file moves to docs/ (Section D)
- [ ] Root file moves to scripts/ (Section D -- verify proxy.ts first)
- [ ] Root SQL move to supabase/ (Section D)
- [ ] Git rm --cached for tool artifacts (Section F)
- [ ] Git rm --cached for Excel files (Section E)
- [ ] Git rm --cached for ChatGPT image and skills-lock.json (Section D)
- [ ] Git rm --cached for .codex-artifacts/ (Section F)
- [ ] Git rm --cached for memory/, trae/, .trae/ (Section F)
- [ ] Employee photo PII remediation approach (Section G)
- [ ] Duplicate shadcn stub consolidation approach (Section D)
- [ ] Documentation path fixes (Section H)

---

## L) Safe Phase 1 Cleanup Actions (Low Risk)

These can be executed immediately after approval:

1. **Delete stale local branches** (16 branches) -- `git branch -d ...`
2. **Delete stale remote branches** (15+ branches) -- `git push origin --delete ...`
3. **Move 4 root docs to docs/** -- `git mv ...`
4. **Move 4 root scripts to scripts/** -- after verifying proxy.ts
5. **Move 1 root SQL to supabase/** -- `git mv ...`
6. **Untrack tool artifacts** -- `git rm --cached` for .codex-artifacts/, memory/, trae/, .trae/, skills-lock.json, ChatGPT image
7. **Fix local Windows paths** in moved docs

---

## M) Risky Phase 2 Cleanup Actions (Medium Risk)

These require more care:

1. **Untrack all Excel files** -- `git rm --cached` (verify seed data scripts first)
2. **Untrack generated output** -- `git rm --cached -r output/`
3. **Consolidate shadcn stubs** -- verify components.json, then remove components/ui/button.tsx and lib/utils.ts
4. **Rename PII employee photos** -- rename personal-name files to HR_ID format
5. **Update local Windows paths** in remaining docs (attendance-agent README, audit doc)

---

## N) Future Phase 3 Cleanup Actions (Requires Planning)

1. **Migrate employee photos to Supabase Storage** -- requires app code changes
2. **Git history rewrite** -- use BFG or git-filter-repo to purge binary data from history (reduces clone size permanently). Requires coordinated force-push.
3. **Branch naming convention** -- rename `codex/` prefix to neutral `dev/` or `feature/`. Requires CI + Vercel config updates.
4. **Add Dependabot** -- `.github/dependabot.yml` for automated dependency scanning
5. **Add branch protection rules** -- require PR reviews and CI passage for main
6. **Pre-commit hooks** -- install husky + lint-staged for local enforcement
7. **Optimize large brand PNGs** -- sidebar logo is 2.2 MB, could be compressed
8. **Archive old planning docs** -- move completed plans to docs/archive/
