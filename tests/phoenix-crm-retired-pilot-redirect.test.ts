import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RETIRED_PILOT_TAB_TARGETS,
  retiredPilotPortalTarget,
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

  // The portal address lands on the module's own page in ONE hop — the chooser's `?tab=` forward was a
  // second redirect and a second whole portal render (performance audit, 2026-10-16).
  assert.equal(retiredPilotPortalTarget("visits"), "/employee-portals/field-crm/visits");
  assert.equal(retiredPilotPortalTarget("planning"), "/employee-portals/field-crm/plan");
  assert.equal(retiredPilotPortalTarget("kpis"), "/employee-portals/field-crm/reports");
  for (const other of ["pilot-reps", "plan", "", "__proto__", "x&tab=settings", undefined]) {
    assert.equal(retiredPilotPortalTarget(other), "/employee-portals/field-crm", `${String(other)} opens the chooser`);
  }

  // ── 2. The two pages are forwards, not the pilot ───────────────────────────────────────────────
  const portal = read(PORTAL_PAGE);
  assert.match(portal, /redirect\(retiredPilotPortalTarget\(\(await searchParams\)\.tab\)\);/);
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
  // The pilot's own service, notice-builder and roster files that used to carry an actionUrl or a
  // PHOENIX_CRM_URL constant are retired outright (2026-09-25) — there is nothing left to check there.
}
