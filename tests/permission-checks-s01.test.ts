import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GET as allSummaryGet } from "../app/api/attendance/employee-day-report/all-summary/route.ts";
import { GET as decisionsGet, POST as decisionsPost } from "../app/api/attendance/employee-day-report/decisions/route.ts";
import { POST as employeesPost } from "../app/api/employees/route.ts";
import { GET as roiRefreshGet, POST as roiRefreshPost } from "../app/api/marketing/roi-refresh/route.ts";
import { adminNavigationSections } from "../src/config/system-navigation.ts";
import {
  clearPermissionMatrixCache,
  createAccessContext,
  permissionMatrix,
  phoenixRoles,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { assertCanEditEmployeeRecord } from "../src/lib/employees/edit-scope.ts";

// The four routes below now assert a permission-matrix key on the server, beside the checks they
// already made. Every test here calls the REAL route handler through the dev-auth headers, with a
// stand-in database that records each call, and proves two things for every refusal: the answer is a
// refusal (401/403), and nothing was written.

const SUPABASE = "https://permission-checks.invalid";
const STAND_IN_SETTINGS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
  NODE_ENV: "development",
  PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true",
  SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-role-key",
};

type Seen = { method: string; path: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function withStandIn(
  rows: { employees?: Array<{ hr_id: string; manager_hr_id: string | null }> },
  run: (seen: Seen[]) => Promise<void>,
): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.keys(STAND_IN_SETTINGS).map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  const seen: Seen[] = [];
  Object.assign(env, STAND_IN_SETTINGS);
  clearPermissionMatrixCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    seen.push({ method, path: url.pathname });
    if (url.pathname === "/rest/v1/employees" && method === "GET") {
      const wanted = (url.searchParams.get("hr_id") ?? "").replace(/^eq\./, "");
      const match = (rows.employees ?? []).filter((row) => row.hr_id === wanted);
      // maybeSingle() asks for an object; answer the shape PostgREST gives it.
      const accept = (init.headers instanceof Headers ? init.headers.get("accept") : (init.headers as Record<string, string> | undefined)?.Accept ?? (init.headers as Record<string, string> | undefined)?.accept) ?? "";
      if (accept.includes("vnd.pgrst.object")) return match[0] ? json(200, match[0]) : json(406, { code: "PGRST116", message: "no rows" });
      return json(200, match);
    }
    if (method === "GET" || method === "HEAD") return json(200, []);
    return json(201, []);
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = realFetch;
    clearPermissionMatrixCache();
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

function call(method: "GET" | "POST", path: string, role: PhoenixRole | null, body?: unknown): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: "localhost:3000",
    origin: "http://localhost:3000",
  };
  if (role) {
    headers["x-phoenix-role"] = role;
    headers["x-phoenix-hr-id"] = "PREVIEW-NOBODY";
  }
  return new Request(`http://localhost:3000${path}`, {
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    headers,
    method,
  });
}

function writes(seen: Seen[]): Seen[] {
  return seen.filter((entry) => entry.method !== "GET" && entry.method !== "HEAD");
}

async function assertRefusedWithoutWrite(label: string, invoke: () => Promise<Response>) {
  await withStandIn({}, async (seen) => {
    const response = await invoke();
    assert.ok(
      response.status === 401 || response.status === 403,
      `${label}: must be refused (got ${response.status} ${await response.clone().text()})`,
    );
    assert.deepEqual(writes(seen), [], `${label}: a refused call must write nothing`);
  });
}

const holders = (resource: string, action: string) =>
  phoenixRoles.filter((role) => (permissionMatrix[role] as Record<string, string[] | undefined>)[resource]?.includes(action) ?? false);

export async function runPermissionChecksS01Tests() {
  // ── The audiences: nobody gained, nobody lost ────────────────────────────────────────────────
  assert.deepEqual(holders("deductions", "approve"), ["Super Admin"], "deductions:approve stays the Super Admin's alone");
  assert.deepEqual(
    [...holders("marketing_roi_refresh", "read")].sort(),
    ["CEO", "Super Admin"],
    "the Marketing ROI refresh is held by exactly the two roles the route has always admitted",
  );
  assert.deepEqual([...holders("marketing_roi_refresh", "update")].sort(), ["CEO", "Super Admin"]);

  // ── Fingerprint deductions on the Day-by-Day report ─────────────────────────────────────────
  const decisionBody = { dateIso: "2026-11-01", decisionStatus: "Approved for Payroll", days: 1, employeeHrId: "X-1" };
  const range = "?employeeHrId=X-1&dateFrom=2026-11-01&dateTo=2026-11-30";
  for (const role of [null, "Finance Manager", "CEO", "HR Operations", "District Manager", "Medical Rep"] as const) {
    const who = role ?? "no session";
    await assertRefusedWithoutWrite(`decisions POST (${who})`, () =>
      decisionsPost(call("POST", "/api/attendance/employee-day-report/decisions", role, decisionBody)));
    await assertRefusedWithoutWrite(`decisions GET (${who})`, () =>
      decisionsGet(call("GET", `/api/attendance/employee-day-report/decisions${range}`, role)));
    await assertRefusedWithoutWrite(`all-summary GET (${who})`, () =>
      allSummaryGet(call("GET", "/api/attendance/employee-day-report/all-summary?dateFrom=2026-11-01&dateTo=2026-11-30", role)));
  }

  // ── Marketing ROI refresh ───────────────────────────────────────────────────────────────────
  for (const role of [null, "Marketing Manager", "Finance Manager", "HR Operations", "Product Manager", "Medical Rep"] as const) {
    const who = role ?? "no session";
    await assertRefusedWithoutWrite(`roi-refresh POST (${who})`, () =>
      roiRefreshPost(call("POST", "/api/marketing/roi-refresh", role) as never));
    await assertRefusedWithoutWrite(`roi-refresh GET (${who})`, () =>
      roiRefreshGet(call("GET", "/api/marketing/roi-refresh", role) as never));
  }
  // The refresh itself is a database function call: a refused POST must never reach it.
  await withStandIn({}, async (seen) => {
    await roiRefreshPost(call("POST", "/api/marketing/roi-refresh", "Marketing Manager") as never);
    assert.equal(seen.some((entry) => entry.path.includes("/rpc/")), false, "a refused refresh never calls the refresh function");
  });

  // The matrix key is asserted in the route itself, before the work — the role-name checks stay too.
  const pins: Array<[string, string, string]> = [
    ["app/api/attendance/employee-day-report/decisions/route.ts", `assertPermission(access, "deductions", "approve")`, "upsertAndDecideEmployeeDayDeduction({"],
    ["app/api/attendance/employee-day-report/all-summary/route.ts", `assertPermission(access, "deductions", "approve")`, "getAllEmployeesFingerprintDeductionsSummary({"],
    ["app/api/marketing/roi-refresh/route.ts", `assertPermission(access, "marketing_roi_refresh", "update")`, `supabase.rpc("phx_refresh_marketing_roi_facts"`],
    ["app/api/marketing/roi-refresh/route.ts", `assertPermission(access, "marketing_roi_refresh", "read")`, `.from("marketing_roi_refresh_runs")`],
  ];
  for (const [file, gate, work] of pins) {
    const source = readFileSync(file, "utf8");
    const gateAt = source.indexOf(gate);
    assert.ok(gateAt >= 0, `${file}: must assert ${gate}`);
    assert.ok(source.indexOf(work, gateAt) > gateAt, `${file}: ${gate} must come before ${work}`);
  }
  assert.match(readFileSync("app/api/marketing/roi-refresh/route.ts", "utf8"), /REFRESH_ALLOWED_ROLES\.has\(access\.role\)/, "the role check stays beside the key");

  // ── Employee record edits ───────────────────────────────────────────────────────────────────
  const editBody = { employee: { originalHrId: "T-1", hrId: "T-1", fullName: "Stand In" } };
  for (const role of [null, "Medical Rep", "District Manager", "Finance Manager", "CEO"] as const) {
    await assertRefusedWithoutWrite(`employees POST edit (${role ?? "no session"})`, () =>
      employeesPost(call("POST", "/api/employees", role, editBody)));
  }

  // The scope check itself. The three seats holding employees:update see the whole company, so they
  // are answered WITHOUT a read and are never refused here.
  for (const role of ["Super Admin", "HR Operations", "HR Administration"] as const) {
    await withStandIn({}, async (seen) => {
      await assertCanEditEmployeeRecord(createAccessContext({ hrId: "E-9", role }), "T-1");
      assert.equal(seen.length, 0, `${role}: the edit scope is answered without a database read`);
    });
  }
  // A narrower seat reaches only a person it can see: its direct report passes, anyone else is refused.
  const manager = createAccessContext({ hrId: "M-1", role: "District Manager" });
  await withStandIn({ employees: [{ hr_id: "T-1", manager_hr_id: "M-1" }, { hr_id: "T-2", manager_hr_id: "M-9" }] }, async () => {
    await assertCanEditEmployeeRecord(manager, "T-1");
    await assert.rejects(
      () => assertCanEditEmployeeRecord(manager, "T-2"),
      /^Error: Forbidden: you do not have access to this employee\.$/,
      "HEADLINE: an edit to someone outside the editor's directory is refused",
    );
    await assert.rejects(() => assertCanEditEmployeeRecord(manager, "NOT-THERE"), /Forbidden/, "an unknown record is refused, never let through");
  });

  // The route runs the scope check on every EDIT, after the permission and before the save.
  const employeesRoute = readFileSync("app/api/employees/route.ts", "utf8");
  const postBody = employeesRoute.slice(employeesRoute.indexOf("export async function POST"));
  const permissionAt = postBody.indexOf(`assertPermission(access, "employees", "update")`);
  const scopeAt = postBody.indexOf("assertCanEditEmployeeRecord(access, payload.employee.originalHrId)");
  const saveAt = postBody.indexOf("upsertEmployee(");
  assert.ok(permissionAt >= 0 && scopeAt > permissionAt && saveAt > scopeAt, "employees POST: permission, then scope, then the save");

  // ── The dead navigation grant is gone, and the rows still exclude the Finance Manager ──────────
  const approvalRows = adminNavigationSections
    .flatMap((section) => section.items)
    .filter((item) => item.href === "/admin/approvals/vacation" || item.href === "/admin/approvals/excuse");
  assert.equal(approvalRows.length, 2, "both admin approval rows are still in the sidebar");
  for (const row of approvalRows) {
    assert.equal((row.roles as readonly string[] | undefined)?.includes("Finance Manager") ?? false, false, `${row.label}: no Finance Manager in roles`);
    assert.ok((row.excludedRoles as readonly string[] | undefined)?.includes("Finance Manager"), `${row.label}: excludedRoles still names the Finance Manager`);
  }
}
