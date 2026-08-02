import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeFeedbackSla } from "../src/lib/probation/intelligence/feedback-sla.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

// Regression guards for the ROUND-2 pre-merge audit findings (R1–R10).
export function runProbationAuditFixesRound2Tests() {
  const sla = { dueHours: 24, escalateHours: 48, overdueHours: 72 };

  // ── R5: a DV-Day whose field date is long past but which was just synced must NOT be born overdue ──
  const now = "2026-05-10T00:00:00.000Z";
  // No floor → anchored at the old field day → overdue.
  assert.equal(computeFeedbackSla("2026-05-01", now, sla).state, "overdue", "R5: without a floor, an old field day is overdue");
  // Floor = created today → the evaluator gets the full window → pending, not overdue.
  const floored = computeFeedbackSla("2026-05-01", now, sla, "2026-05-10T00:00:00.000Z");
  assert.equal(floored.state, "pending", "R5: SLA anchored at createdAt gives the full window (not born overdue)");
  // A floor OLDER than the field day is ignored (field day wins) — still overdue.
  assert.equal(computeFeedbackSla("2026-05-01", now, sla, "2026-04-01T00:00:00.000Z").state, "overdue", "R5: floor never shortens the window");

  // ── R1 BLOCKER: DV capture scopes CRM with casing variants (lowercase case keys vs uppercase CRM) ──
  const dvSync = src("src/lib/probation/intelligence/dv-sync.ts");
  assert.match(dvSync, /flatMap\(\(k\) => \[k, k\.toUpperCase\(\), k\.toLowerCase\(\)\]\)/, "R1: case keys widened to casing variants for the CRM/employees .in filters");

  // ── R2: SFE Manager holds probation:read so the assessment route/middleware admit them ──
  const perms = src("src/lib/auth/permissions.ts");
  assert.match(perms, /"SFE Manager":\s*\{[\s\S]*?probation:\s*\["read"\][\s\S]*?\}/, "R2: SFE Manager has probation:[read]");

  // ── R3: go-live backfill also runs a full-history DV sync (confirm mode) ──
  const backfill = src("app/api/probation/backfill/route.ts");
  assert.match(backfill, /syncProbationDvDays\(getSupabaseAdmin\(\), \{ dateFrom, dateTo \}\)/, "R3: backfill reconstructs DV history");
  assert.match(backfill, /HISTORY_LOOKBACK_DAYS = 95/, "R3: history window covers the full probation span");

  // ── R4: dev-action mutation gated on decision authority, not a read/view predicate ──
  const devRoute = src("app/api/probation/development-actions/[id]/route.ts");
  assert.match(devRoute, /if \(!canDecideProbation\(access\)\)/, "R4: dev-action write gated on decision authority");
  assert.doesNotMatch(devRoute, /if \(!canReadAllProbation\(access\)\)/, "R4: no longer gated on the read predicate");

  // R6 (DV-snapshot recency guard) and R10 (per-case try/catch in the milestone sweep) both lived
  // in probation-emails.ts, deleted 2026-08-02 once the sweeps were retired and all three of the
  // module's exports were left uncalled.

  // ── R7: legacy reminder suppressed for employees decided in the new module ──
  const service = src("src/lib/probation/service.ts");
  assert.match(service, /decidedByNewModule/, "R7: legacy reminder skips new-module-decided employees");

  // ── R8: decision panel refreshes the report after a successful write ──
  const panel = src("src/components/probation/probation-decision-panel.tsx");
  assert.match(panel, /router\.refresh\(\)/, "R8: decision refreshes the server report");

  // ── R9: report header uses a fixed 90-day denominator ──
  const view = src("src/components/probation/consolidated-report-view.tsx");
  assert.match(view, /Math\.min\(c\.currentProbationDay, 90\) : "—"\} of 90/, "R9: header shows 'of 90'");
}
