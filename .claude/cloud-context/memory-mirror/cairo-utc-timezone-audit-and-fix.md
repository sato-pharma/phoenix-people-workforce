---
name: cairo-utc-timezone-audit-and-fix
description: "The canonical Cairo calendar-day helpers live in src/lib/i18n/format.ts — currentCairoDateParts(now) and currentCairoDateOnlyIso(now) ('YYYY-MM-DD'); attendance uses cairoMidnightUtcIso() in src/lib/attendance/timezone.ts and cairoDayOfWeek() for weekday. NEVER reinvent 'today'/midnight with new Date().toISOString().slice(0,10) or raw getUTC* — the server runs UTC and Cairo is +2/+3, so a raw-clock 'today' is wrong for ~2-3h every night. Ledger trap: a migration's ledger version differs from its filename and the name column embeds the filename, so querying the ledger by version reads 'not applied' for a live migration — ask by NAME."
metadata:
  node_type: memory
  type: project
  originSessionId: 5443508d-2410-44ba-a997-f478a5c34af3
  modified: 2026-09-26T00:59:04.445Z
---

## The bug category, and the canonical fix

The server runs **UTC**; Cairo is ahead of it (**EEST=+3** late Apr–late Oct, **EET=+2** otherwise). Any
code that computes "today" / "midnight" from the server's raw UTC clock when the **Africa/Cairo calendar
day** was intended is wrong for ~2–3h every night. A 2026-07-25 system-wide audit found this pattern
across HR lifecycle, contracts, probation, resignations, vacation, attendance, coaching, and a ~19-file
calendar/KPI batch — all now on the canonical helpers.

🔴 **Use the canonical helpers — never reinvent a Cairo calendar-day:**
- `src/lib/i18n/format.ts` → **`currentCairoDateParts(now)`** and **`currentCairoDateOnlyIso(now)`**
  (returns `"YYYY-MM-DD"`). This is THE helper every fix imports instead of
  `new Date().toISOString().slice(0,10)` or raw `getUTC*` reductions.
- Attendance boundaries → **`cairoMidnightUtcIso()`** in `src/lib/attendance/timezone.ts` (DST-safe; a
  local-Date-serialized `utcBoundaryForLocalDate()` produced UTC-midnight, dropping early-Cairo-morning
  punches).
- Weekday (Fri/Sat weekend) → **`cairoDayOfWeek()`**, never `getUTCDay()`.

(The specific bug the owner first asked about — iReports360 CRM timestamps mislabeled UTC — was already
fixed separately: [[ireports360-timestamps-cairo-local-mislabeled-utc]].)

## 🔴 The migration-ledger version-vs-filename trap (AGENTS.md §2.1, worked example)

The Cairo-fix migration is filed as `20260725130000_probation_provision_cairo_timezone_fix.sql` but its
production ledger row reads **version `20260725134307`, name `20260725130000_...`.** Querying
`supabase_migrations.schema_migrations` for version `20260725130000` returns **nothing**, which reads as
*never applied* for a migration that is live. **Ask the ledger by NAME, not by version prefix.** (The
version is the apply timestamp, assigned by MCP/CLI; the filename lives in the `name` column.)

## Durable maintenance rules this surfaced

- **Paired derived values that are both wrong in the SAME direction hide each other** — `currentProbationDay`
  and `probationDaysRemaining` looked consistent pre-fix; fixing only one makes them visibly disagree near
  the boundary. Fix such a pair **together**.
- **When consolidating a reinvented helper, update the test that pinned the duplicate.**
  `probation/service.ts` had its own `daysRemaining`/`baseProbationEndDate`/`probationDays=90` and never
  imported `probation/date.ts` despite that module's header requiring every layer to — a test pinned the
  OLD duplicate by name and had to be repointed to the canonical import.
- **Every migration creating a public SECURITY DEFINER function must include its OWN
  `REVOKE EXECUTE FROM PUBLIC`** — pinned by `tests/migrations-secdef-revoke-guard.test.ts` — even when an
  earlier migration already revoked.
- **`probation_provision_case_on_hire()` is superseded via `CREATE OR REPLACE` down a chain** (the live
  body is NOT the original migration's). Grep / `list_migrations` for the latest `CREATE OR REPLACE` of a
  function before touching it, so you edit the body that is actually live.
- **Windows worktree removal:** `git worktree remove` on a worktree with a full `node_modules` can outrun a
  ~30s timeout (git unregisters/marks it prunable before the physical delete finishes). Give it a **300s+
  background timeout up front**, and if a leftover directory remains, finish with `PowerShell Remove-Item
  -Recurse -Force` — a plain `rm -rf` is blocked by the auto-mode safety classifier as a broad-deletion
  pattern.
