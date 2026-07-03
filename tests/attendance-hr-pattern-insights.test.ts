import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for HR pattern insights
 * (src/lib/attendance/hr-pattern-insights.ts): aggregate, over-a-period
 * signals mined from the settlement ledger + missing-punch history —
 * informational only, never automated action.
 */
export function runAttendanceHrPatternInsightsTests() {
  const service = readFileSync("src/lib/attendance/hr-pattern-insights.ts", "utf8");

  // 1. Reuses the same ledger the audit-ledger export uses — one source of
  //    truth for "what happened", not a second parallel settlement query.
  assert.match(service, /await listSettlementLedger\(\{ dateFrom, dateTo \}\)/, "insights must reuse listSettlementLedger, not a bespoke settlement query");

  // 2. Repeat offenders only count REAL deductions (confirmed / auto-
  //    confirmed / dispute-rejected) — a dispute that was upheld (no
  //    deduction) must never inflate someone's repeat-offender count.
  assert.match(
    service,
    /entry\.action === "confirmed" \|\| entry\.action === "auto_confirmed" \|\| entry\.action === "dispute_rejected"/,
    "repeat-offender counting must exclude upheld disputes (no deduction happened)",
  );

  // 3. Weekday pattern excludes missing-punch lines (zero EGP, out of the
  //    settlement flow by design) — only late/short-hours count.
  assert.match(
    service,
    /entry\.lineStatus !== "late" && entry\.lineStatus !== "short_hours"/,
    "weekday pattern must exclude missing-punch lines, which carry no deduction",
  );

  // 4. Thresholds exist and are named, not magic numbers scattered through
  //    the filters — keeps the "what counts as a pattern" bar auditable.
  for (const constant of ["REPEAT_OFFENDER_MIN_COUNT", "NON_RESPONDER_MIN_TOTAL", "NON_RESPONDER_MIN_RATE", "DISPUTE_HEAVY_MIN_COUNT", "MISSING_PUNCH_REPEATER_MIN_COUNT"]) {
    assert.match(service, new RegExp(`const ${constant} = `), `${constant} must be a named, auditable threshold`);
  }

  // 5. Missing-punch repeaters use the same HR_ID normalization as the rest
  //    of the module, not a raw grouping key.
  assert.match(service, /normalizeAttendanceHrId\(row\.employee_hr_id\)/, "missing-punch grouping must normalize HR_IDs before counting");

  // 6. Registered as a read-only route.
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.ok(registry.includes('pattern: "/api/attendance/hr-pattern-insights"'), "access registry must contain an entry for /api/attendance/hr-pattern-insights");

  const route = readFileSync("app/api/attendance/hr-pattern-insights/route.ts", "utf8");
  assert.match(route, /assertAttendanceSetupPermission\(access, "read"\)/, "the insights route must require attendance-setup read permission");
  assert.doesNotMatch(route, /export async function POST|export async function PUT|export async function DELETE/, "HR pattern insights must stay read-only — no mutation endpoint");
}
