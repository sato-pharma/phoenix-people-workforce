import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { reportPeriodMismatch } from "../src/lib/sales/sos-report-delivery.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// The CEO / Super Admin Executive BI Report (SoS re-measure 2026-09-18, #21). getSosDashboard
// answers a month with no validated sales with the NEWEST month instead. The sender checked only
// that SOME month came back, so asking for December 2025 would have emailed September 2026's
// workbook and figures, named `phoenix-sos-dashboard_2025-12.xlsx`, and spent December's once-only
// send key on it. The report now refuses unless the dashboard answered for exactly that month.
export function runSosReportPeriodTests() {
  // ── The dashboard answered for the month asked: send ──
  assert.equal(
    reportPeriodMismatch("2026-08", { period: "2026-08", selectedPeriods: ["2026-08"] }),
    null,
    "a report for a month with its own data goes out",
  );

  // ── The dashboard fell back to the newest month: refuse, and say which month in words ──
  const fellBack = reportPeriodMismatch("2025-12", { period: "2026-09", selectedPeriods: ["2026-09"] });
  assert.ok(fellBack, "a month with no data must not be sent the newest month's workbook");
  assert.match(fellBack, /December 2025/, "the refusal names the month that was asked for");
  assert.match(fellBack, /September 2026/, "the refusal names the month the dashboard would have sent instead");
  assert.doesNotMatch(fellBack, /\d{4}-\d{2}/, "the refusal speaks in month names, not codes");

  // ── No data at all: refuse ──
  const nothing = reportPeriodMismatch("2025-12", { period: null, selectedPeriods: [] });
  assert.ok(nothing, "no data at all is no report");
  assert.match(nothing, /December 2025/, "the refusal names the month that was asked for");

  // ── A total over more than one month is not a one-month report, even if it leads with that month ──
  assert.ok(
    reportPeriodMismatch("2026-08", { period: "2026-08", selectedPeriods: ["2026-08", "2026-07"] }),
    "a two-month total must not go out as August's report",
  );

  // ── The sender checks before it builds, before it looks up recipients, and before it sends ──
  const source = readSource("../src/lib/sales/sos-report-delivery.ts");
  const body = source.slice(source.indexOf("export async function buildAndEmailSosBiReport"));
  const dashboardAt = body.indexOf("const data = await getSosDashboard(");
  const checkAt = body.search(/const wrongMonth = reportPeriodMismatch\(period, data\);\s*if \(wrongMonth\) \{\s*return \{ period, reason: wrongMonth, sent: false \};/);
  assert.ok(dashboardAt > 0, "the report still starts from getSosDashboard");
  assert.ok(
    checkAt > dashboardAt,
    "the report must refuse, right after reading the dashboard, when the dashboard answered for a different month",
  );
  for (const later of ["resolveCeoSuperAdminRecipients()", "buildSosBiWorkbook(", "sendTemplatedEmail("]) {
    const at = body.indexOf(later);
    assert.ok(at > checkAt, `${later} must come after the month check`);
  }

  // Every name the email carries comes from the one month that was checked.
  assert.match(body, /const periodLabel = periodProseLabel\(period\);/, "the subject names the month that was checked");
  assert.match(body, /filename: `phoenix-sos-dashboard_\$\{period\}\.xlsx`/, "the file is named for the month that was checked");
  assert.match(body, /idempotencyKey: `sos-bi-report:\$\{period\}`/, "the send key is the month that was checked");
  assert.doesNotMatch(body, /periodProseLabel\(data\.period\)/, "no label may come from whatever month the dashboard fell back to");
}
