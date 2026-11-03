import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { permissionMatrix, phoenixRoles } from "../src/lib/auth/permissions.ts";

// The Database Validation tab's customer map -- every active customer the company sells to,
// nationally, with name and address (72,040 rows on production 2026-09-18) -- was served by two
// routes whose only gate was a permission check: the list asserted sales:read and the export
// sales:export. The base Employee and Medical Rep roles hold both, so any signed-in employee could
// pull the whole list or download it as a workbook. The only page that calls them,
// app/(admin)/sales/database-mapping/page.tsx, was Super Admin only; the routes behind it were not.
// Source of Sales re-measure 2026-09-18, finding #18. Same defect class as the master workbook
// export, pinned in public-sales-exposure-guards.test.ts.

/**
 * The same gate on the page, whatever it names its access context (the page says `accessContext`,
 * the routes say `access`), followed by the redirect that turns everyone else away.
 */
const PAGE_SUPER_ADMIN_ONLY_GATE =
  /if \((\w+)\.role !== "Super Admin" && \1\.scope !== "system"\) \{\s*redirect\(/;

/**
 * The guard AND its refusal: the literal alone would also match a guard that only logs. `[^;]` keeps
 * the 403 inside the guard's own return statement, never the catch block's further down.
 */
const REFUSING_GUARD =
  /if \(access\.role !== "Super Admin" && access\.scope !== "system"\) \{\s*return NextResponse\.json\([^;]*?\{ status: 403 \}/;

const ROUTES = [
  { action: "read", file: "app/api/sales/database-mapping/validation/customer-map/route.ts" },
  { action: "export", file: "app/api/sales/database-mapping/validation/customer-map/export/route.ts" },
] as const;

const PAGE = "app/(admin)/sales/database-mapping/page.tsx";
const FINDER_ROUTE = "app/api/sales/mapping-database/address-findings/route.ts";

function source(file: string) {
  return readFileSync(file, "utf8");
}

/** Every route file under app/api that calls listCustomerMap( itself. */
function routesReadingTheCustomerMap(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync("app/api", { recursive: true }) as string[]) {
    const file = path.posix.join("app/api", entry.split(path.sep).join("/"));
    if (!file.endsWith("/route.ts")) continue;
    if (/\blistCustomerMap\(/.test(source(file))) found.push(file);
  }
  return found.sort();
}

export function runCustomerMapReadGateTests() {
  // --- 1. the premise, measured from the permission list rather than assumed -----------------
  // If a later change took sales:read / sales:export away from the base roles, the role gate would
  // still be right, but this comment block would be stale; fail loudly so someone re-reads it.
  for (const { action } of ROUTES) {
    const holders = phoenixRoles.filter(
      (role) => role !== "Super Admin" && (permissionMatrix[role]?.sales ?? []).includes(action),
    );
    for (const role of ["Employee", "Medical Rep"] as const) {
      assert.ok(
        holders.includes(role),
        `expected ${role} to hold sales:${action} -- that grant is why the customer-map routes need a role gate on top of assertPermission`,
      );
    }
  }

  // --- 2. each route refuses a non-admin before it reads a single customer --------------------
  for (const { action, file } of ROUTES) {
    const route = source(file);
    const guard = REFUSING_GUARD.exec(route);
    assert.ok(
      guard,
      `${file} must refuse every role but Super Admin (or system scope) with a 403 -- assertPermission(sales, ${action}) alone admits the base Employee and Medical Rep roles to the whole national customer map`,
    );
    const readIndex = route.indexOf("listCustomerMap(");
    assert.ok(readIndex !== -1, `${file} no longer calls listCustomerMap( -- re-point this test at what it reads now`);
    assert.ok(
      guard.index < readIndex,
      `${file}: the Super Admin gate must run BEFORE listCustomerMap -- a gate after the read has already loaded every customer`,
    );
    const permissionIndex = route.indexOf(`assertPermission(access, "sales", "${action}")`);
    assert.ok(permissionIndex !== -1, `${file} must still assert sales:${action} after the role gate`);
    const rateLimitIndex = route.indexOf("assertExportRateLimit(");
    if (rateLimitIndex !== -1) {
      assert.ok(
        guard.index < rateLimitIndex,
        `${file}: refuse the caller before charging the export rate limit, so a refused employee cannot burn the admin's quota`,
      );
    }
  }

  // --- 2b. the wrong-town finder walks the same national list and writes rulings ---------------
  {
    const route = source(FINDER_ROUTE);
    for (const [method, call] of [["GET", "scanAddressFindings("], ["POST", "ruleOnAddressFinding("]] as const) {
      const body = route.slice(route.indexOf(`export async function ${method}(`));
      const guard = REFUSING_GUARD.exec(body);
      assert.ok(guard, `${FINDER_ROUTE} ${method} must refuse every role but Super Admin (or system scope) with a 403`);
      assert.ok(guard.index < body.indexOf(call), `${FINDER_ROUTE} ${method}: the gate must run before ${call}`);
      assert.ok(body.indexOf(call) > body.indexOf('assertPermission(access, "sales", "import")'), `${FINDER_ROUTE} ${method} must still assert sales:import`);
    }
  }

  // --- 3. the routes are no wider than the only page that calls them --------------------------
  assert.ok(
    PAGE_SUPER_ADMIN_ONLY_GATE.test(source(PAGE)),
    `${PAGE} is the Database Validation tab's only host and is Super Admin only; if it opened to another role, decide on purpose whether the customer map opens with it`,
  );

  // --- 4. the class, not just these two files -------------------------------------------------
  // A third route calling listCustomerMap would be the same leak under a new URL. The floor stops a
  // sweep that read nothing from passing silently.
  const readers = routesReadingTheCustomerMap();
  assert.ok(readers.length >= ROUTES.length, `the sweep found ${readers.length} route(s) calling listCustomerMap; expected at least ${ROUTES.length}`);
  for (const file of readers) {
    const route = source(file);
    const guard = REFUSING_GUARD.exec(route);
    assert.ok(
      guard && guard.index < route.indexOf("listCustomerMap("),
      `${file} reads the whole customer map (names and addresses) -- it must carry the Super Admin / system-scope 403 before the read, like ${ROUTES[0].file}`,
    );
  }
}
