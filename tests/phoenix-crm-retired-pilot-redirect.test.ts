import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RETIRED_PILOT_TAB_TARGETS,
  retiredPilotTabPassThrough,
  retiredPilotTabQuery,
} from "../src/lib/phoenix-crm/retired-pilot.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The retired Phoenix CRM pilot forwards to the live field app (the owner, 2026-09-25).
//
// WHAT THIS FILE GUARDS:
//   · /employee-portals/phoenix-crm is a FORWARD, never a page: it renders nothing and lands on
//     /employee-portals/field-crm, on the tab doing the same work — Visits → visits, Planning →
//     plan, KPIs → reports; the Pilot reps roster and anything else → the viewer's default tab.
//   · /admin/phoenix-crm forwards to /admin/field-crm the same way, and its portal twin is the
//     pilot's portal page, which maps the tab — so no viewer from either shell lands on the pilot.
//   · Nothing in the app sends a person to the pilot any more: the "Super Admin entered a visit for
//     you" notice and the roster notice open the field app.
// ─────────────────────────────────────────────────────────────────────────────

function read(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const PORTAL_PAGE = "app/employee-portals/phoenix-crm/page.tsx";
const ADMIN_PAGE = "app/(admin)/admin/phoenix-crm/page.tsx";

export async function runPhoenixCrmRetiredPilotRedirectTests() {
  // ── 1. The tab map ─────────────────────────────────────────────────────────────────────────────
  assert.equal(retiredPilotTabQuery("visits"), "?tab=visits");
  assert.equal(retiredPilotTabQuery("planning"), "?tab=plan", "the pilot's Planning is the field app's Plan");
  assert.equal(retiredPilotTabQuery("kpis"), "?tab=reports", "the pilot's KPIs are the field app's Reports");
  assert.equal(retiredPilotTabQuery(["planning", "kpis"]), "?tab=plan", "the first value wins");
  assert.equal(retiredPilotTabQuery(" kpis "), "?tab=reports");
  for (const other of ["pilot-reps", "plan", "reports", "", "constructor", "__proto__", "x&tab=settings", undefined]) {
    assert.equal(retiredPilotTabQuery(other), "", `${String(other)} opens on the viewer's default tab`);
  }
  assert.deepEqual([...RETIRED_PILOT_TAB_TARGETS.keys()], ["visits", "planning", "kpis"], "every tab the pilot had, bar the roster");

  // The admin-to-portal hop carries the pilot's own tab name, unmapped, for the portal page to map.
  assert.equal(retiredPilotTabPassThrough("planning"), "?tab=planning");
  assert.equal(retiredPilotTabPassThrough("pilot-reps"), "?tab=pilot-reps");
  assert.equal(retiredPilotTabPassThrough("x&tab=settings"), "", "nothing but a tab name crosses");
  assert.equal(retiredPilotTabPassThrough(undefined), "");
  // End to end: an admin pilot link a portal viewer opens lands on the right field-app tab.
  const hop = retiredPilotTabPassThrough("kpis").replace(/^\?tab=/, "");
  assert.equal(retiredPilotTabQuery(hop), "?tab=reports");

  // ── 2. The two pages are forwards, not the pilot ───────────────────────────────────────────────
  const portal = read(PORTAL_PAGE);
  assert.match(portal, /redirect\(`\/employee-portals\/field-crm\$\{retiredPilotTabQuery\(\(await searchParams\)\.tab\)\}`\);/);
  const admin = read(ADMIN_PAGE);
  assert.match(admin, /redirect\(`\/admin\/field-crm\$\{retiredPilotTabQuery\(params\.tab\)\}`\);/);
  assert.match(
    admin,
    /if \(resolveNavigationMode\(access\) === "employee-portal"\) \{\s*redirect\(`\/employee-portals\/phoenix-crm\$\{preservedQuery\(params\)\}`\);/,
    "a portal viewer goes by the pilot's portal page, which maps the tab",
  );
  for (const [page, source] of [[PORTAL_PAGE, portal], [ADMIN_PAGE, admin]] as const) {
    assert.doesNotMatch(
      source,
      /PhoenixCrmSpace|getPhoenixCrmAccess|EmployeePortalPageShell|AdminPageHero|return \(|<\/?[a-z]+[ >]/,
      `${page} renders nothing — the retired pilot is never served`,
    );
  }

  // ── 3. The twin table and the links point past the pilot ───────────────────────────────────────
  assert.match(
    read("src/lib/navigation/portal-twins.ts"),
    /\{ from: "\/admin\/phoenix-crm", to: "\/employee-portals\/phoenix-crm", carryQuery: \["tab"\] \},/,
    "only the tab crosses, as the admin page's own preservedQuery does",
  );
  assert.match(read("src/lib/crm/native-visits/service.ts"), /actionUrl: "\/employee-portals\/field-crm\?tab=visits",/);
  assert.match(read("src/lib/crm/native-visits/phoenix-crm.ts"), /const PHOENIX_CRM_URL = "\/employee-portals\/field-crm";/);
  for (const file of ["src/lib/crm/native-visits/service.ts", "src/lib/crm/native-visits/phoenix-crm.ts"]) {
    assert.doesNotMatch(read(file), /"\/employee-portals\/phoenix-crm/, `${file} sends nobody to the retired pilot`);
  }
}
