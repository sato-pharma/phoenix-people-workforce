import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for the device-outage fail-safe: a company-wide fingerprint
 * sync outage must never become a false missing-punch line or a false
 * field-punch-anomaly flag. Entirely Supabase-backed detection
 * (getCompanyWideOutageDates in ingestion-health.ts), so — matching this
 * module's established pattern — pinned via source inspection; the pure
 * gating logic itself (reconcileDay's deviceOutage branch) has real behavioral
 * coverage in attendance-reconcile-day.test.ts.
 */
export function runAttendanceDeviceOutageFailsafeTests() {
  const ingestionHealth = readFileSync("src/lib/attendance/ingestion-health.ts", "utf8");

  // 1. The outage signal must be company-wide (zero punches for ANYONE), not
  //    per-employee — a single employee having no punch is normal (that's
  //    what missing-punch verification is for); only "nobody at all punched
  //    on an expected working day" is strong enough to trust as an outage.
  assert.match(
    ingestionHealth,
    /export async function getCompanyWideOutageDates/,
    "the outage detector must exist and be exported",
  );
  assert.match(
    ingestionHealth,
    /datesWithAnyPunch\.has\(dateIso\)/,
    "outage dates must be computed from whether ANY punch exists that day, not scoped to one employee",
  );
  assert.match(
    ingestionHealth,
    /isExpectedWorkingDay/,
    "only expected working days are candidates — a silent weekend/holiday is normal, not an outage",
  );

  // 2. The pure gate treats it as a universal cancel, before either tier's
  //    judge/flag logic — see digest-reconcile.ts's own ordering.
  const reconcile = readFileSync("src/lib/attendance/digest-reconcile.ts", "utf8");
  const universalCancelsBlock = reconcile.slice(reconcile.indexOf("Universal cancels"), reconcile.indexOf("if (input.tier"));
  assert.match(
    universalCancelsBlock,
    /if \(input\.deviceOutage\) return \{ action: "skip"/,
    "deviceOutage must be checked among the universal cancels, before any tier-specific judge/flag logic",
  );
}
