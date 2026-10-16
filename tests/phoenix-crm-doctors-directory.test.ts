import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Phoenix CRM — the Doctors directory, the cross-territory list of validated customers.
 *
 * Owner, 2026-09-22: "BUILD the cross-territory validated-doctors list", then "give SFE and Training
 * Manager the full company list too".
 *
 * Three things here are silent when they break — the screens keep working and only the wrong people,
 * or the wrong customers, are shown — so each is pinned:
 *
 *   1. **Validated only.** A customer carried over from iReports360 and not validated yet belongs to
 *      his own rep's list. If the directory's query stops filtering him out, every manager and the
 *      SFE team start reading unproved rows as if they were real.
 *   2. **Downward only, and the four directory roles.** Scope is decided on the SERVER. A component
 *      that decided it, or a route that forgot to, would hand one rep another rep's territory.
 *   3. **The seventh tab is really wired.** A tab key with no column rule collapses the tab bar to one
 *      column on a phone; a key the content switch does not know silently renders the Plan tab.
 */

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function runScopeTests() {
  const doctors = source("src/lib/phoenix-crm/server/doctors.ts");

  // 1. Validated only, said both ways the rest of the module says it — on the CUSTOMERS query, not
  //    just somewhere in the file (the places query filters on `status` too).
  const customersQuery = /from\("phoenix_crm_customers"\)([\s\S]*?),\n\s*\{ cursorColumn/.exec(doctors);
  assert.ok(customersQuery, "the directory reads phoenix_crm_customers");
  assert.match(customersQuery[1], /\.eq\("status", "active"\)/, "the directory reads validated customers only");
  assert.match(
    customersQuery[1],
    /\.not\("validated_at", "is", null\)/,
    "the directory asks for validated_at as well, so the rule reads the same as in every report function",
  );
  assert.doesNotMatch(doctors, /"pending"/, "a customer not validated yet never reaches the directory");

  // 2. The four directory roles, and no more. Owner, 2026-09-22.
  const roles = /DIRECTORY_COMPANY_ROLES = new Set<string>\(\[([^\]]+)\]\)/.exec(doctors);
  assert.ok(roles, "the directory names the roles that read the whole company");
  const named = [...roles[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    named,
    ["CEO", "SFE Manager", "Super Admin", "Training Manager"],
    "the whole company's validated customers are read by the Super Admin, the CEO, the SFE Manager and the Training Manager — nobody else",
  );

  // The Training Manager is a DIRECTORY role only: widening Phoenix CRM's own COMPANY_ROLES would hand
  // him every territory's visits, list, plan and reports, which is not what was asked for.
  const access = source("src/lib/phoenix-crm/server/access.ts");
  const companyRoles = /COMPANY_ROLES = new Set<PhoenixRole>\(\[([^\]]+)\]\)/.exec(access);
  assert.ok(companyRoles, "Phoenix CRM names its own company-scope roles");
  assert.doesNotMatch(companyRoles[1], /Training Manager/, "the Training Manager reads the doctors directory, not every territory's visits, plans and reports");

  // Everyone else reads their own subtree, which territoriesInScope already resolves downward.
  assert.match(doctors, /return viewer\.scopeTerritories;/, "a viewer who is not a directory role reads the territories beneath him only");

  // Speed (Phoenix CRM performance audit, 2026-10-16): the customers and the place counts read side by
  // side, the names start the moment the customers land, and each read's seat chunks run four at a
  // time — a company role's directory spans every territory, which used to be one chunk after another.
  assert.match(
    doctors,
    /await Promise\.all\(\[customersRead, loadPlaceCounts\(seatIds, isTest\), namesRead\]\)/,
    "the customers, the place counts and the names are one wave, not three reads in a row",
  );
  assert.match(doctors, /const namesRead = customersRead\.then\(/, "the names wait only on the customers they name");
  assert.equal(
    (doctors.match(/mapWithConcurrency\(chunk\(seatIds, 100\), SEAT_CHUNKS_AT_ONCE,/g) ?? []).length,
    2,
    "both seat-chunked reads run their chunks side by side",
  );
  assert.match(doctors, /const SEAT_CHUNKS_AT_ONCE = 4;/, "four at a time, the module's usual allowance");

  // 3. Scope is settled on the server. The component is handed rows, never a rule.
  const tab = source("src/components/phoenix-crm/doctors-tab.tsx");
  for (const leaked of [/Super Admin/, /SFE Manager/, /Training Manager/, /scopeTerritories/]) {
    assert.doesNotMatch(tab, leaked, "the Doctors tab draws what the server sent; it never decides who may see what");
  }
}

function runRouteTests() {
  const route = source("app/api/phoenix-crm/doctors/route.ts");
  assert.match(route, /assertPermission\(access, "phoenix_crm", "read"\)/, "the route checks the matrix before anything else");
  assert.match(route, /resolvePhoenixCrmViewer\(access\)/, "the route resolves the viewer, so the organogram narrows the permission again");
  assert.match(route, /loadDoctorDirectory\(viewer, isTest\)/, "the route hands the viewer to the loader, which settles the scope");
  // Settled by the one helper every cross-territory read uses: the Super Admin's own choice, always on
  // for a test login (src/lib/auth/test-persona.ts), refused to everyone else who asks.
  assert.match(route, /const isTest = testModeFor\(viewer, searchOf\(request\)\.get\("test"\)\)/, "test entries are the Super Admin's, here as everywhere else");

  // The registry and the route must agree, or the boundary test's on-disk sweep fails.
  const registry = source("src/lib/security/access-registry.ts");
  assert.match(
    registry,
    /pattern: "\/api\/phoenix-crm\/doctors", permission: \{ resource: "phoenix_crm", action: "read" \}, guard: "assert-permission", csrfRequired: false/,
    "the doctors route is registered as a permission-guarded GET",
  );
}

function runTabTests() {
  const app = source("src/components/phoenix-crm/phoenix-crm-app.tsx");

  const order = /const TAB_ORDER[^=]*=\s*\[([^\]]+)\]/.exec(app);
  assert.ok(order, "the page declares its tabs in TAB_ORDER");
  const tabs = [...order[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  assert.ok(tabs.includes("doctors"), "Doctors is one of the page's tabs");

  // A tab with no column rule silently collapses the whole bar to one column on a phone.
  const columns = /const TAB_COLUMNS: Record<number, string> = \{([^}]+)\}/.exec(app);
  assert.ok(columns, "the page declares its phone tab grid");
  for (let count = 1; count <= tabs.length; count += 1) {
    assert.match(columns[1], new RegExp(`\\b${count}:`), `${count} tabs must have a grid rule, or the tab bar collapses to one column on a phone`);
  }

  // A key the content switch does not know renders the Plan tab, quietly and wrongly.
  assert.match(app, /if \(key === "doctors"\) \{/, "the page draws the Doctors tab rather than falling through to the planner");
  // The RULE is that Doctors is excluded, not that exactly two tabs are. Pinning the whole union made
  // this test the thing that broke when Today — another read that holds nothing — was added in A2
  // (2026-09-26), which is a false failure: it said "Doctors holds unsaved work now", and it did not.
  const holding = /type HoldingTab = Exclude<TabKey, ([^>]+)>;/.exec(app);
  assert.ok(holding, "HoldingTab is still declared by excluding the tabs that hold nothing");
  assert.match(holding[1], /"doctors"/, "the Doctors tab holds no unsaved work, so it is never kept aside");

  // The server decides the tab, and a directory role gets it without holding a seat: a Training
  // Manager has no territory in the organogram and would otherwise be shown a closed module.
  const overview = source("src/lib/phoenix-crm/server/overview.ts");
  assert.match(overview, /doctors: hasScope \|\| isDirectoryCompanyRole\(viewer\.role\)/, "a directory role gets the Doctors tab without holding a territory");
  assert.match(overview, /if \(isDirectoryCompanyRole\(viewer\.role\)\) return null;/, "the module is not closed for a directory role who holds no seat");
}

function runLookTests() {
  // The module's locked look: no horizontal scroll, no ellipsis, no rounded corner.
  const tab = source("src/components/phoenix-crm/doctors-tab.tsx");
  for (const banned of [/\btruncate\b/, /\bline-clamp-/, /\boverflow-x-auto\b/, /\brounded-(?!none\b)/]) {
    assert.doesNotMatch(tab, banned, "the Doctors tab breaks the module's look");
  }
  // Desktop tables, mobile cards — and the table is fixed-width by column, never min-width with a scroll.
  assert.match(tab, /<CrmCardsOnPhone>/, "phones get cards");
  assert.match(tab, /<CrmTable columns=\{\[/, "desktop gets a table whose columns are declared, so it fits the screen");

  // The AM · PM golden rule: accounts and doctors are reported apart, never added together.
  assert.doesNotMatch(tab, /counts\.AM \+ counts\.PM/, "accounts and doctors are never added together");
}

/**
 * Gate one: the permission matrix. Naming a role in `DIRECTORY_COMPANY_ROLES` promises him nothing —
 * every `/api/phoenix-crm/*` route calls `assertPermission(access, "phoenix_crm", "read")` first, and
 * a role the matrix does not grant is refused before the directory's own scope rule is ever reached.
 *
 * This is not hypothetical. The owner asked for the Training Manager on 2026-09-22; the SFE Manager's
 * grant landed and his did not, so for a day the code above named him a directory role while the door
 * answered 403 to every call he made. The set test passed the whole time. The matrix is asserted from
 * the REAL exported object, never from the file's text, because that is what the route reads.
 */
async function runMatrixGrantTests() {
  const { permissionMatrix } = (await import("@/lib/auth/permissions")) as {
    permissionMatrix: Record<string, Record<string, string[] | undefined>>;
  };

  for (const role of ["Super Admin", "CEO", "SFE Manager", "Training Manager"]) {
    assert.ok(
      (permissionMatrix[role]?.phoenix_crm ?? []).includes("read"),
      `${role} reads the whole company's validated customers, so the matrix must let him through the door`,
    );
  }

  // Read ALONE for the Training Manager: `create`, `update` and `approve` are what
  // resolvePhoenixCrmViewer turns into entering visits, requesting list changes and deciding them.
  const trainingManager = permissionMatrix["Training Manager"]?.phoenix_crm ?? [];
  for (const action of ["create", "update", "approve"]) {
    assert.ok(
      !trainingManager.includes(action),
      `the Training Manager reads the doctors directory; he never ${action}s in Phoenix CRM`,
    );
  }

  // And the card that opens it. The sidebar is UX only — the routes are the boundary — but a role
  // with the grant and no card has no door at all.
  const nav = source("src/config/system-navigation.ts");
  const card = /href: "\/admin\/field-crm",[\s\S]*?roles: \[([^\]]+)\]/.exec(nav);
  assert.ok(card, "the Phoenix CRM card declares the roles that see it");
  assert.match(card[1], /"Training Manager"/, "the Training Manager has a door to the directory he was granted");
}

export async function runPhoenixCrmDoctorsDirectoryTests() {
  runScopeTests();
  runRouteTests();
  runTabTests();
  runLookTests();
  await runMatrixGrantTests();
}
