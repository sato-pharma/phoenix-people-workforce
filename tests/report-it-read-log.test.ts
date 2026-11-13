import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ApiRateLimitError } from "@/lib/security/api-rate-limit";
import { reportItJsonError } from "@/lib/report-it/http";
import {
  boundedReportPage,
  REPORT_IT_MAX_PAGE,
  REPORT_IT_MAX_PAYLOAD_BYTES,
  reportPayloadRefusal,
} from "@/lib/report-it/service";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/**
 * Report It: every read of a safety report leaves a log row or is refused, the read-all list is
 * changed only by `report_it:export` holders and only through the one audited function, a report
 * must have its shape before it is stored, and a list read is bounded. Nothing here touches a
 * database — the suite runs with production credentials.
 */
export async function runReportItReadLogTests() {
  // ── The payload check ──────────────────────────────────────────────────────
  assert.equal(reportPayloadRefusal(null), "Missing report payload.");
  assert.equal(reportPayloadRefusal([]), "Missing report payload.");
  assert.equal(reportPayloadRefusal({ medicines: [] }), "The report must list the reactions.");
  assert.equal(reportPayloadRefusal({ reactions: [] }), "The report must list the medicines.");
  assert.equal(reportPayloadRefusal({ reactions: ["x"], medicines: [] }), "A reaction entry is not readable.");
  assert.equal(reportPayloadRefusal({ reactions: [], medicines: [null] }), "A medicine entry is not readable.");
  assert.equal(reportPayloadRefusal({ reactions: [{}], medicines: [{}] }), null, "a well-formed report passes");
  assert.equal(
    reportPayloadRefusal({ reactions: [{ note: "x".repeat(REPORT_IT_MAX_PAYLOAD_BYTES) }], medicines: [] }),
    "The report is too large.",
  );

  // ── The page bound ─────────────────────────────────────────────────────────
  assert.deepEqual(boundedReportPage({}), { limit: 50, offset: 0 });
  assert.deepEqual(boundedReportPage({ limit: 100_000, offset: 0 }), { limit: REPORT_IT_MAX_PAGE, offset: 0 });
  assert.deepEqual(boundedReportPage({ limit: 0, offset: -5 }), { limit: 1, offset: 0 });
  assert.deepEqual(boundedReportPage({ limit: Number.NaN, offset: Number.NaN }), { limit: 50, offset: 0 });
  assert.deepEqual(boundedReportPage({ limit: 20.7, offset: 40.2 }), { limit: 20, offset: 40 });

  // ── The error answers ──────────────────────────────────────────────────────
  assert.equal(reportItJsonError(new Error("Forbidden: no"), "x").status, 403);
  assert.equal(reportItJsonError(new Error("Unavailable: not recorded"), "x").status, 503);
  assert.equal(reportItJsonError(new Error("Authentication is required."), "x").status, 401);
  assert.equal(reportItJsonError(new ApiRateLimitError("Too many", 60), "x").status, 429);
  assert.equal(reportItJsonError(new Error("Validation: bad"), "x").status, 400);

  // ── A read that cannot be logged is refused ────────────────────────────────
  const service = code("src/lib/report-it/service.ts");
  const logBody = service.slice(service.indexOf("export async function logReportRead"), service.indexOf("export type ReportItAccessGrant"));
  assert.match(logBody, /from\("report_it_audit_logs"\)[\s\S]*\.insert\(/, "the read log writes report_it_audit_logs");
  assert.match(logBody, /if \(error\) \{[\s\S]*throw new Error\("Unavailable:/, "a failed log write refuses the read");
  const getReportBody = service.slice(service.indexOf("export async function getReport("), service.indexOf("export async function logReportRead"));
  const logAt = getReportBody.indexOf("logReportRead(");
  assert.ok(
    logAt > getReportBody.indexOf(".single()") && logAt < getReportBody.indexOf("return report;"),
    "opening a report is logged after it is read and before it is returned",
  );
  const listBody = service.slice(service.indexOf("export async function listReports"), service.indexOf("export const REPORT_IT_MAX_PAGE"));
  assert.match(listBody, /logReportRead\(access, \{\s*action: "reports_listed"/, "a list read is logged");

  // ── The read-all list: export holders only, one audited function ──────────
  for (const fn of ["getDashboardAccessOverview", "setDashboardAccess", "listGrantableEmployees"]) {
    const start = service.indexOf(`export async function ${fn}`);
    assert.ok(start >= 0, `${fn} exists`);
    const body = service.slice(start, start + 600);
    assert.match(body, /await assertPermission\(access, "report_it", "export"\)/, `${fn} asserts report_it export first`);
  }
  assert.match(service, /rpc\("phx_report_it_set_dashboard_access"/, "the change and its audit row are one transaction");
  assert.doesNotMatch(
    service,
    /from\("report_it_dashboard_access"\)\s*\.(insert|upsert|delete|update)\(/,
    "nothing writes the read-all list except the audited function",
  );

  // ── Each route checks the session and the permission before acting ────────
  const routes: Array<[string, string, string]> = [
    ["app/api/report-it/submit/route.ts", "create", "submitReport("],
    ["app/api/report-it/list/route.ts", "read", "listReports("],
    ["app/api/report-it/[id]/route.ts", "read", "getReport("],
    ["app/api/report-it/access/route.ts", "export", "setDashboardAccess("],
  ];
  for (const [path, action, call] of routes) {
    const route = code(path);
    const guest = route.indexOf("reportItSignedOut()");
    const gate = route.indexOf(`assertPermission(access, "report_it", "${action}")`);
    assert.ok(guest >= 0, `${path} refuses a signed-out call`);
    assert.ok(gate > guest, `${path} asserts report_it ${action}`);
    assert.ok(route.indexOf(call) > gate, `${path} calls ${call} only after the permission check`);
  }
  assert.match(code("app/api/report-it/access/route.ts"), /assertSameOriginMutation\(request\)/, "the access change is CSRF-checked");
  assert.match(code("app/api/report-it/submit/route.ts"), /assertApiRateLimit\(/, "filing is rate-limited");

  // ── The migration keeps the function off the browser roles ────────────────
  const migration = stripSqlComments(
    readFileSync("supabase/migrations/20261113160815_report_it_dashboard_access_audited.sql", "utf8"),
  );
  assert.match(migration, /revoke (all|execute)[^;]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute[^;]*to service_role/i);
  assert.doesNotMatch(migration, /security definer/i, "the function runs as its caller");
}
