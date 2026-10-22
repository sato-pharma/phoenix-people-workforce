import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { ApiError } from "../src/lib/http/api-errors.ts";
import { PHOENIX_CRM_MODULE_KEYS, PHOENIX_CRM_MODULES, PHOENIX_CRM_TEST_TAB_LABEL, phoenixCrmModuleForSlug } from "../src/lib/phoenix-crm/modules.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, personKey, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import {
  assertListRequestApprover,
  assertPlanEditApprover,
  assertReviewer,
  assertTestWorldDecider,
  assertUnplannedVisitApprover,
  canDecideListRequest,
  canDecidePlanEdit,
  canDecideUnplannedVisit,
  canReviewTerritory,
  decidesTestWorld,
  testModeFor,
  worldFor,
  type PhoenixCrmViewer,
} from "../src/lib/phoenix-crm/server/access.ts";
import { managerAskDeciderRole, managerPlanDeciderRole } from "../src/lib/phoenix-crm/server/manager-plan-reach.ts";
import { decideTestApproval, TEST_APPROVAL_KINDS } from "../src/lib/phoenix-crm/server/test-approvals.ts";

/**
 * THE SUPER ADMIN'S "Test accounts" TAB — owner, 2026-10-22: *"In Phoenix CRM, in admin account, add a new
 * tab called Test accounts. It will be responsible for all approvals that I do with test accounts …
 * anything that needs approval in Phoenix CRM, I can submit it in the test account and approve in my own
 * admin account."* His three picks the same day, each pinned here:
 *
 *   1. STEP BY STEP — he takes the step a test entry is AT, recorded under that step's own role, so a
 *      two-step entry comes back at its second step;
 *   2. ONLY HIS TAB — a test manager login decides no test entry any more;
 *   3. REAL ROWS UNCHANGED — every real decision of his is still refused by `superAdminDoesNotDecide`.
 *
 * And the plumbing that makes the tab real: the module key, its place in the order, the label, the two
 * routes and their registry entries, and the decide path that reads the row's own `is_test` and refuses
 * a real row by name before anything is dispatched.
 */

const NSM: OrgSeat = {
  seatId: "SEAT-AIF-NSM",
  parentSeatId: "SEAT-ROOT-CEO",
  tier: "NSM",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-NSM"],
  occupantHrId: "B-900",
  lineCode: "anti_infective",
  lineName: "Anti Infective",
  areaName: null,
  regionName: null,
  seatLabel: "AIF NSM",
};
const DM: OrgSeat = {
  ...NSM,
  seatId: "SEAT-AIF-DM-D1",
  parentSeatId: "SEAT-AIF-NSM",
  tier: "DM",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-NSM", "SEAT-AIF-DM-D1"],
  occupantHrId: "B-12",
  regionName: "Delta (1)",
  seatLabel: "AIF Delta (1) DM",
};
const REP: OrgSeat = {
  ...DM,
  seatId: "SEAT-AIF-REP-D13",
  parentSeatId: "SEAT-AIF-DM-D1",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-NSM", "SEAT-AIF-DM-D1", "SEAT-AIF-REP-D13"],
  occupantHrId: "B-7",
  areaName: "Menoufia 2",
  seatLabel: "AIF D13 rep",
};

const org = buildOrgIndex([NSM, DM, REP]);

type ViewerOptions = { superAdmin?: boolean; sfe?: boolean; testPersona?: boolean; canApprove?: boolean; canUpdate?: boolean };

function viewerFor(hrId: string, role: string, options: ViewerOptions = {}): PhoenixCrmViewer {
  const company = Boolean(options.superAdmin || options.sfe);
  return {
    hrId: personKey(hrId),
    role,
    isSuperAdmin: options.superAdmin ?? false,
    isSfeManager: options.sfe ?? false,
    isTestPersona: options.testPersona ?? false,
    basis: company ? "all" : "tree",
    canCreate: true,
    canApprove: options.canApprove ?? true,
    canUpdate: options.canUpdate ?? options.superAdmin ?? false,
    org,
    config: { lineRollout: [] },
    cairoToday: "2026-10-22",
    visitDay: "2026-10-22",
    openLines: new Set(["anti_infective"]),
    ownTerritories: ownTerritories(org, hrId),
    waitingTerritories: [],
    scopeTerritories: company ? org.territories : territoriesInScope(org, hrId, "tree"),
    waitingScopeTerritories: [],
    managerSeats: heldManagerSeats(org, hrId),
  } as unknown as PhoenixCrmViewer;
}

const owner = viewerFor("B-10", "Super Admin", { superAdmin: true });
const ownerNoGrant = viewerFor("B-10", "Super Admin", { superAdmin: true, canApprove: false, canUpdate: false });
const dm = viewerFor("B-12", "District Manager");
const sfe = viewerFor("B-300", "SFE Manager", { sfe: true });
const testDm = viewerFor("B-12", "District Manager", { testPersona: true });
const testNsm = viewerFor("B-900", "National Sales Manager", { testPersona: true });
const testSuperAdmin = viewerFor("B-10", "Super Admin", { superAdmin: true, testPersona: true });

function refusedWith(run: () => unknown, pattern: RegExp, message: string): void {
  assert.throws(run, (error: unknown) => error instanceof ApiError && error.status === 403 && pattern.test(error.message), message);
}

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

export async function runPhoenixCrmTestApprovalTests(): Promise<void> {
  // ── 1. Who decides the test world: the Super Admin, signed in as himself, with a deciding grant ──────
  {
    assert.equal(decidesTestWorld(owner), true, "the Super Admin decides the test world");
    assert.equal(decidesTestWorld(ownerNoGrant), false, "not without a deciding grant");
    assert.equal(decidesTestWorld(testSuperAdmin), false, "never through a test login");
    assert.equal(decidesTestWorld(dm), false, "a real district manager decides real entries only");
    assert.equal(decidesTestWorld(sfe), false, "and so does the SFE Manager");
    assert.equal(decidesTestWorld(testDm), false, "and a test manager login decides none (his pick: only my tab)");

    assert.doesNotThrow(() => assertTestWorldDecider(owner));
    refusedWith(() => assertTestWorldDecider(testDm), /decided by the Super Admin/, "a test login is told who decides it");
    refusedWith(
      () => assertTestWorldDecider(testDm),
      new RegExp(PHOENIX_CRM_TEST_TAB_LABEL),
      "and where — the tab's own label, from the one constant",
    );
    refusedWith(() => assertTestWorldDecider(dm), /Test entries are the Super Admin's/, "anybody else is told they are his");
  }

  // ── 2. Step by step: every gate on a test row is his, at every stage, and nobody else's ──────────────
  {
    for (const [name, viewer, expected] of [
      ["the Super Admin", owner, true],
      ["a test district manager", testDm, false],
      ["the real district manager", dm, false],
      ["the SFE Manager", sfe, false],
    ] as const) {
      assert.equal(canReviewTerritory(viewer, REP, true), expected, `${name}: approves a test plan`);
      assert.equal(canDecideUnplannedVisit(viewer, REP, true, "manager"), expected, `${name}: the manager step of a test off-plan visit`);
      assert.equal(canDecideUnplannedVisit(viewer, REP, true, "sfe"), expected, `${name}: the SFE step of a test off-plan visit`);
      assert.equal(canDecidePlanEdit(viewer, REP, true, "manager"), expected, `${name}: the manager step of a test request to edit`);
      assert.equal(canDecidePlanEdit(viewer, REP, true, "sfe"), expected, `${name}: the SFE step of a test request to edit`);
      assert.equal(canDecideListRequest(viewer, REP, true, null), expected, `${name}: a test grade change`);
      assert.equal(canDecideListRequest(viewer, REP, true, "manager"), expected, `${name}: the manager step of a test add or drop`);
      assert.equal(canDecideListRequest(viewer, REP, true, "sfe"), expected, `${name}: the SFE step of a test add or drop`);
      const gates: Array<() => void> = [
        () => assertReviewer(viewer, REP, true),
        () => assertUnplannedVisitApprover(viewer, REP, true, "manager"),
        () => assertUnplannedVisitApprover(viewer, REP, true, "sfe"),
        () => assertPlanEditApprover(viewer, REP, true, "manager"),
        () => assertPlanEditApprover(viewer, REP, true, "sfe"),
        () => assertListRequestApprover(viewer, REP, true, null),
        () => assertListRequestApprover(viewer, REP, true, "manager"),
        () => assertListRequestApprover(viewer, REP, true, "sfe"),
      ];
      for (const gate of gates) {
        if (expected) assert.doesNotThrow(gate, `${name} takes the step`);
        else refusedWith(gate, /Super Admin/, `${name} is refused, naming the Super Admin`);
      }
    }
  }

  // ── 3. Real rows unchanged: every real decision of his is still refused ─────────────────────────────
  {
    refusedWith(() => assertReviewer(owner, REP, false), /manager chain/, "a real plan is the territory's own chain's");
    refusedWith(() => assertUnplannedVisitApprover(owner, REP, false, "manager"), /manager chain/, "and a real off-plan visit");
    refusedWith(() => assertPlanEditApprover(owner, REP, false, "manager"), /manager chain/, "and a real request to edit");
    refusedWith(() => assertListRequestApprover(owner, REP, false, "manager"), /manager chain/, "and a real list request");
    assert.equal(canReviewTerritory(owner, REP, false), false, "no screen offers him a real decision");
    assert.equal(canReviewTerritory(dm, REP, false), true, "the real district manager keeps his");
    refusedWith(() => assertReviewer(testDm, REP, false), /test login/, "a test login still never touches a real row");
  }

  // ── 4. A manager's week: the Super Admin takes the step it is AT, under that step's own role ─────────
  {
    const testFirst = { stage: "first" as const, firstApproverHrId: personKey("B-900"), secondApproverHrId: personKey("B-1000"), isTest: true };
    const testSecond = { ...testFirst, stage: "second" as const };
    assert.equal(managerPlanDeciderRole(owner, testFirst), "first", "he takes the first approver's step, recorded as that step");
    assert.equal(managerPlanDeciderRole(owner, testSecond), "second", "and then the second approver's, one step at a time");
    assert.equal(managerPlanDeciderRole(testNsm, testFirst), null, "the test approver stored on the row no longer decides it");
    assert.equal(managerPlanDeciderRole(viewerFor("B-900", "National Sales Manager"), testFirst), null, "nor does the real one, across worlds");
    assert.equal(managerPlanDeciderRole(ownerNoGrant, testFirst), null, "nor the Super Admin without a deciding grant");
    const testAsk = { stage: "first" as const, approverHrId: personKey("B-900"), secondApproverHrId: null, isTest: true };
    assert.equal(managerAskDeciderRole(owner, testAsk), "first", "an ask to edit, a removal and a day ask go the same way");
    assert.equal(managerAskDeciderRole(testNsm, testAsk), null);
    const realFirst = { ...testFirst, isTest: false };
    assert.equal(managerPlanDeciderRole(owner, realFirst), "administrator", "on a real week he is still only the Administrator, never a step");
  }

  // ── 5. The tab asks for the test world by name, and only the Super Admin may ────────────────────────
  {
    assert.equal(worldFor(owner, false, { testWorld: true }), true, "his tab reads and decides the test world");
    assert.equal(worldFor(owner, true), false, "every other screen of his stays on real entries (the retired test mode)");
    assert.equal(worldFor(testDm, false), true, "a test login keeps its own world");
    assert.equal(worldFor(dm, true), testModeFor(dm, true), "everyone else is answered by testModeFor, unchanged");
    refusedWith(() => worldFor(dm, false, { testWorld: true }), /Super Admin/, "a real manager cannot ask for the test world by name");
    refusedWith(() => worldFor(testDm, false, { testWorld: true }), /decided by the Super Admin/, "nor can a test login");
  }

  // ── 6. The decide path: refuses before it reads, and refuses a real row by name ─────────────────────
  {
    const refusedAsync = async (run: () => Promise<unknown>, status: number, pattern: RegExp, message: string) => {
      await assert.rejects(run, (error: unknown) => error instanceof ApiError && error.status === status && pattern.test(error.message), message);
    };
    const anyId = "0b8e8b5e-6d4c-4e0e-9a39-4f1f2c3d4e5f";
    await refusedAsync(() => decideTestApproval(dm, { kind: "weekly_plan", id: anyId, decision: "approve" }), 403, /Super Admin/, "a real manager is refused before any row is read");
    await refusedAsync(() => decideTestApproval(testDm, { kind: "weekly_plan", id: anyId, decision: "approve" }), 403, /decided by the Super Admin/, "and so is a test login");
    await refusedAsync(() => decideTestApproval(owner, { kind: "nonsense", id: anyId, decision: "approve" }), 400, /Reload/, "an unknown kind is refused");
    await refusedAsync(() => decideTestApproval(owner, { kind: "weekly_plan", id: "not-a-uuid", decision: "approve" }), 400, /Reload/, "and an id that is not one");
    await refusedAsync(() => decideTestApproval(owner, { kind: "weekly_plan", id: anyId, decision: "refuse" }), 400, /Reload/, "and a decision the kind does not take");

    const service = source("src/lib/phoenix-crm/server/test-approvals.ts");
    const decide = service.slice(service.indexOf("export async function decideTestApproval("));
    const realCheck = decide.indexOf("row.is_test !== true");
    assert.ok(realCheck > 0, "the decision reads the row's own is_test");
    assert.ok(realCheck < decide.indexOf("switch (kind)"), "and refuses a real row BEFORE anything is dispatched");
    assert.match(decide, /This is a real entry/, "by name");
    for (const kind of TEST_APPROVAL_KINDS) {
      assert.ok(decide.includes(`case "${kind}":`), `${kind} is dispatched to its own decider`);
    }
    for (const decider of ["transitionManagerPlan", "decideManagerPlanEdit", "decideManagerCustomerRemoval", "decideSingleVisitDay"]) {
      assert.match(decide, new RegExp(`await ${decider}\\(viewer, \\{[^}]*\\}, \\{ testWorld: true \\}\\)`), `${decider} is asked for the test world by name`);
    }
    // The real screens' own deciders, never a second copy: no RPC is called from this file.
    assert.doesNotMatch(service, /callPhoenixCrm|\.rpc\(/, "every decision goes through the module's own decider");
    assert.match(service, /assertTestWorldDecider\(viewer\);[\s\S]*?const \{ seatIds, seatById \}/, "the read asks the gate before it reads");
  }

  // ── 7. The tab: its key, its place, its label, its routes ───────────────────────────────────────────
  {
    assert.equal(PHOENIX_CRM_MODULE_KEYS[PHOENIX_CRM_MODULE_KEYS.length - 1], "testAccounts", "the Super Admin's own tab is last");
    const entry = PHOENIX_CRM_MODULES.find((module) => module.key === "testAccounts");
    assert.equal(entry?.label, "Test accounts", "his own name for it");
    assert.equal(PHOENIX_CRM_TEST_TAB_LABEL, "Test accounts");
    assert.equal(phoenixCrmModuleForSlug("test-approvals")?.key, "testAccounts", "reached at an address that says no retired word");

    const overview = source("src/lib/phoenix-crm/server/overview.ts");
    assert.match(overview, /testAccounts: decidesTestWorld\(viewer\),/, "offered to exactly who its routes admit");
    const app = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
    assert.match(app, /"settings", "testAccounts"\]/, "last in the tab bar");
    assert.match(app, /testAccounts: PHOENIX_CRM_TEST_TAB_LABEL,/, "labelled from the one constant");
    assert.match(app, /10: "grid-cols-2 sm:grid-cols-5"/, "ten tabs fit the screen without shrinking the type");
    assert.match(app, /key === "testAccounts"\s*\?\s*testWaitingCount/, "its badge counts the test world's waiting items");
    assert.match(app, /overview\.tabs\.testAccounts && waitingForYou\.isTest && !test/, "only for him, and only when the counts are the test world's");

    const tab = source("src/components/phoenix-crm/test-accounts-tab.tsx");
    assert.match(tab, /Nothing from the test personas is waiting\./, "the empty state says so in his words");
    assert.match(tab, /useCrmGet<TestApprovalsView>\("\/api\/phoenix-crm\/test-approvals", "testApprovals"\)/);
    assert.doesNotMatch(tab, /<table/, "cards, never a table");
    assert.doesNotMatch(tab, /rounded-(?!none)/, "square corners");

    const read = source("app/api/phoenix-crm/test-approvals/route.ts");
    assert.match(read, /assertPermission\(access, "phoenix_crm", "read"\)/);
    assert.match(read, /NextResponse\.json\(\{ testApprovals, success: true \}\)/);
    const write = source("app/api/phoenix-crm/test-approvals/decide/route.ts");
    assert.match(write, /assertSameOriginMutation\(request\)/);
    assert.match(write, /assertPermission\(access, "phoenix_crm", "approve"\)/);
    const registry = source("src/lib/security/access-registry.ts");
    assert.match(registry, /methods: \["GET"\], pattern: "\/api\/phoenix-crm\/test-approvals", permission: \{ resource: "phoenix_crm", action: "read" \}/);
    assert.match(
      registry,
      /audit: \{ classification: "mutation", required: true \}, methods: \["POST"\], pattern: "\/api\/phoenix-crm\/test-approvals\/decide", permission: \{ resource: "phoenix_crm", action: "approve" \}, guard: "assert-permission", csrfRequired: true/,
    );
  }

  console.log("phoenix-crm test approvals: OK");
}
