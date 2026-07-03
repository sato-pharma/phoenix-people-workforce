import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for the attendance passport
 * (src/lib/attendance/attendance-passport.ts): one employee's complete
 * digest + settlement + missing-punch history in a single read-only view.
 */
export function runAttendancePassportTests() {
  const service = readFileSync("src/lib/attendance/attendance-passport.ts", "utf8");

  // 1. Employee lookup uses the safe multi-candidate HR_ID matcher, never a
  //    raw case-sensitive .eq() — a known recurring bug class in this repo.
  assert.match(
    service,
    /\.in\("hr_id", hrIdLookupKeys\(employeeHrId\)\)/,
    "employee lookup must use hrIdLookupKeys, not a raw case-sensitive equality match",
  );

  // 2. Settlement history is reused from the audit ledger, not re-queried —
  //    one source of truth for the immutable settlement record.
  assert.match(service, /await listSettlementLedger\(\{ employeeHrId: hrId \}\)/, "passport settlements must reuse listSettlementLedger, not a bespoke query");

  // 3. Stats are derived from the fetched data, not a separate aggregate
  //    query that could drift from what's actually displayed.
  assert.match(service, /disputeUpheld \+ disputeRejected/, "dispute stats must be derived from the same settlement rows shown to the user");

  // 4. The API route allows the employee to view their own passport, in
  //    addition to admin access — this is meant to double as a self-service
  //    history, not an admin-only tool.
  const route = readFileSync("app/api/attendance/passport/[hrId]/route.ts", "utf8");
  assert.match(route, /hrIdsMatch\(access\.hrId, hrId\)/, "the passport route must allow an employee to view their own record via hrIdsMatch");
  assert.match(route, /if \(!isSelf && !isAdmin\)/, "the passport route must gate on self-OR-admin, not admin-only");

  const detailPage = readFileSync("app/(admin)/attendance/passport/[hrId]/page.tsx", "utf8");
  assert.match(detailPage, /hrIdsMatch\(access\.hrId, hrId\)/, "the passport detail page must apply the same self-OR-admin gate as the API route");

  // 5. Registered in the access registry.
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.ok(registry.includes('pattern: "/api/attendance/passport/:hrId"'), "access registry must contain an entry for /api/attendance/passport/:hrId");
}
