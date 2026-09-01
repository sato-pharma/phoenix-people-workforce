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
 *    Operations and `retention` to HR Advisory — they must NOT cross, because splitting them is the
 *    whole reason the function catalogue exists. A single "helpful" edit granting both to both
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

/** The two resources this file governs. */
const PAIR = ["mailbox_offboarding", "retention"] as const;

/** Who may hold each resource at all, after hard boundaries. Everyone else must hold nothing. */
const EXPECTED_HOLDERS: Record<(typeof PAIR)[number], PhoenixRole[]> = {
  mailbox_offboarding: ["Super Admin", "HR Operations", "CEO"],
  retention: ["Super Admin", "HR Advisory", "CEO"],
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
      "they think of their manager and their pay; that is hrbp 3, held by HR Advisory alone.",
  );
  assert.equal(
    actionsFor("HR Advisory", "mailbox_offboarding").length,
    0,
    "HR Advisory holds the mailbox revocation register. Closing a leaver's company mail is ops 6, " +
      "and it belongs to HR Operations.",
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
    (operations.mailbox_offboarding ?? []).length > 0,
    "HR Operations' composed bundle carries no mailbox_offboarding grant — it must come from people_records",
  );
  assert.ok(
    HR_ROLE_BUNDLES["HR Advisory"].includes("engagement_retention"),
    "HR Advisory no longer holds engagement_retention — the retention grant above is not traceable",
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
    sourcesFor("HR Advisory").includes("retention"),
    "HR Advisory's dashboard never loads the retention register, so her landing page cannot show it",
  );
  assert.ok(
    !sourcesFor("HR Operations").includes("retention"),
    "HR Operations' dashboard loads the retention register, which she may not read at all",
  );
  // The removed module must not leave a fetch behind either. A source key with no tiles is a live
  // Supabase round trip on every landing-page render, paid for by a seat who sees nothing for it.
  for (const seat of ["HR Advisory", "HR Operations"] as const) {
    assert.ok(
      !(sourcesFor(seat) as string[]).includes("clearance"),
      `${seat}'s dashboard still fetches clearance — the module is gone, so that is a round trip ` +
        "nobody can see the result of",
    );
  }

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
  } as unknown as HrCommandSources).flatMap((group) => group.tiles);
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

  // Nothing on either seat's landing page may still point at the deleted pages. A tile linking to a
  // route that no longer exists renders as a perfectly ordinary figure and 404s on click.
  const everyTile = [
    ...advisoryTiles,
    ...buildHrCommandGroups("HR Operations", {} as HrCommandSources).flatMap((g) => g.tiles),
  ];
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
  // ALL FIVE ARE STILL LIVE FUNCTIONS IN PRODUCTION. The app stopped calling them on 2026-09-01;
  // that removed the caller, not the function, and an unreachable-from-the-UI definer function with
  // a loose ACL is the worst version of this, not the safe one.
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
