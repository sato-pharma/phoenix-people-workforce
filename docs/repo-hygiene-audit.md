# Repository Hygiene Audit

**Date:** 2026-05-30
**Status:** Documented -- pending owner approval for cleanup actions

This document catalogs tracked files that may affect repository quality, professionalism, or clone performance. No files have been deleted or moved. This is a reference for planned cleanup.

## Summary

| Category | Count | Total Size | Risk |
|---|---|---|---|
| Excel data files | 32 | ~47 MB | Medium |
| Employee photos | 127 | ~17 MB | Low-Medium |
| Development screenshots | 7 | ~2 MB | Low |
| Scratch/debug files at root | 6 | < 1 MB | Low |
| Stray root-level docs | 4 | < 1 MB | Low |
| Stray SQL file at root | 1 | < 1 MB | Low |
| Local tool artifacts | 4 | < 1 MB | Low |
| Duplicate source stubs | 2 | < 1 KB | Low |
| Tool-generated image | 1 | ~770 KB | Low |
| Generated output | 2 | ~2 MB | Low |

---

## Excel Data Files (32 files, ~47 MB)

### sato 4-2026/ directory (27 files, ~40 MB)

Largest files:
- `sato 4-2026/sales_database_foundation.xlsx` (6.2 MB)
- `sato 4-2026/sato_4_2026_master_database_codes.xlsx` through `v9` (9 versioned copies, ~3 MB each)
- `sato 4-2026/sato_4_2026_unified_standardization_layer.xlsx` (3.7 MB)
- 14 distributor data files (chimipharm, egd, epda, ibnsina, mec, overseas, ramco, sofico + tenders)
- 1 Arabic-named file

**Risk:** Medium -- business data permanently stored in git history, inflates clone size significantly.
**Recommendation:** `git rm --cached`, add to `.gitignore`, store in cloud storage or shared drive.
**Approval required:** Yes

### Root-level Excel files (5 files)

- `mabretelasafraRTDrequest.xlsx`
- `Outcome_VS_investment(Marchrequests)_2.xlsx`
- `Phoneix system template.xlsx`
- `phoenix products.xlsx` -- referenced by `scripts/seed-marketing-reference-data.ts`
- `Phoenix Pharmacy Database.xlsx` -- referenced by `scripts/seed-marketing-reference-data.ts`

**Risk:** Medium -- operational data in git. Two files are seed data used by scripts.
**Recommendation:** `git rm --cached`, add `*.xlsx` to `.gitignore`. Document alternative storage for seed data.
**Approval required:** Yes

### Generated output Excel files (2 files)

- `output/sales-template-analysis/overseas-ps-pos-reference.xlsx`
- `output/sales-template-analysis/overseas-ps-pos-reference-corrected.xlsx`

**Risk:** Low -- generated analysis output should not be tracked.
**Recommendation:** `git rm --cached`, `output/` already added to `.gitignore`.
**Approval required:** Yes

---

## Employee Photos (127 files, ~17 MB)

**Location:** `public/images/hr/`
**Filenames:** HR_ID format (e.g., `A-1.jpg`, `B-12.jpeg`) -- not personal names, reducing PII risk.
**Purpose:** Served as public static assets for employee profile display.

**Risk:** Low-Medium -- employee photos in git history. Binary data permanently inflates repo size. Photos are currently served via Next.js `/public/` static serving.
**Recommendation:** Future migration to Supabase Storage with access control. Requires application code changes to serve from storage instead of `/public/`. Not a Phase 1 task.
**Approval required:** Yes (separate initiative)

---

## Development Screenshots (7 files, ~2 MB)

Located in a local tool output directory. Contains login page screenshots at various viewport sizes captured during development verification:

- `login-desktop-1280x720.png`
- `login-fixed-desktop-1280x720.png`
- `login-fixed-mobile-390x844.png`
- `login-laptop-1366x768.png`
- `login-mobile-390x844.png`
- `login-verified-desktop-1280x720.png`
- `login-verified-mobile-390x844.png`

**Risk:** Low -- dev screenshots with no production purpose.
**Recommendation:** `git rm --cached`, directory already added to `.gitignore`.
**Approval required:** Yes

---

## Scratch / Debug Files at Root (6 files)

| File | Purpose |
|---|---|
| `check-query.js` | Debug database query script |
| `no-data-check.js` | Debug data check script |
| `proxy.ts` | Dev proxy helper for preview read-only guard |
| `start-dev.ps1` | PowerShell dev start script |
| `skills-lock.json` | Development tool lock file |
| `ChatGPT Image May 22, 2026, 05_14_54 PM.png` | Tool-generated image (~770 KB) |

**Risk:** Low -- clutter at repo root, unprofessional first impression on GitHub.
**Recommendation:** Move useful scripts to `scripts/`, `git rm --cached` the rest. `skills-lock.json` already added to `.gitignore`.
**Approval required:** Yes

---

## Root-Level Documents (4 files)

| File | Content |
|---|---|
| `AUDIT-2026-05-09.md` | Security audit report (contains local Windows paths) |
| `PAYROLL_PAYSLIPS_DETAILED.md` | Detailed payroll technical guide |
| `SYSTEM_OVERVIEW.md` | System overview document |
| `TODO.md` | Task tracking list |

**Risk:** Low -- misplaced at root, should be in `docs/` for organization.
**Recommendation:** Move to `docs/` for better organization.
**Approval required:** Yes

---

## Stray SQL File at Root (1 file)

- `20260511_add_missing_employee_fields.sql`

**Risk:** Low -- may cause confusion about migration location. Should be in `supabase/` or `supabase/migrations/`.
**Recommendation:** Move to `supabase/` if historical, or `supabase/migrations/` if active.
**Approval required:** Yes

---

## Local Tool Artifacts (4 files)

| File | Purpose |
|---|---|
| `memory/MEMORY.md` | Local development notes index |
| `memory/email-testing-redirect-mode.md` | Local development notes |
| `trae/Supabase MCP Configuration Error.md` | IDE troubleshooting log (contains local paths) |
| `.trae/rules/codex 2 trae.md` | IDE configuration file |

**Risk:** Low -- no production purpose. Contains local Windows paths.
**Recommendation:** `git rm --cached`, directories already added to `.gitignore`.
**Approval required:** Yes

---

## Duplicate Source Stubs (2 files)

- `components/ui/button.tsx` -- shadcn/ui stub duplicating `src/components/ui/`
- `lib/utils.ts` -- utility stub duplicating `src/lib/`

These were likely created by shadcn CLI initialization and duplicate the real source paths under `src/`.

**Risk:** Low -- may cause import confusion.
**Recommendation:** Verify `components.json` path configuration, consolidate into `src/` paths.
**Approval required:** Yes

---

## Hardcoded Values (document only)

These are noted for future cleanup but were not changed in this phase:

- `src/config/system-settings.ts` -- contains hardcoded email addresses
- `next.config.ts` -- contains specific ngrok subdomain in `allowedDevOrigins`

**Risk:** Low -- email addresses visible in source, ngrok URL is internal dev config.
**Recommendation:** Move emails to environment variables in a future PR.
**Approval required:** Yes (future phase)

---

## .gitignore Improvements Applied

The following patterns were added to `.gitignore` to prevent future additions:

```
*.xlsx, *.csv, .codex-artifacts/, trae/, .trae/, memory/,
skills-lock.json, output/, supabase-export/,
Thumbs.db, .DS_Store, desktop.ini, *.swp, *.swo, *~, *.bak, .idea/
```

These patterns prevent new files from being tracked but do **not** remove already-tracked files. Removal requires a separate `git rm --cached` step with owner approval.
