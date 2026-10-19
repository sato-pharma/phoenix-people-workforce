/**
 * Phase 6 — the Retention Register, and the offboarding grant beside it.
 *
 * WHAT THIS FILE IS FOR. Two permission resources landed at once, and the three ways a new
 * resource has silently gone wrong in this repository are all covered here:
 *
 * 1. **The sidebar's permission lookup FAILS OPEN on a key it has never seen.** A resource added to
 *    the `PermissionResource` union but not to the runtime `permissionResources` array offers its
 *    tab to every role in the company, and no existing test notices. For `retention` that would
 *    mean handing every Medical Rep what their colleagues said in confidence about their manager
 *    and their pay.
 * 2. **A grant widened sideways under cover of a rename.** `mailbox_offboarding` belongs to HR
 *    Operations and `retention` was HR Advisory's — they must NOT cross, because splitting them is the
 *    whole reason the function catalogue exists. Since the owner retired the HR Business Partner seat
 *    on 2026-10-08, `retention` is no HR seat's at all: the Super Admin's ("Leave it for system
 *    administrator now"), read by the CEO. A single "helpful" edit granting both to both
 *    would look tidier and would be the privacy defect.
 * 3. **A nav row advertising a permission its page does not gate on.** That defect shipped twice
 *    (the Deductions row, #2554; the contract-renewal tiles, #2568). tests/hr-command-center.test.ts
 *    reads the tile→sidebar half; this file reads the resource→bundle half underneath it.
 *
 * WHAT CHANGED ON 2026-09-01, and why this file still reads a migration named "clearance". The
 * Clearance & Offboarding module was removed at the owner's instruction: the page, the API route,
 * the service, the tiles and the tasks are gone, and `clearance` is no longer a permission resource
 * at all. The DATABASE OBJECTS ARE NOT GONE — six tables and five security definer functions from
 * `20260828160000_hr_clearance_and_retention.sql` are still live in production, holding the
 * evidence trail behind every settlement released while the module ran. Dropping them is a
 * production migration nobody has approved, and a migration file is history that is never edited.
 *
 * So the SQL pins below split in two, deliberately:
 *
 *   • The SECURITY pins STAY, on all six tables and all five functions. An orphaned SECURITY
 *     DEFINER function bypasses RLS by design and is reachable over PostgREST RPC by anyone the
 *     ACL still admits. Code no longer calling it makes that MORE important to keep pinned, not
 *     less — nothing in the app would fail if the grant were widened.
 *   • The BEHAVIOURAL pins are gone — the wording of the release refusal, the 'ready' test, the
 *     reason-required constraint. No code path can reach them any more, so a test asserting they
 *     still behave correctly asserts something nobody can observe.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  HR_ROLE_BOUNDARIES,
  HR_ROLE_BUNDLES,
  UNASSIGNED_HR_FUNCTIONS,
  composeHrRoleGrants,
  hrBundleGrants,
  type HrBundleName,
} from "../src/lib/auth/hr-functions.ts";
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

/** The two resources this file governs. */
const PAIR = ["mailbox_offboarding", "retention"] as const;

/** Who may hold each resource at all, after hard boundaries. Everyone else must hold nothing. */
const EXPECTED_HOLDERS: Record<(typeof PAIR)[number], PhoenixRole[]> = {
  mailbox_offboarding: ["Super Admin", "HR Operations", "CEO"],
  // HR Advisory held it until the seat was retired on 2026-10-08.
  retention: ["Super Admin", "CEO"],
};

function actionsFor(role: PhoenixRole, resource: PermissionResource): PermissionAction[] {
  return permissionMatrix[role]?.[resource] ?? [];
}

export async function runHrRetentionRegisterTests() {
  // ── 1. Registered in BOTH places, or the sidebar fails open ───────────────────────────────────
  for (const resource of PAIR) {
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
    !(permissionResources as string[]).includes("retentions"),
    "permissionResources contains a resource nobody declared — the check above is not discriminating",
  );

  // ── 1b. The removed module leaves no grant behind ─────────────────────────────────────────────
  // A resource outliving its pages is not harmless: `permissionMatrix` is what the sidebar, the
  // module catalogue and every `assertPermission` read, so a `clearance` left standing would keep
  // appearing in the permission admin UI as a module somebody can be granted, pointing at nothing.
  // The mailbox register was this grant's only other consumer and took a name of its own.
  assert.ok(
    !(permissionResources as string[]).includes("clearance"),
    "`clearance` is still a permission resource. The Clearance & Offboarding module was removed on " +
      "2026-09-01 — a grant that survives its pages is offered in the permission admin as a module " +
      "nobody can open, and is the kind of orphan a later session re-attaches a page to.",
  );
  for (const role of phoenixRoles) {
    assert.equal(
      (permissionMatrix[role] as Record<string, unknown> | undefined)?.clearance,
      undefined,
      `${role} still carries a clearance grant in permissionMatrix`,
    );
  }

  // ── 2. Exactly the intended roles, and the two HR seats do not cross ──────────────────────────
  for (const [resource, expected] of Object.entries(EXPECTED_HOLDERS) as [
    (typeof PAIR)[number],
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
      "they think of their manager and their pay; that is hrbp 3, held by no HR seat since the HR Business Partner was retired (2026-10-08).",
  );
  assert.equal(
    actionsFor("HR Resourcing", "retention").length,
    0,
    "the Talent Acquisition seat holds the retention register. The owner did not give her " +
      "engagement_retention, and a stay discussion is not recruiting.",
  );

  // ── 3. Nobody but the Super Admin may delete either ───────────────────────────────────────────
  // A mailbox revocation row is the attestation that a leaver's company mail was actually shut, and
  // a retention conversation is the evidence behind a turnover theme a CEO reads. Both job
  // descriptions require records that survive an audit.
  for (const resource of PAIR) {
    const deleters = phoenixRoles.filter((role) => actionsFor(role, resource).includes("delete"));
    assert.deepEqual(
      deleters,
      ["Super Admin"],
      `"${resource}" can be deleted by ${deleters.join(", ") || "nobody"} — only Super Admin may`,
    );
  }
  for (const resource of PAIR) {
    assert.ok(
      HR_ROLE_BOUNDARIES.some((entry) => entry.resource === resource && entry.action === "delete"),
      `HR_ROLE_BOUNDARIES has no delete entry for "${resource}" — the boundary holds today only ` +
        "because no bundle happens to grant it, which is an accident rather than a rule",
    );
  }

  // ── 4. Composed from the FUNCTION, not hand-listed on the role ────────────────────────────────
  // This is the claim the function catalogue exists to make: the retention module is ONE line inside
  // `engagement_retention`, and whoever holds that function holds the register. The HR Business
  // Partner held it until her seat was retired on 2026-10-08; the function now sits on
  // UNASSIGNED_HR_FUNCTIONS, so the grant must still travel with the function (ready for the day
  // the owner hands it to a seat) while no seat carries it today.
  assert.ok(
    (composeHrRoleGrants(["engagement_retention"]).retention ?? []).length > 0,
    "engagement_retention no longer carries a retention grant — the register is not traceable to a function",
  );
  assert.ok(
    UNASSIGNED_HR_FUNCTIONS.includes("engagement_retention"),
    "engagement_retention is no longer on UNASSIGNED_HR_FUNCTIONS — if a seat holds it now, the " +
      "hard boundary below must grant that seat retention, or the function catalogue lies",
  );
  const operations = hrBundleGrants("HR Operations");
  assert.ok(
    (operations.mailbox_offboarding ?? []).length > 0,
    "HR Operations' composed bundle carries no mailbox_offboarding grant — it must come from people_records",
  );
  assert.ok(
    HR_ROLE_BUNDLES["HR Operations"].includes("people_records"),
    "HR Operations no longer holds people_records — the offboarding grant above is not traceable",
  );

  // A bundle grant that the hard boundary then strips is a LIE IN THE WORKBOOK, not a safety net.
  // Found by breaking this file deliberately: granting retention to people_records left every
  // assertion above green, because hardBoundaryAllowedActions returns [] for retention on any role
  // but the three named — so HR Operations would have read the function catalogue as doing exit
  // interviews while holding nothing. That is the same shape as the Head Office grant that died in
  // a filter below its gate. permissionMatrix is post-boundary (applyHardPermissionBoundaries
  // mutates it at module load) and hrBundleGrants is pre-boundary, so comparing them is the check.
  const seats = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];
  for (const seat of seats) {
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
  // No live seat's landing page loads the retention register: no seat holds engagement_retention
  // since the HR Business Partner was retired (2026-10-08), so loading it would be a round trip for
  // figures nobody on that page may read.
  for (const seat of seats) {
    assert.ok(
      !sourcesFor(seat).includes("retention"),
      `${seat}'s dashboard loads the retention register, which no HR seat may read since 2026-10-08`,
    );
  }
  // The removed module must not leave a fetch behind either. A source key with no tiles is a live
  // Supabase round trip on every landing-page render, paid for by a seat who sees nothing for it.
  for (const seat of seats) {
    assert.ok(
      !(sourcesFor(seat) as string[]).includes("clearance"),
      `${seat}'s dashboard still fetches clearance — the module is gone, so that is a round trip ` +
        "nobody can see the result of",
    );
  }

  // Every live seat, built with a full retention fixture through the REAL builder: not one tile
  // may link to the register. The HR Business Partner's dashboard showed three until her seat was
  // retired on 2026-10-08; a retention tile on another seat's page now would be a figure she — or
  // whoever holds the seat — has no grant to open.
  const retentionFixture = {
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
  } as unknown as HrCommandSources;
  const everyTile = seats.flatMap((seat) =>
    buildHrCommandGroups(seat, retentionFixture).flatMap((group) => group.tiles),
  );
  assert.ok(everyTile.length > 0, "no seat built a single tile — the checks below would pass vacuously");
  for (const tile of everyTile) {
    assert.ok(
      tile.href !== "/hr/retention",
      `the tile "${tile.label}" links to the retention register, which no HR seat may read since 2026-10-08`,
    );
  }

  // No retention tile may carry a percentage — pinned in the builder's SOURCE now that no seat
  // renders it, so the rule is still there the day the owner hands engagement_retention to a seat.
  // `exitCoveragePercent` is legitimately null when nobody has left, and a tile value is a number —
  // rendering that null as 0 would say "0% of leavers interviewed" on a month with no leavers, which
  // is precisely the misleading zero AGENTS.md §7 forbids. The page renders coverage with a dash.
  const commandCenter = readFileSync(path.join(process.cwd(), "src", "lib", "hr", "command-center.ts"), "utf8");
  const builderStart = commandCenter.indexOf("  engagement_retention: (loaded) => {");
  const builderEnd = commandCenter.indexOf("  performance_probation: (loaded) =>", builderStart);
  assert.ok(builderStart > 0 && builderEnd > builderStart, "the engagement_retention tile builder moved — re-anchor this check");
  assert.ok(
    !commandCenter.slice(builderStart, builderEnd).includes("stats.exitCoveragePercent"),
    "the retention tiles read exitCoveragePercent. Exit coverage is null when nobody has left, and a " +
      "null rendered as 0 on this dashboard is a lie, not a zero.",
  );

  // Nothing on any seat's landing page may still point at the deleted pages. A tile linking to a
  // route that no longer exists renders as a perfectly ordinary figure and 404s on click.
  for (const tile of everyTile) {
    assert.ok(
      !tile.href.includes("/clearance"),
      `the tile "${tile.label}" still links to ${tile.href}, which was deleted on 2026-09-01`,
    );
  }

  // ── 6. The database objects, pinned in the SQL that created them ──────────────────────────────
  // Matched by content rather than by a byte window: a source-pinning test that slices a fixed
  // offset false-fails the moment anything above it shifts (AGENTS.md §2.1).
  const sql = readFileSync(MIGRATION, "utf8");

  assert.ok(
    sql.includes("constraint hr_retention_kind_fields"),
    "the stay/exit field constraint is gone — a stay discussion carrying is_regrettable would " +
      "silently join the turnover figures",
  );

  // RLS on every one of the six, with no permissive policy. Retention in particular holds what an
  // employee said in confidence; anon reaching it directly would not show up in any page test. The
  // three hr_clearance_* tables are still listed on purpose — they are still in production, still
  // hold real settlement evidence, and no longer have any page whose breakage would reveal a
  // widened ACL.
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

  // Every security definer function must be revoked FROM PUBLIC, not merely from anon and
  // authenticated. A new function's default ACL grants EXECUTE to PUBLIC and both those roles
  // inherit it through PUBLIC membership, so revoking the two named roles alone is a no-op. This
  // shipped wrong: section 5 sealed the tables with RLS and left all five functions open, which is
  // the worse half of the pair, because a security definer function bypasses RLS by design — any
  // signed-in employee could have called phx_hr_clearance_release over PostgREST RPC and released
  // their own settlement with the permission layer never consulted. CI's migration-check caught it;
  // this keeps it caught if the block is ever trimmed.
  //
  // FOUR OF THE FIVE ARE STILL LIVE FUNCTIONS IN PRODUCTION. The app stopped calling them on
  // 2026-09-01; that removed the caller, not the function, and an unreachable-from-the-UI definer
  // function with a loose ACL is the worst version of this, not the safe one. The fifth,
  // phx_hr_clearance_on_resignation, was dropped with its trigger on 2026-10-19 (pinned below); its
  // revoke stays checked here because this file still creates it.
  const definerFunctions = [
    "phx_hr_clearance_refresh_status",
    "phx_hr_clearance_open",
    "phx_hr_clearance_decide",
    "phx_hr_clearance_release",
    "phx_hr_clearance_on_resignation",
  ];
  for (const fn of definerFunctions) {
    const revoke = sql
      .split("\n")
      .find((line) => line.startsWith(`revoke execute on function public.${fn}(`));
    assert.ok(revoke, `${fn} is never revoked — its default ACL leaves EXECUTE with PUBLIC`);
    assert.ok(
      revoke?.includes("from public, anon, authenticated;"),
      `${fn} is revoked from the wrong set. anon and authenticated inherit EXECUTE through PUBLIC ` +
        "membership, so a revoke that omits public changes nothing at all",
    );
    assert.ok(
      sql.includes(`grant execute on function public.${fn}(`),
      `${fn} is revoked but never re-granted to service_role. Revoking PUBLIC on a default ACL ` +
        "also strips service_role, so the route handlers would break",
    );
  }

  // ── 6b. A resignation opens no clearance checklist any more ────────────────────────────────────
  // Owner, 2026-10-19: "Stop the trigger". The module was removed on 2026-09-01 and its trigger was
  // not, so every resignation for seven weeks opened a seven-desk checklist that no screen could
  // tick — 34 of them, 238 pending items — which read exactly like 34 unsettled leavers. Read across
  // EVERY migration in file order with comments stripped, because the files that explain the trigger
  // name it in prose: the last statement to touch it must be a drop, so a later file that recreates
  // it without a screen to close what it opens fails here.
  const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
  const migrationStatements = (name: string) =>
    readFileSync(path.join(migrationsDir, name), "utf8").replace(/--[^\n]*/g, "");
  const triggerStatements = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .flatMap((name) =>
      [
        ...migrationStatements(name)
          .matchAll(/\b(create|drop)\s+trigger\s+(?:if\s+exists\s+)?trg_hr_clearance_on_resignation\b/gi),
      ].map((match) => ({ name, kind: match[1].toLowerCase() })),
    );
  assert.ok(
    triggerStatements.some((statement) => statement.kind === "create"),
    "no migration creates trg_hr_clearance_on_resignation — the matcher is stale",
  );
  const lastTriggerStatement = triggerStatements[triggerStatements.length - 1];
  assert.equal(
    lastTriggerStatement.kind,
    "drop",
    `${lastTriggerStatement.name} recreates trg_hr_clearance_on_resignation. The Clearance screen ` +
      "was removed on 2026-09-01, so every checklist it opens can never be closed, and an open " +
      "checklist reads as an unsettled leaver",
  );
  assert.match(
    migrationStatements(lastTriggerStatement.name),
    /drop\s+function\s+if\s+exists\s+public\.phx_hr_clearance_on_resignation\(\)/i,
    "the trigger was dropped but its trigger function was left behind with nothing to call it",
  );

  // ── 7. Every route action has a caller, or it is a promise the UI never keeps ──────────────────
  // The retention route exported PATCH while the register only ever POSTed, so a stay discussion's
  // follow-up could be raised and never closed: the overdue count could rise and never fall. That
  // is not visible in a permission table or in a type — the route compiles, the permission
  // resolves, the button simply does not exist. So the check is that the set of actions the server
  // accepts equals the set the client sends.
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
}
