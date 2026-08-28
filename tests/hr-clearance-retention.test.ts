/**
 * Phase 6 — Clearance & Offboarding, and the Retention Register.
 *
 * WHAT THIS FILE IS FOR. Two new permission resources landed at once, and the three ways a new
 * resource has silently gone wrong in this repository are all covered here:
 *
 * 1. **The sidebar's permission lookup FAILS OPEN on a key it has never seen.** A resource added to
 *    the `PermissionResource` union but not to the runtime `permissionResources` array offers its
 *    tab to every role in the company, and no existing test notices. For `retention` that would
 *    mean handing every Medical Rep what their colleagues said in confidence about their manager
 *    and their pay.
 * 2. **A grant widened sideways under cover of a rename.** `clearance` belongs to HR Operations and
 *    `retention` to HR Advisory — they must NOT cross, because splitting them is the whole reason
 *    the function catalogue exists. A single "helpful" edit granting both to both would look
 *    tidier and would be the privacy defect.
 * 3. **A nav row advertising a permission its page does not gate on.** That defect shipped twice
 *    (the Deductions row, #2554; the contract-renewal tiles, #2568). tests/hr-command-center.test.ts
 *    reads the tile→sidebar half; this file reads the resource→bundle half underneath it.
 *
 * AND THE GATE ITSELF. `phx_hr_clearance_release` refusing to record a settlement while a station
 * is undecided is the one rule in Phase 6 that protects money. It is enforced in plpgsql rather
 * than in a page precisely so a future page cannot bypass it, which means the thing worth pinning
 * is that the SQL still contains it — a page-level test would pass while the gate was gone.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { HR_ROLE_BOUNDARIES, HR_ROLE_BUNDLES, hrBundleGrants } from "../src/lib/auth/hr-functions.ts";
import {
  permissionMatrix,
  permissionResources,
  phoenixRoles,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { buildHrCommandGroups, sourcesFor, type HrCommandSources } from "../src/lib/hr/command-center.ts";

const MIGRATION = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260828160000_hr_clearance_and_retention.sql",
);

/** Who may hold each resource at all, after hard boundaries. Everyone else must hold nothing. */
const EXPECTED_HOLDERS: Record<"clearance" | "retention", PhoenixRole[]> = {
  clearance: ["Super Admin", "HR Operations", "CEO"],
  retention: ["Super Admin", "HR Advisory", "CEO"],
};

function actionsFor(role: PhoenixRole, resource: PermissionResource): PermissionAction[] {
  return permissionMatrix[role]?.[resource] ?? [];
}

export async function runHrClearanceRetentionTests() {
  // ── 1. Registered in BOTH places, or the sidebar fails open ───────────────────────────────────
  for (const resource of ["clearance", "retention"] as const) {
    assert.ok(
      permissionResources.includes(resource),
      `"${resource}" is missing from the runtime permissionResources array. The type union alone ` +
        "is not enough: the sidebar's permission lookup succeeds on a key it has never seen, so " +
        "the tab would be offered to every role in the company with no other test failing.",
    );
  }
  // A control. Without it, a permissionResources that had grown to include every string would
  // satisfy the loop above.
  assert.ok(
    !(permissionResources as string[]).includes("clearances"),
    "permissionResources contains a resource nobody declared — the check above is not discriminating",
  );

  // ── 2. Exactly the intended roles, and the two HR seats do not cross ──────────────────────────
  for (const [resource, expected] of Object.entries(EXPECTED_HOLDERS) as [
    "clearance" | "retention",
    PhoenixRole[],
  ][]) {
    const holders = phoenixRoles.filter((role) => actionsFor(role, resource).length > 0);
    assert.deepEqual(
      [...holders].sort(),
      [...expected].sort(),
      `"${resource}" is held by ${holders.join(", ") || "nobody"} — expected exactly ` +
        `${expected.join(", ")}. Every other role in this company must hold nothing on it.`,
    );
  }

  assert.equal(
    actionsFor("HR Operations", "retention").length,
    0,
    "HR Operations holds the retention register. A stay discussion is an employee telling HR what " +
      "they think of their manager and their pay; that is hrbp 3, held by HR Advisory alone.",
  );
  assert.equal(
    actionsFor("HR Advisory", "clearance").length,
    0,
    "HR Advisory holds clearance. Coordinating clearance and recording a settlement release is " +
      "ops 6, and it belongs to HR Operations.",
  );

  // ── 3. Nobody but the Super Admin may delete either ───────────────────────────────────────────
  // A clearance trail is the evidence a settlement was released against, and a retention
  // conversation is the evidence behind a turnover theme a CEO reads. Both job descriptions
  // require records that survive an audit.
  for (const resource of ["clearance", "retention"] as const) {
    const deleters = phoenixRoles.filter((role) => actionsFor(role, resource).includes("delete"));
    assert.deepEqual(
      deleters,
      ["Super Admin"],
      `"${resource}" can be deleted by ${deleters.join(", ") || "nobody"} — only Super Admin may`,
    );
  }
  for (const resource of ["clearance", "retention"] as const) {
    assert.ok(
      HR_ROLE_BOUNDARIES.some((entry) => entry.resource === resource && entry.action === "delete"),
      `HR_ROLE_BOUNDARIES has no delete entry for "${resource}" — the boundary holds today only ` +
        "because no bundle happens to grant it, which is an accident rather than a rule",
    );
  }

  // ── 4. Composed from the FUNCTION, not hand-listed on the role ────────────────────────────────
  // This is the claim the function catalogue exists to make: HR Advisory gained the whole retention
  // module from one line inside `engagement_retention`, and would lose it if that function were
  // taken away. A grant hand-written onto the role would pass every check above and break this one.
  const advisory = hrBundleGrants("HR Advisory");
  const operations = hrBundleGrants("HR Operations");
  assert.ok(
    (advisory.retention ?? []).length > 0,
    "HR Advisory's composed bundle carries no retention grant — it must come from engagement_retention",
  );
  assert.ok(
    (operations.clearance ?? []).length > 0,
    "HR Operations' composed bundle carries no clearance grant — it must come from people_records",
  );
  assert.ok(
    HR_ROLE_BUNDLES["HR Advisory"].includes("engagement_retention"),
    "HR Advisory no longer holds engagement_retention — the retention grant above is not traceable",
  );
  assert.ok(
    HR_ROLE_BUNDLES["HR Operations"].includes("people_records"),
    "HR Operations no longer holds people_records — the clearance grant above is not traceable",
  );

  // A bundle grant that the hard boundary then strips is a LIE IN THE WORKBOOK, not a safety net.
  // Found by breaking this file deliberately: granting retention to people_records left every
  // assertion above green, because hardBoundaryAllowedActions returns [] for retention on any role
  // but the three named — so HR Operations would have read the function catalogue as doing exit
  // interviews while holding nothing. That is the same shape as the Head Office grant that died in
  // a filter below its gate. permissionMatrix is post-boundary (applyHardPermissionBoundaries
  // mutates it at module load) and hrBundleGrants is pre-boundary, so comparing them is the check.
  for (const seat of ["HR Advisory", "HR Operations"] as const) {
    const claimed = hrBundleGrants(seat);
    for (const [resource, actions] of Object.entries(claimed)) {
      const live = actionsFor(seat, resource as PermissionResource);
      const dead = (actions ?? []).filter((action) => !live.includes(action));
      assert.deepEqual(
        dead,
        [],
        `${seat}'s function catalogue claims ${resource}:${dead.join("/")} but the hard boundary strips it — either grant it in hardBoundaryAllowedActions or stop claiming it in hr-functions.ts`,
      );
    }
  }

  // ── 5. The dashboards actually surface them ───────────────────────────────────────────────────
  // Driven through the REAL builders, so the hrefs asserted are the hrefs the page emits.
  // tests/hr-command-center.test.ts then checks every such href against the seat's own sidebar.
  assert.ok(
    sourcesFor("HR Operations").includes("clearance"),
    "HR Operations' dashboard never loads clearance, so her landing page cannot show it",
  );
  assert.ok(
    sourcesFor("HR Advisory").includes("retention"),
    "HR Advisory's dashboard never loads the retention register, so her landing page cannot show it",
  );
  assert.ok(
    !sourcesFor("HR Advisory").includes("clearance"),
    "HR Advisory's dashboard loads clearance — she has no grant to open the page it links to",
  );
  assert.ok(
    !sourcesFor("HR Operations").includes("retention"),
    "HR Operations' dashboard loads the retention register, which she may not read at all",
  );

  const operationsSources: HrCommandSources = {
    directory: {
      employees: [],
      lookups: { medicalRepVacancies: [], workforceVacancies: [] },
      summary: {
        activeEmployees: 0,
        employeesWithoutManagers: 0,
        uniqueLines: 0,
      },
    } as unknown as NonNullable<HrCommandSources["directory"]>,
    clearance: {
      checklists: [],
      stations: [],
      // Two departures recorded before the auto-open trigger existed, so they have no checklist.
      // This is the launch-day shape: every stat below can read low or zero while real leavers are
      // waiting, which is exactly what the "No Clearance Opened" tile exists to say out loud.
      awaiting: [
        {
          resignationId: "11111111-1111-1111-1111-111111111111",
          employeeHrId: "A-16",
          employeeName: "Fixture One",
          jobTitle: "Talent Acquisition",
          lineName: null,
          lastWorkingDate: "2026-08-31",
        },
        {
          resignationId: "22222222-2222-2222-2222-222222222222",
          employeeHrId: "B-74",
          employeeName: "Fixture Two",
          jobTitle: "Office Coordinator",
          lineName: null,
          lastWorkingDate: "2026-08-31",
        },
      ],
      schemaReady: true,
      stats: {
        open: 3,
        ready: 2,
        released: 0,
        cancelled: 0,
        overdue: 1,
        blockedStations: 0,
        amountOutstanding: 0,
      },
    },
  };
  const operationsTiles = buildHrCommandGroups("HR Operations", operationsSources).flatMap(
    (group) => group.tiles,
  );
  const clearanceTiles = operationsTiles.filter((t) => t.href === "/hr/clearance");
  assert.ok(
    clearanceTiles.length >= 3,
    `HR Operations' dashboard shows ${clearanceTiles.length} clearance tiles — expected at least 3`,
  );
  assert.equal(
    clearanceTiles.find((t) => t.key === "clearance-overdue")?.value,
    1,
    "the Past Last Day tile does not read the stat it claims to — a tile wired to the wrong figure " +
      "is worse than no tile, because it looks answered",
  );
  // The launch-day misleading zero. With no checklists yet, open/ready/overdue all read low and
  // the page says "nothing waiting on you" while real departures sit unstarted. The tile must
  // appear, must count the awaiting list rather than any stat, and must not render as neutral.
  const awaitingTile = clearanceTiles.find((t) => t.key === "clearance-awaiting");
  assert.ok(
    awaitingTile,
    "no No-Clearance-Opened tile. Departures recorded before the auto-open trigger would be " +
      "invisible on the one page HR Operations lands on, behind three tiles all reading zero",
  );
  assert.equal(
    awaitingTile?.value,
    2,
    "the No Clearance Opened tile does not count the awaiting list",
  );
  assert.equal(
    awaitingTile?.tone,
    "rose",
    "a departure with no clearance started must not render as a neutral figure",
  );
  assert.equal(
    clearanceTiles.find((t) => t.key === "clearance-overdue")?.tone,
    "rose",
    "an overdue clearance is somebody waiting to be paid off and must not render as a neutral figure",
  );

  const advisoryTiles = buildHrCommandGroups("HR Advisory", {
    supportRequests: [],
    retention: {
      conversations: [],
      themes: [],
      rollup: [],
      schemaReady: true,
      stats: {
        stayCount: 4,
        exitCount: 2,
        highRisk: 1,
        regrettableExits: 1,
        wouldRejoin: 0,
        openFollowUps: 2,
        overdueFollowUps: 2,
        exitCoveragePercent: 50,
        resignationsInWindow: 4,
      },
    },
  }).flatMap((group) => group.tiles);
  const retentionTiles = advisoryTiles.filter((t) => t.href === "/hr/retention");
  assert.ok(
    retentionTiles.length >= 3,
    `HR Advisory's dashboard shows ${retentionTiles.length} retention tiles — expected at least 3`,
  );
  // No tile may carry a percentage. `exitCoveragePercent` is legitimately null when nobody has
  // left, and a tile value is a number — rendering that null as 0 would say "0% of leavers
  // interviewed" on a month with no leavers, which is precisely the misleading zero AGENTS.md §7
  // forbids. The page renders coverage properly, with a dash for the null case.
  for (const tile of retentionTiles) {
    assert.ok(
      !/%|percent|coverage/i.test(`${tile.label} ${tile.sub}`),
      `the retention tile "${tile.label}" reads as a percentage. Exit coverage is null when nobody ` +
        "has left, and a null rendered as 0 on this dashboard is a lie, not a zero.",
    );
  }

  // ── 6. The database gate, pinned in the SQL that enforces it ──────────────────────────────────
  // Matched by content rather than by a byte window: a source-pinning test that slices a fixed
  // offset false-fails the moment anything above it shifts (AGENTS.md §2.1).
  const sql = readFileSync(MIGRATION, "utf8");

  assert.ok(
    sql.includes("create or replace function public.phx_hr_clearance_release"),
    "the release function is gone from the migration — nothing then stops a settlement being " +
      "recorded while stations are still outstanding",
  );
  assert.ok(
    sql.includes("Clearance is not complete - still outstanding:"),
    "the release gate no longer names the outstanding stations. A refusal a person can act on is " +
      "the difference between this gate and a boolean; do not reduce it to one.",
  );
  assert.ok(
    sql.includes("if v_status <> 'ready' then"),
    "the release gate no longer tests for 'ready' — it would accept a half-done clearance",
  );
  assert.ok(
    sql.includes("v_status := public.phx_hr_clearance_refresh_status(p_checklist_id);"),
    "the release gate no longer recomputes the status before reading it, so a concurrent decision " +
      "could be gated against a stale stored value",
  );
  assert.ok(
    sql.includes("constraint hr_clearance_items_reason_required"),
    "a blocked or waived station no longer requires a written reason — a waiver with a reason IS " +
      "the only override this design has, and an unreasoned waiver defeats the whole gate",
  );
  assert.ok(
    sql.includes("constraint hr_retention_kind_fields"),
    "the stay/exit field constraint is gone — a stay discussion carrying is_regrettable would " +
      "silently join the turnover figures",
  );

  // RLS on every one of the six, with no permissive policy. Retention in particular holds what an
  // employee said in confidence; anon reaching it directly would not show up in any page test.
  const rlsTables = [
    "hr_clearance_stations",
    "hr_clearance_checklists",
    "hr_clearance_items",
    "hr_retention_themes",
    "hr_retention_conversations",
    "hr_retention_conversation_themes",
  ];
  for (const table of rlsTables) {
    assert.ok(
      sql.includes(`alter table public.${table} enable row level security;`),
      `${table} does not enable row level security`,
    );
  }
  assert.ok(
    !/create\s+policy/i.test(sql),
    "a permissive RLS policy was added. Visibility in this app is application-scoped through the " +
      "service-role client and decided by assertPermission in the route handler; a policy here " +
      "opens a second, unreviewed path to confidential rows.",
  );

  // ── 7. Every route action has a caller, or it is a promise the UI never keeps ──────────────────
  // Both modules shipped an endpoint nothing could reach. The clearance route accepted "open" —
  // the manual path the auto-open trigger's own comment promises ("HR can open one by hand") — and
  // no control sent it, so all 54 resignations predating the trigger had no checklist and no way
  // to get one, the two HR leavers among them. The retention route exported PATCH and the register
  // only ever POSTed, so a stay discussion's follow-up could be raised and never closed: the
  // overdue count could rise and never fall. Neither is visible in a permission table or in a
  // type — the route compiles, the permission resolves, the button simply does not exist. So the
  // check is that the set of actions the server accepts equals the set the client sends.
  const clearanceRoute = readFileSync(
    path.join(process.cwd(), "app", "api", "clearance", "route.ts"),
    "utf8",
  );
  const clearanceUi = readFileSync(
    path.join(process.cwd(), "src", "components", "clearance", "clearance-workspace.tsx"),
    "utf8",
  );
  const acceptedActions = [...clearanceRoute.matchAll(/payload\.action === "([a-z]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(
    acceptedActions.length >= 3,
    `only ${acceptedActions.length} clearance actions were found in the route — the matcher is stale`,
  );
  for (const action of acceptedActions) {
    assert.ok(
      clearanceUi.includes(`action: "${action}"`),
      `the clearance route accepts "${action}" but nothing in clearance-workspace.tsx sends it — ` +
        "either wire a control for it or delete the branch",
    );
  }

  const retentionRoute = readFileSync(
    path.join(process.cwd(), "app", "api", "retention", "route.ts"),
    "utf8",
  );
  const retentionUi = readFileSync(
    path.join(process.cwd(), "src", "components", "retention", "retention-workspace.tsx"),
    "utf8",
  );
  const mutatingMethods = [...retentionRoute.matchAll(/export async function ([A-Z]+)\(/g)]
    .map((match) => match[1])
    // GET is the page load, served by the server component — the client never issues it.
    .filter((method) => method !== "GET");
  assert.ok(
    mutatingMethods.length >= 2,
    `only ${mutatingMethods.length} mutating retention methods were found — the matcher is stale`,
  );
  for (const method of mutatingMethods) {
    assert.ok(
      retentionUi.includes(`method: "${method}"`),
      `the retention route exports ${method} but nothing in retention-workspace.tsx calls it — ` +
        "either wire a control for it or delete the handler",
    );
  }

  // The awaiting list is what makes "open" reachable, so pin that it survives to the client.
  const clearanceTypes = readFileSync(
    path.join(process.cwd(), "src", "lib", "clearance", "types.ts"),
    "utf8",
  );
  assert.ok(
    clearanceTypes.includes("awaiting: ClearanceAwaitingResignation[];"),
    "ClearanceDashboardData no longer carries the awaiting list — the pre-trigger backlog, and the " +
      "only route to the manual open, become invisible",
  );
  assert.ok(
    clearanceUi.includes("Awaiting clearance"),
    "the clearance workspace no longer renders the awaiting-clearance backlog",
  );
}
