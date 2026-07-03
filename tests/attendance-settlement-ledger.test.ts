import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for the exportable audit ledger
 * (src/lib/attendance/settlement-ledger.ts): a flat, read-only view over the
 * immutable attendance_settlements table, capped and filterable, feeding the
 * admin dashboard's date-ranged XLSX export.
 */
export function runAttendanceSettlementLedgerTests() {
  const service = readFileSync("src/lib/attendance/settlement-ledger.ts", "utf8");

  // 1. Read-only over the immutable ledger table — never inserts/updates it.
  assert.doesNotMatch(
    service,
    /\.insert\(|\.update\(|\.delete\(/,
    "the ledger view must be strictly read-only over attendance_settlements",
  );

  // 2. Bounded query: no unbounded export that could exhaust memory or time out.
  assert.match(service, /\.limit\(MAX_LEDGER_ROWS\)/, "listSettlementLedger must cap rows read, not query unbounded");

  // 3. Optional employee filter normalizes the HR_ID before filtering, matching
  //    the codebase-wide rule against raw hr_id string comparison.
  assert.match(
    service,
    /normalizeAttendanceHrId\(query\.employeeHrId\)/,
    "employee filter must normalize the HR_ID before querying, not compare raw strings",
  );

  // 4. Date-range filters are applied server-side (not left to the client to
  //    slice), so the export cap can't be trivially bypassed by paging.
  assert.match(service, /\.gte\("work_date", query\.dateFrom\)/, "dateFrom must filter server-side via work_date");
  assert.match(service, /\.lte\("work_date", query\.dateTo\)/, "dateTo must filter server-side via work_date");

  // 5. The API route requires the same attendance-setup read permission as
  //    the dashboard it's attached to — no separate, looser gate.
  const route = readFileSync("app/api/attendance/settlement-ledger/route.ts", "utf8");
  assert.match(route, /assertAttendanceSetupPermission\(access, "read"\)/, "ledger route must require attendance-setup read permission");

  // 6. Registered in the access registry as read-only (GET only, no CSRF
  //    requirement needed since it never mutates).
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.ok(registry.includes('pattern: "/api/attendance/settlement-ledger"'), "access registry must contain an entry for /api/attendance/settlement-ledger");

  // 7. The dashboard view exports via the shared, reusable XLSX button/endpoint
  //    rather than a bespoke export builder.
  const view = readFileSync("src/components/attendance/settlement-dashboard-view.tsx", "utf8");
  assert.match(view, /import \{ ExportXlsxButton \} from "@\/components\/ui\/export-xlsx-button";/, "ledger export must reuse the shared ExportXlsxButton, not a bespoke download path");
}
