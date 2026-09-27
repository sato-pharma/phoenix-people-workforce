import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  assertNotTestAccount,
  assertTestAccountMayRun,
  canBeMirrored,
  normalizeTestAccountLoginId,
  TEST_ACCOUNT_SAVE_REFUSAL,
  testAccountMayRun,
} from "../src/lib/auth/test-persona.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import {
  assertReviewer,
  assertUnplannedVisitApprover,
  canDecideUnplannedVisit,
  canReviewTerritory,
  canWriteAsRep,
  reportIncludesTest,
  territoryForRead,
  territoryForRepWrite,
  territoryForVisit,
  testModeFor,
  testReadSeats,
  type PhoenixCrmViewer,
} from "../src/lib/phoenix-crm/server/access.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * TEST ACCOUNTS — a production login that lives inside a real employee's portal and never saves as her.
 *
 * Owner, 2026-09-27: a test employee who "really works as if he is Aya Ibrahim, with her data, with her
 * account, with her everything", with a test manager beside him, where "if I submit a visit in Phoenix
 * CRM by the test employee it goes into his test data, not Aya Ibrahim's data", "always in the employee
 * portal, not the admin shell". What this file pins, in the order a failure would cost most:
 *
 *   1. NOTHING A TEST ACCOUNT SENDS OUTSIDE PHOENIX CRM IS SAVED. It reads as the real person, so a
 *      save anywhere else would be written as her. One guard, in `resolveAccessContext`, before the
 *      route runs — fail-closed for every module that has no test world.
 *   2. INSIDE PHOENIX CRM, EVERY READ AND SAVE IS A TEST ENTRY, whatever flag the screen sends — the
 *      Android app's test flag is the Super Admin's toggle and is false for everyone else.
 *   3. A TEST MANAGER DECIDES TEST ENTRIES ONLY, and only as the person he mirrors would; a real plan
 *      is refused to him outright.
 *   4. A TEST ACCOUNT'S REACH IS THE MIRRORED PERSON'S — never the Super Admin's company-wide test mode.
 *   5. ONLY AN EMPLOYEE-PORTAL ROLE CAN BE MIRRORED, which is what keeps it out of the admin shell.
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
const OTHER_REP: OrgSeat = {
  ...REP,
  seatId: "SEAT-AIF-REP-X9",
  parentSeatId: "SEAT-AIF-NSM",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-NSM", "SEAT-AIF-REP-X9"],
  occupantHrId: "B-901",
  areaName: "Elsewhere",
};

const org = buildOrgIndex([NSM, DM, REP, OTHER_REP]);

/** A viewer as resolvePhoenixCrmViewer builds it, for a person, with or without a test account. */
function viewerFor(hrId: string, role: string, options: { testPersona: boolean; canApprove?: boolean }): PhoenixCrmViewer {
  const scope = territoriesInScope(org, hrId, "tree");
  return {
    hrId,
    role,
    isSuperAdmin: false,
    isSfeManager: false,
    isTestPersona: options.testPersona,
    basis: "tree",
    canCreate: true,
    canApprove: options.canApprove ?? false,
    canUpdate: false,
    org,
    config: { lineRollout: [] },
    cairoToday: "2026-09-27",
    openLines: new Set(["anti_infective"]),
    ownTerritories: ownTerritories(org, hrId),
    waitingTerritories: [],
    scopeTerritories: scope,
    waitingScopeTerritories: [],
    managerSeats: heldManagerSeats(org, hrId),
  } as unknown as PhoenixCrmViewer;
}

function refusedWith(run: () => unknown, pattern: RegExp, message: string): void {
  assert.throws(run, (error: unknown) => error instanceof ApiError && error.status === 403 && pattern.test(error.message), message);
}

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export function runTestAccountTests(): void {
  const testAccess = createAccessContext({
    hrId: "B-7",
    loginId: "TEST-AYA",
    role: "Medical Rep",
    source: "session",
    testPersona: { loginId: "TEST-AYA", mirrorsHrId: "B-7" },
  });
  const realAccess = createAccessContext({ hrId: "B-7", loginId: "B-7", role: "Medical Rep", source: "session" });

  // ── 1. The write guard ───────────────────────────────────────────────────────────────────────────
  {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.equal(testAccountMayRun(method, "/api/leave-requests"), true, `a test account reads everything (${method})`);
    }
    for (const [method, path] of [
      ["POST", "/api/leave-requests"],
      ["POST", "/api/outstation/expenses"],
      ["PATCH", "/api/employees/B-7"],
      ["DELETE", "/api/notifications"],
      ["PUT", "/api/marketing-requests/1"],
      ["POST", "/api/activity/track"],
      // A prefix is a whole segment: a sibling that merely STARTS with the same letters is not CRM.
      ["POST", "/api/phoenix-crm-legacy/visits"],
    ] as const) {
      assert.equal(testAccountMayRun(method, path), false, `${method} ${path} must be refused to a test account`);
    }
    assert.equal(testAccountMayRun("POST", "/api/phoenix-crm/visits"), true, "Phoenix CRM saves, into its test world");
    assert.equal(testAccountMayRun("POST", "/api/auth/logout"), true, "a test account can sign itself out");

    refusedWith(
      () => assertTestAccountMayRun(testAccess, { method: "POST", url: "https://phoenix-hr.satopharma.com/api/leave-requests" }),
      /test account/,
      "the guard throws a 403 carrying the sentence the screen shows",
    );
    assert.doesNotThrow(() => assertTestAccountMayRun(testAccess, { method: "POST", url: "https://phoenix-hr.satopharma.com/api/phoenix-crm/plans" }));
    assert.doesNotThrow(
      () => assertTestAccountMayRun(realAccess, { method: "POST", url: "https://phoenix-hr.satopharma.com/api/leave-requests" }),
      "a real session is never touched by the guard",
    );
    refusedWith(() => assertNotTestAccount(testAccess), /test account/, "a server action is refused to a test account");
    assert.ok(TEST_ACCOUNT_SAVE_REFUSAL.includes("Nothing was changed"), "the refusal says nothing was changed");

    // The context: the field exists only on a test account's session, so no other context changes shape.
    assert.deepEqual(testAccess.testPersona, { loginId: "TEST-AYA", mirrorsHrId: "B-7" });
    assert.equal("testPersona" in realAccess, false, "an ordinary session carries no testPersona key at all");

    // It is wired where every API route resolves its caller, and where a server action does.
    const server = source("src/lib/auth/server.ts");
    assert.ok(
      /export async function resolveAccessContext\(request: Request\)[\s\S]{0,900}assertTestAccountMayRun\(access, request\)/.test(server),
      "resolveAccessContext must run the test-account guard before any route gets its context",
    );
    assert.ok(/next-action[\s\S]{0,80}assertNotTestAccount\(access\)/.test(server), "a server action is refused to a test account");
    assert.ok(
      server.includes('"login_id, hr_id, role, is_active, session_version, is_test_persona, test_persona_of_hr_id"'),
      "the session lookup must read the test-account columns — a narrowed SELECT disarms every gate after it",
    );
    assert.ok(/hrId: effectiveHrId,[\s\S]{0,120}testPersona,/.test(server), "the context carries the mirror's HR id AND the test-account link");
  }

  // ── 2. Inside Phoenix CRM, a test account is always in the test world ────────────────────────────
  {
    const testRep = viewerFor("B-7", "Medical Rep", { testPersona: true });
    for (const flag of [false, true]) {
      assert.equal(territoryForRead(testRep, REP.seatId, flag).isTest, true, `a test rep reads test entries (flag ${flag})`);
      assert.equal(territoryForRepWrite(testRep, REP.seatId, flag).isTest, true, `a test rep's list and plan are test entries (flag ${flag})`);
      const visit = territoryForVisit(testRep, REP.seatId, flag);
      assert.equal(visit.isTest, true, `a test rep's visit is a test entry (flag ${flag})`);
      assert.equal(visit.enteredAs, "rep");
    }
    assert.equal(testModeFor(testRep, false), true, "a report across territories runs in test mode for a test account");
    assert.equal(reportIncludesTest(testRep, false), true, "a test account's reports carry its own test work");
    assert.equal(canWriteAsRep(testRep, REP, true), true);
    assert.equal(canWriteAsRep(testRep, REP, false), false, "a test account never writes a real entry");

    // The real Aya, on the same seat, is untouched: real entries, and test mode refused.
    const realRep = viewerFor("B-7", "Medical Rep", { testPersona: false });
    assert.equal(territoryForRepWrite(realRep, REP.seatId, false).isTest, false, "the real rep still writes real entries");
    refusedWith(() => territoryForRepWrite(realRep, REP.seatId, true), /Super Admin/, "the real rep cannot ask for test entries");
    refusedWith(() => testModeFor(realRep, true), /Super Admin/, "nor read them");
  }

  // ── 3. The test manager decides test entries only, as the person he mirrors ──────────────────────
  {
    const testManager = viewerFor("B-12", "District Manager", { testPersona: true, canApprove: true });
    assert.doesNotThrow(() => assertReviewer(testManager, REP, true), "he approves the test rep's test plan");
    refusedWith(() => assertReviewer(testManager, REP, false), /test login/, "a REAL plan is refused to a test manager");
    assert.equal(canReviewTerritory(testManager, REP, true), true);
    assert.equal(canReviewTerritory(testManager, REP, false), false);
    assert.equal(canDecideUnplannedVisit(testManager, REP, true, "manager"), true, "he takes the manager step of a test off-plan visit");
    assert.equal(canDecideUnplannedVisit(testManager, REP, true, "sfe"), false, "the SFE step is never a test account's");
    refusedWith(() => assertUnplannedVisitApprover(testManager, REP, false, "manager"), /test login/, "a real off-plan visit is refused");
    assert.equal(territoryForVisit(testManager, REP.seatId, false).isTest, true, "his double visit is a test entry too");

    // A test account mirroring somebody who is NOT the reviewer decides nothing, test or not.
    const testOtherRep = viewerFor("B-901", "Medical Rep", { testPersona: true, canApprove: true });
    refusedWith(() => assertReviewer(testOtherRep, REP, true), /reviewing manager/, "only the mirrored REVIEWER decides a test entry");
  }

  // ── 4. The reach is the mirrored person's, never the Super Admin's company ───────────────────────
  {
    const testRep = viewerFor("B-7", "Medical Rep", { testPersona: true });
    assert.deepEqual(
      testReadSeats(testRep, true, testRep.scopeTerritories).map((seat) => seat.seatId),
      [REP.seatId],
      "a test rep reads his own territory, not every territory in the company",
    );
    refusedWith(() => territoryForRead(testRep, OTHER_REP.seatId, true), /outside your scope/, "another rep's territory is outside his scope");
    refusedWith(() => territoryForRepWrite(testRep, OTHER_REP.seatId, true), /territory's rep/, "and not his to change");

    const superAdmin = { ...testRep, isSuperAdmin: true, isTestPersona: false } as PhoenixCrmViewer;
    assert.equal(testReadSeats(superAdmin, true, []).length, org.territories.length, "the Super Admin's own test mode is unchanged");
  }

  // ── 5. Who can be mirrored, and what a test login looks like ─────────────────────────────────────
  {
    for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Employee"]) {
      assert.equal(canBeMirrored(role), true, `${role} lives in the employee portal and can be mirrored`);
    }
    for (const role of ["Super Admin", "CEO", "SFE Manager", "HR Operations", "HR Advisory", "Finance Manager"]) {
      assert.equal(canBeMirrored(role), false, `${role} is an admin-shell role and can never be mirrored`);
    }
    assert.equal(normalizeTestAccountLoginId("test-aya"), "TEST-AYA");
    assert.equal(normalizeTestAccountLoginId("TEST-DINA-2"), "TEST-DINA-2");
    for (const bad of ["AYA", "B-7", "TEST-", "TEST--X", "TEST-AYA IBRAHIM", "TEST-" + "X".repeat(31), null]) {
      assert.equal(normalizeTestAccountLoginId(bad), null, `${String(bad)} is not a test login`);
    }
  }

  // ── The risk review's holes (2026-09-28) stay closed ─────────────────────────────────────────────
  {
    // HIGH: a real plan found by its id must not be submitted or reopened by a test login — the gate
    // answers with the test world, so its answer is compared, never thrown away.
    const plans = source("src/lib/phoenix-crm/server/plans.ts");
    assert.ok(
      /if \(territoryForRepWrite\(viewer, seat\.seatId, isTest\)\.isTest !== isTest\) \{\s*throw notFoundError/.test(plans),
      "submit and reopen compare the gate's world with the plan's, so a test login cannot move a REAL plan",
    );
    const testRep = viewerFor("B-7", "Medical Rep", { testPersona: true });
    assert.notEqual(territoryForRepWrite(testRep, REP.seatId, false).isTest, false, "the gate never answers 'real' to a test login");

    // MEDIUM: no push identity — OneSignal.login(her id) would move the device onto HER push user.
    assert.ok(
      /const hrId = access\.testPersona \? null :/.test(source("app/api/notifications/push/context/route.ts")),
      "a test login is given no push identity",
    );

    // Reads that write: none of them may write for a test login.
    assert.ok(/if \(stale\.size > 0 && !access\.testPersona\)/.test(source("src/lib/notifications/in-app.ts")), "the bell never archives HER rows for a test login");
    assert.ok(/assertNotTestAccount\(access\);/.test(source("app/api/recruitment/interview-calendar/my-calendar-feed/route.ts")), "no lasting link to HER interview calendar");
    assert.ok(/if \(input\.access\.testPersona\) return;/.test(source("src/lib/marketing-requests/roi-report-service.ts")), "no export audit row names her");
    const outstation = source("src/lib/outstation/service.ts");
    assert.equal((outstation.match(/getResidenceLocationForEmployee\(identity\.employeeHrId, \{ persist: !access\.testPersona \}\)/g) ?? []).length, 3, "her residence is never geocoded into her row by a test login");
    assert.ok(/if \(geocoded && options\.persist === false\) \{/.test(outstation), "persist: false answers without writing");

    // Every password path skips the Supabase bridge for a test login.
    assert.ok(/if \(row\.is_test_persona !== true\) try \{/.test(source("src/lib/auth/change-password.ts")), "change-password skips the bridge");
    assert.ok(/if \(currentUser\.is_test_persona !== true\) try \{/.test(source("src/lib/auth/password-setup.ts")), "password setup skips the bridge");
    assert.ok(/PHOENIX_SKIP_SUPABASE_AUTH_BRIDGE === "true" \|\| user\.isTestPersona/.test(source("app/api/auth/login/route.ts")), "sign-in skips the bridge");
  }

  // ── The one test-row leak into a real verdict stays closed ───────────────────────────────────────
  {
    const behaviour = source("src/lib/phoenix-crm/server/behaviour.ts");
    assert.ok(
      /from\("phoenix_crm_places"\)\.select\("seat_id, area_code"\)\.in\("seat_id", seatIds\)\.eq\("is_test", false\)/.test(behaviour),
      "the nightly behaviour verdict reads REAL places only — test places sit on real seats",
    );
    for (const path of ["src/lib/phoenix-crm/server/photos.ts", "src/lib/phoenix-crm/server/voice-notes.ts", "src/lib/phoenix-crm/server/time-anchor.ts"]) {
      assert.ok(/\.eq\("is_test", (input\.)?isTest\)\s*\.gte\("issued_at", since\)/.test(source(path)), `${path}: the hourly allowance is counted per world`);
    }
  }
}
