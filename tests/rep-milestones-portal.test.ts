import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canUseEmployeePortalMilestones,
  resolveEmployeePortalNavVisibility,
} from "@/lib/employee-portal/navigation";
import { listEmployeeMilestones } from "@/lib/milestones/service";

// ─────────────────────────────────────────────────────────────────────────────
// My Milestones — the medical rep's OWN keepsake cards, self-scoped (owner, 2026-09-30:
// "in medical reps side bar show /milestones and make able to export only his milestones").
//
// The Super-Admin workspace at /milestones prints ANY employee's card across the company; that is a
// publishing right behind `milestones:export`. This portal page is a different thing: it lists only
// the signed-in rep's own occasions, and /api/milestones/my-card builds only the CALLER's card. The
// properties that would fail QUIETLY — a rep pointing the export at a colleague, the audience
// widening, a self-print corrupting the admin "already congratulated" tick, an unreachable row — are
// pinned here.
// ─────────────────────────────────────────────────────────────────────────────

export async function runRepMilestonesPortalTests() {
  const route = readFileSync(new URL("../app/api/milestones/my-card/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/employee-portals/milestones/page.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../src/components/employee-portal/employee-portal-layout.tsx", import.meta.url), "utf8");
  const registry = readFileSync(new URL("../src/components/employee-portal/employee-portal-nav-registry.ts", import.meta.url), "utf8");
  const catalog = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");

  // ── THE HEADLINE: the audience is medical reps, and only medical reps ─────────────────────────
  assert.equal(canUseEmployeePortalMilestones("Medical Rep"), true, "a medical rep may open My Milestones");
  for (const role of ["District Manager", "National Sales Manager", "Super Admin", "CEO", "Employee"] as const) {
    assert.equal(canUseEmployeePortalMilestones(role), false, `${role} is not offered the rep's My Milestones page`);
  }

  // ── The sidebar flag follows the same predicate ──────────────────────────────────────────────
  assert.equal(
    resolveEmployeePortalNavVisibility(null, "Medical Rep").showMilestonesTab,
    true,
    "the Medical Rep sidebar shows the My Milestones row",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility(null, "District Manager").showMilestonesTab,
    false,
    "no other role gets the row",
  );

  // ── THE EXPORT IS SELF-SCOPED — the subject is always the caller ──────────────────────────────
  // A rep must never be able to point the card at a colleague, so the route builds from access.hrId
  // and must not read an hrId off the request body.
  assert.match(route, /buildMilestoneCardInput\(\{\s*hrId:\s*access\.hrId/, "the card is built for the caller, always");
  assert.doesNotMatch(
    route,
    /body[?.]*\.hrId/,
    "the self-card route must never read an hrId off the wire — that would let a rep print a colleague",
  );
  // It must gate on the same audience as the sidebar.
  assert.match(route, /canUseEmployeePortalMilestones\(access\.role\)/, "the route admits the same audience the sidebar offers");
  // It must NOT write the shared print ledger — that log means "the company congratulated this
  // person", and its marks drive the Super Admin's "already congratulated" tick. A rep printing his
  // own keepsake is not a congratulation, so recording it would put a false tick on the admin list.
  assert.doesNotMatch(route, /recordMilestonePrint|buildMilestonePrintRow/, "a self-print never touches the shared print ledger");

  // ── The page gates by role predicate, never the company-wide milestones permission ────────────
  // A rep does not hold `milestones` — asserting it here would bounce him at the door (the exact
  // "offered but bounced" defect every-offered-link-opens.test.ts exists to catch).
  assert.match(page, /canUseEmployeePortalMilestones\(access\.role\)/, "the page uses the rep-audience predicate");
  assert.doesNotMatch(page, /assertPermission\([^)]*"milestones"/, "the page never asserts the Super-Admin milestones permission");

  // ── Reachable: a sidebar row, a nav-registry entry, and a catalog entry ───────────────────────
  assert.match(
    layout,
    /showMilestonesTab \? \[\{ href: "\/employee-portals\/milestones"/,
    "the rail renders the My Milestones row behind its flag",
  );
  assert.match(
    registry,
    /href: "\/employee-portals\/milestones"[^}]*flags: \["showMilestonesTab"\]/,
    "the nav registry carries the entry with its flag",
  );
  // No `permission` on the registry entry — the page has no machine-readable permission gate, so
  // employee-portal-nav-permission-matches-page.test.ts requires the field be absent.
  const registryLine = registry.split("\n").find((line) => line.includes('href: "/employee-portals/milestones"')) ?? "";
  assert.doesNotMatch(registryLine, /permission:/, "the registry entry carries no permission (the page gates by role predicate)");
  assert.match(catalog, /href: "\/employee-portals\/milestones"/, "the command-palette catalog can find the page");

  // ── DB-free contract of the service helper ───────────────────────────────────────────────────
  // An empty id short-circuits before any directory read, so this is safe with no database.
  assert.deepEqual(await listEmployeeMilestones(""), [], "an empty id yields no milestones, without touching the directory");
}
