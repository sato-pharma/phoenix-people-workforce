import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { isReadOnlyViewer } from "../src/lib/auth/read-only-viewer.ts";
import {
  assertNotTestAccount,
  assertTestAccountMayRun,
  canBeMirrored,
  normalizeTestAccountLoginId,
  TEST_ACCOUNT_SAVE_REFUSAL,
  testAccountMayRun,
} from "../src/lib/auth/test-persona.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import { testLoginMarkerOf, testNoticeVisibleToViewer } from "../src/lib/notifications/in-app.ts";
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
    // The column list moved out of an inline SELECT in this file and into phx_auth_session_bundle,
    // which resolves the whole auth trio in ONE round trip (2026-10-10 — the trio was 36% of every
    // PostgREST call Phoenix made). The gate is unchanged and still worth pinning: a narrowed list
    // disarms every persona check after it, silently, because a missing column reads as undefined
    // rather than failing. So it is pinned where the list now lives — in the RPC — and the branch
    // that consumes it is pinned here.
    const bundleRpc = source("supabase/migrations/20261010140000_phx_auth_session_bundle.sql");
    assert.ok(
      /select login_id, hr_id, role, is_active, session_version,\s+is_test_persona, test_persona_of_hr_id/.test(
        bundleRpc,
      ),
      "the session lookup must read the test-account columns — a narrowed SELECT disarms every gate after it",
    );
    assert.ok(
      /row\.is_test_persona === true/.test(server),
      "resolveSessionState must still branch on the account row's is_test_persona",
    );
    assert.ok(
      /test_persona_of_hr_id/.test(server),
      "the mirror link must still be read from the account row — without it a persona has no employee",
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
    // Retired 2026-10-03: the test world is a TEST- login's alone, so a `test` flag from the REAL
    // rep is read and dropped rather than refused — he writes and reads his own real entries, which
    // is what he was doing anyway. A 403 here would have been a blank screen for any tab open across
    // the deploy.
    assert.equal(territoryForRepWrite(realRep, REP.seatId, true).isTest, false, "the real rep's flag buys him nothing");
    assert.equal(testModeFor(realRep, true), false, "and reads him nothing");
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

    // 🔒 CHANGED 2026-10-03 WITH THE RETIREMENT OF THE SUPER ADMIN'S TEST MODE. This line used to
    // pin the opposite: that his test mode reached `org.territories` whatever scope it was handed —
    // the one read in the module that ignored the scope it was given. It is retired, so the rule now
    // is that NOBODY reaches past the scope passed in, and the test account's half above is what the
    // retirement had to leave untouched. Pinned from the other side by
    // `tests/phoenix-crm-admin-surface.test.ts`.
    const superAdmin = { ...testRep, isSuperAdmin: true, isTestPersona: false } as PhoenixCrmViewer;
    assert.equal(testReadSeats(superAdmin, true, []).length, 0, "the Super Admin no longer reaches past the scope he was given");
    assert.deepEqual(
      testReadSeats(superAdmin, true, testRep.scopeTerritories).map((seat) => seat.seatId),
      [REP.seatId],
      "he reads exactly the scope handed to him, as everybody else now does",
    );
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
      /const hrId = isReadOnlyViewer\(access\) \? null :/.test(source("app/api/notifications/push/context/route.ts")),
      "a test login is given no push identity",
    );

    // Reads that write: none of them may write for a test login.
    assert.ok(/if \(stale\.size > 0 && !isReadOnlyViewer\(access\)\)/.test(source("src/lib/notifications/in-app.ts")), "the bell never archives HER rows for a test login");
    assert.ok(/assertNotTestAccount\(access\);/.test(source("app/api/recruitment/interview-calendar/my-calendar-feed/route.ts")), "no lasting link to HER interview calendar");
    assert.ok(/if \(input\.access\.testPersona\) return;/.test(source("src/lib/marketing-requests/roi-report-service.ts")), "no export audit row names her");
    const outstation = source("src/lib/outstation/service.ts");
    assert.equal((outstation.match(/getResidenceLocationForEmployee\(identity\.employeeHrId, \{ persist: !isReadOnlyViewer\(access\) \}\)/g) ?? []).length, 3, "her residence is never geocoded into her row by a test login");
    // isReadOnlyViewer must keep counting a test login — the three sites above lean on it for that.
    assert.equal(isReadOnlyViewer({ testPersona: { loginId: "TEST-AYA", mirrorsHrId: "B-7" } }), true, "a test login is a read-only viewer");
    assert.ok(/if \(geocoded && options\.persist === false\) \{/.test(outstation), "persist: false answers without writing");

    // Every password path skips the Supabase bridge for a test login.
    assert.ok(/if \(row\.is_test_persona !== true\) try \{/.test(source("src/lib/auth/change-password.ts")), "change-password skips the bridge");
    assert.ok(/if \(currentUser\.is_test_persona !== true\) try \{/.test(source("src/lib/auth/password-setup.ts")), "password setup skips the bridge");
    assert.ok(/PHOENIX_SKIP_SUPABASE_AUTH_BRIDGE === "true" \|\| user\.isTestPersona/.test(source("app/api/auth/login/route.ts")), "sign-in skips the bridge");
  }

  // ── The one test-row leak into a real verdict stays closed ───────────────────────────────────────
  {
    const behaviour = source("src/lib/phoenix-crm/server/behaviour.ts");
    // 🔴 The read moved into `readSeatRows` on 2026-10-02, because PostgREST stops at 1,000 rows and
    // an unpaged places read silently left a seat with no areas at all — which made
    // `flat_coverage_no_sales` fire on a rep who covered his list and sold behind it. The invariant
    // this block exists for is unchanged and is now read in two halves: the call site asks for real
    // rows, and the reader applies that to the places table.
    assert.ok(
      /readSeatRows\(supabase, "phoenix_crm_places", "id, seat_id, area_code", seatIds, true\)/.test(behaviour),
      "the nightly behaviour verdict asks readSeatRows for REAL places only — test places sit on real seats",
    );
    const seatReader = behaviour.slice(behaviour.indexOf("async function readSeatRows"), behaviour.indexOf("async function readStrongCaseReps"));
    assert.ok(
      /realOnly \? query\.eq\("is_test", false\)/.test(seatReader),
      "and that argument is what applies .eq(is_test, false) — without this the flag would be decorative",
    );
    for (const path of ["src/lib/phoenix-crm/server/photos.ts", "src/lib/phoenix-crm/server/voice-notes.ts", "src/lib/phoenix-crm/server/time-anchor.ts"]) {
      assert.ok(/\.eq\("is_test", (input\.)?isTest\)\s*\.gte\("issued_at", since\)/.test(source(path)), `${path}: the hourly allowance is counted per world`);
    }
  }

  // ── The test world tells the TEST ACCOUNTS, and never the person they mirror (owner, 2026-09-28) ──
  //
  // A test-world notice is ADDRESSED to the real employee, because `employee_hr_id` / `recipients`
  // is what the bell queries by. Only the marker keeps it off her bell — so the marker is the whole
  // safety boundary, and every assertion below is about it holding in one more direction.
  {
    const marked = { metadata: {}, test_login_id: "TEST-DF" };
    const viaMetadata = { metadata: { testLoginId: "test-df" }, test_login_id: null };
    const real = { metadata: { seatId: "SEAT-AIF-REP-D13" }, test_login_id: null };

    assert.equal(testLoginMarkerOf(marked), "TEST-DF", "the column marks the row");
    assert.equal(testLoginMarkerOf(viaMetadata), "TEST-DF", "the metadata copy marks it too, upper-cased");
    assert.equal(testLoginMarkerOf(real), null, "an ordinary notification carries no marker");

    // 🔴 THE HEADLINE. Dina Hamdy signs in as herself; a plan her TEST manager was sent must not be
    // on her bell. Everything else in this feature is a convenience; this is the promise.
    assert.equal(testNoticeVisibleToViewer(null, marked), false, "the REAL person never sees a test-world notice");
    assert.equal(testNoticeVisibleToViewer(null, viaMetadata), false, "not even when only the metadata copy survived");
    assert.equal(testNoticeVisibleToViewer("", marked), false, "an empty viewer login is not a match");

    assert.equal(testNoticeVisibleToViewer("TEST-DF", marked), true, "the test account it belongs to does see it");
    assert.equal(testNoticeVisibleToViewer("test-df", marked), true, "case never decides who is told");
    assert.equal(testNoticeVisibleToViewer("TEST-AYA", marked), false, "one test login never reads another's");

    assert.equal(testNoticeVisibleToViewer(null, real), true, "a real notification is unchanged for a real viewer");
    assert.equal(testNoticeVisibleToViewer("TEST-AYA", real), true, "and still reaches a test account reading her bell");

    // The bell applies it, and asks the database for the column it reads.
    const inApp = source("src/lib/notifications/in-app.ts");
    assert.ok(/\.filter\(\(row\) => testNoticeVisibleToViewer\(identity\.testLoginId, row\)\)/.test(inApp), "the bell filters every row through the marker");
    assert.ok(/event_type,test_login_id"/.test(inApp), "the bell selects the marker column");
    assert.ok(/testLoginId: access\.testPersona\?\.loginId \?\? null,/.test(inApp), "the viewer's own test login is what it compares against");

    // The writer: marker in BOTH carriers, in-app only, and a key of its own.
    const system = source("src/lib/notifications/system.ts");
    assert.ok(/test_login_id: testLoginId,/.test(system), "the column is written");
    assert.ok(/\.\.\.\(testLoginId \? \{ testLoginId \} : \{\}\),/.test(system), "and the metadata copy, which is all the no-column fallback can carry");
    assert.ok(
      /const deliveryChannels = cleanText\(input\.testLoginId\) \? channels\.filter\(\(channel\) => channel === "in_app"\) : channels;/.test(system) &&
        /for \(const channel of deliveryChannels\) \{/.test(system),
      "a marked notice is in-app alone: her Telegram, push and email are HERS",
    );

    // Phoenix CRM: the test world resolves recipients through the mirror directory, never directly.
    const crmNotify = source("src/lib/phoenix-crm/server/notifications.ts");
    assert.ok(!/if \(isTest\) return;/.test(crmNotify), "the test world no longer tells nobody");
    assert.ok(/const mirrors = await testAccountsMirroring\(delivery\.recipients\);/.test(crmNotify), "recipients become the TEST- logins that mirror them");
    assert.ok(/testLoginId: mirror\.loginId,/.test(crmNotify), "and the notice carries that login as its marker");
    assert.ok(/channels: \["in_app"\],/.test(crmNotify), "the test branch asks for in-app only");
    assert.ok(
      /idempotencyKey: `\$\{delivery\.idempotencyKey\}:test:\$\{mirror\.loginId\}`/.test(crmNotify),
      "a key of its own — a shared event_key would overwrite a REAL person's notification row",
    );
    assert.ok(/\[mirror\.hrId\],/.test(crmNotify), "addressed to the mirrored employee, which is the id the bell queries by");

    // The directory never guesses: inactive and malformed rows are dropped, not approximated.
    const directory = source("src/lib/auth/test-persona-directory.ts");
    assert.ok(/\.eq\("is_test_persona", true\)/.test(directory), "only a test account can mirror anybody");
    assert.ok(/\.eq\("is_active", true\)/.test(directory), "a disabled test account is told nothing");
    assert.ok(/if \(!loginId \|\| !hrId\) continue;/.test(directory), "a row that is not a usable test account is dropped, never fallen back on");
  }
}
