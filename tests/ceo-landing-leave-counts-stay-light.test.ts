import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

/**
 * The executive landing's Leave tiles read two counts — requests waiting per stage, and requests
 * overdue against the SLA. They used to come from `getVacationReportData(access, { status: "all" })`,
 * which enriches every leave request ever filed and builds every employee's entitlement balance:
 * 11.7 s measured on 2026-09-21, the slowest read behind /admin, for two numbers.
 *
 * `getVacationPendingApprovalCounts` enriches only the PENDING rows, through the same
 * `enrichVacationRows`, and both it and the full report count through ONE helper — so the tiles
 * and the leave report cannot disagree. Measured identical on production the same day
 * (8 waiting on HR, 4 overdue). This pins all three halves.
 */

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected to find ${signature}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `expected ${signature} to close`);
  return source.slice(start, end);
}

export function runCeoLandingLeaveCountsStayLightTests() {
  const ceo = readFileSync("src/lib/ceo/command-center.ts", "utf8");
  assert.ok(
    !ceo.includes("getVacationReportData("),
    "the CEO / System Administrator landing must not build the whole leave report for two counts",
  );
  // Since 27 Nov 2026 the landing counts only the viewer's OWN turn (owner: every approval number
  // counts only what waits on you), through the sidebar badge's own light read.
  assert.ok(
    ceo.includes("getVacationAwaitingBadge(access)"),
    "the landing's Leave tiles must read the viewer's-turn badge count, getVacationAwaitingBadge",
  );
  assert.ok(
    !ceo.includes("getVacationPendingApprovalCounts("),
    "the landing must not read the company's whole pending queue for its Leave tiles",
  );

  const vacation = readFileSync("src/lib/vacation/service.ts", "utf8");
  const light = functionBody(vacation, "export async function getVacationPendingApprovalCounts(");
  assert.ok(light.includes("isPendingVacationStatus(row.status)"), "only pending rows may be enriched");
  assert.ok(
    light.includes("countVacationPendingApprovals(await enrichVacationRows(pendingRows))"),
    "the SLA verdict must come from enrichVacationRows, never mapVacationRow's default settings",
  );
  assert.ok(light.includes("canSeeVacation(access, row, visibleEmployeeHrIds)"), "the light path keeps the report's row scope");
  assert.ok(light.includes(`assertPermission(access, "leave", "read")`), "the light path keeps the report's permission gate");

  const dashboard = functionBody(vacation, "function buildVacationDashboardData(");
  assert.ok(
    dashboard.includes("...countVacationPendingApprovals(rows)"),
    "the full report must count through the same helper as the landing tiles",
  );
}
