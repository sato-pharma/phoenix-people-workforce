import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { ApiError } from "../src/lib/http/api-errors.ts";
import {
  REPORT_FAMILY_ORDER,
  REPORT_FAMILY_TITLES,
  REPORT_GUIDE,
  SECTION_TITLES,
  groupReportSections,
  reportAnswers,
  type ReportSection,
} from "../src/lib/phoenix-crm/report-guide.ts";
import {
  reportIncludesTest,
  territoryForRead,
  territoryForRepWrite,
  territoryForValidation,
  territoryForVisit,
  testModeFor,
  testReadSeats,
  type PhoenixCrmViewer,
} from "../src/lib/phoenix-crm/server/access.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * PHOENIX CRM, THE ADMIN SIDE — owner, 2026-10-03:
 *
 *   *"in phoenix crm make any droplist have a combo box not just droplist i am talking now on admin
 *   account … in admin accounts i find many defaults usage not easy at all and reports not clear. the
 *   test in the phoenix crm is now irrelevant u can fully retire it. look the module in admin accounts
 *   needs a heavy full massive restructure to be tailored for admins without touching the reps
 *   account."*
 *
 * What this file pins, in the order a failure would cost most:
 *
 *   1. THE REP'S APP IS NOT TOUCHED. The module's screens are ONE component tree — the admin shell and
 *      the employee portal render the same files — so every admin-only change here rides on
 *      `CrmSurfaceContext`, whose DEFAULT MUST BE `portal`. A default of `admin` would hand a medical
 *      rep the admin's controls from a screen that merely forgot to declare itself, and it would do it
 *      silently, which is the one failure Golden Rule #1 cannot absorb.
 *   2. THE TEST WORLD IS THE SUPER ADMIN'S NO LONGER. The flag is read and DROPPED on a read rather
 *      than refused (a 403 would blank a tab open across the deploy) and a write is refused by name.
 *      A `TEST-` login keeps its own world — the reps' test logins were explicitly out of scope.
 *   3. EVERY REPORT CARRIES THE QUESTION IT ANSWERS. The catalogue is data, so a report added without
 *      one fails here instead of reaching him as another unexplained chip.
 *   4. AN ADMIN ACCOUNT DOES NOT OPEN ON ONE REP'S ENTRY SCREEN.
 */

const NSM: OrgSeat = {
  seatId: "SEAT-PED-NSM",
  parentSeatId: "SEAT-ROOT-CEO",
  tier: "NSM",
  path: ["SEAT-ROOT-CEO", "SEAT-PED-NSM"],
  occupantHrId: "B-900",
  lineCode: "pedia",
  lineName: "Pedia",
  areaName: null,
  regionName: null,
  seatLabel: "Pedia NSM",
};
const DM: OrgSeat = {
  ...NSM,
  seatId: "SEAT-PED-DM-D1",
  parentSeatId: "SEAT-PED-NSM",
  tier: "DM",
  path: ["SEAT-ROOT-CEO", "SEAT-PED-NSM", "SEAT-PED-DM-D1"],
  occupantHrId: "B-12",
  regionName: "Delta (1)",
  seatLabel: "Pedia Delta (1) DM",
};
const REP: OrgSeat = {
  ...DM,
  seatId: "SEAT-PED-REP-D13",
  parentSeatId: "SEAT-PED-DM-D1",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-PED-NSM", "SEAT-PED-DM-D1", "SEAT-PED-REP-D13"],
  occupantHrId: "B-7",
  areaName: "Tanta 2",
  seatLabel: "Pedia D13 rep",
};

const org = buildOrgIndex([NSM, DM, REP]);

function viewerFor(
  hrId: string,
  role: string,
  options: { superAdmin?: boolean; testPersona?: boolean } = {},
): PhoenixCrmViewer {
  return {
    hrId,
    role,
    isSuperAdmin: options.superAdmin ?? false,
    isSfeManager: false,
    isTestPersona: options.testPersona ?? false,
    basis: options.superAdmin ? "all" : "tree",
    canCreate: true,
    canApprove: true,
    canUpdate: true,
    org,
    config: { lineRollout: [] },
    cairoToday: "2026-10-03",
    openLines: new Set(["pedia"]),
    ownTerritories: ownTerritories(org, hrId),
    waitingTerritories: [],
    scopeTerritories: options.superAdmin ? org.territories : territoriesInScope(org, hrId, "tree"),
    waitingScopeTerritories: [],
    managerSeats: heldManagerSeats(org, hrId),
  } as unknown as PhoenixCrmViewer;
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** The source with every comment removed, so no assertion below can be satisfied by prose about it. */
function code(path: string): string {
  return stripComments(source(path));
}

function refused(run: () => unknown, pattern: RegExp, message: string): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof ApiError && error.status === 403 && pattern.test(error.message),
    message,
  );
}

export function runPhoenixCrmAdminSurfaceTests(): void {
  // ── 1. The surface separator, and why its default is the rep's ────────────────────────────────
  {
    const surface = code("src/components/phoenix-crm/surface.tsx");
    assert.match(
      surface,
      /createContext<CrmSurface>\("portal"\)/,
      "🔴 the context's default MUST be portal: a screen that forgets to declare itself keeps the rep's plain controls, never gains the admin's",
    );
    assert.match(surface, /useCrmSurface\(\) === "admin"/, "combo boxes are the admin surface's, decided by that one test");

    const ui = code("src/components/phoenix-crm/ui.tsx");
    // Both of the module's dropdowns ask the context and branch on it. The native <select> must still
    // be reachable, or the rep's picker is gone.
    for (const control of ["CrmSelect", "CrmBareSelect"]) {
      const body = ui.slice(ui.indexOf(`export function ${control}(`));
      assert.ok(body.length > 0, `${control} is exported from the module's own building blocks`);
      const next = body.slice(0, body.indexOf("export function", 1) === -1 ? undefined : body.indexOf("export function", 1));
      assert.match(next, /useCrmComboBoxes\(\)/, `${control} asks the surface which control this is`);
      assert.match(next, /<SearchableSelect/, `${control} is a combo box on an admin account`);
      assert.match(next, /<select/, `${control} is still a native select in the portal`);
    }
    assert.match(
      ui,
      /from "@\/components\/ui\/searchable-select"/,
      "it reuses the repo's own combo box rather than a second one written in the module",
    );

    // The page provides it ONCE, around everything, because every tab is a lazily imported chunk.
    const app = code("src/components/phoenix-crm/phoenix-crm-app.tsx");
    assert.match(app, /<CrmSurfaceProvider surface=\{surface\}>/, "the page declares its own surface");
    assert.equal(
      app.split("<CrmSurfaceProvider").length - 1,
      2,
      "both of the page's returns are wrapped — the closed-module one as well, or its empty state loses the admin's controls",
    );
  }

  // ── 2. The Super Admin's test world is retired ────────────────────────────────────────────────
  {
    const owner = viewerFor("B-10", "Super Admin", { superAdmin: true });
    const rep = viewerFor("B-7", "Medical Rep");
    const testRep = viewerFor("B-7", "Medical Rep", { testPersona: true });

    // 🔴 THE PRECONDITION OF EVERY REFUSAL BELOW. Each gate looks the seat up and checks scope, so a
    // fixture whose Super Admin could not see this territory would refuse him for the wrong reason and
    // the test would pass without pinning anything.
    assert.deepEqual(
      owner.scopeTerritories.map((seat) => seat.seatId),
      [REP.seatId],
      "the Super Admin's scope holds the territory he is refused on",
    );
    assert.deepEqual(
      rep.ownTerritories.map((seat) => seat.seatId),
      [REP.seatId],
      "and it is the rep's own, so his own write is the one being compared against",
    );

    // A READ: the flag is read and DROPPED, never honoured and never a refusal.
    for (const flag of [true, false]) {
      assert.equal(
        territoryForRead(owner, REP.seatId, flag).isTest,
        false,
        `the Super Admin reads the field force's own entries (flag ${flag})`,
      );
      assert.equal(territoryForRead(rep, REP.seatId, flag).isTest, false, `and so does the rep (flag ${flag})`);
      assert.equal(territoryForRead(testRep, REP.seatId, flag).isTest, true, `a TEST- login keeps its own world (flag ${flag})`);
    }

    // A WRITE: refused by name, with the one real path he has always had named in the refusal.
    for (const [gate, run] of [
      ["the list and the plan", () => territoryForRepWrite(owner, REP.seatId, true)],
      ["a validation", () => territoryForValidation(owner, REP.seatId, true)],
      ["a visit", () => territoryForVisit(owner, REP.seatId, true)],
    ] as const) {
      refused(run, /The Super Admin does not/, `${gate}: his test write is refused even when the screen asks for the test world`);
      refused(run, /Record a missed visit/, `${gate}: and the refusal names the real path instead of a control that is gone`);
    }

    // The reports: no "include my test entries" for anybody but a test login.
    assert.equal(reportIncludesTest(owner, true), false, "the Super Admin's reports carry no test entries, however he asks");
    assert.equal(reportIncludesTest(rep, true), false, "nor a rep's");
    assert.equal(reportIncludesTest(testRep, false), true, "a TEST- login's reports are its own world's");
    assert.equal(testModeFor(owner, "true"), false, "and a read across territories runs on the real entries");
    assert.equal(testModeFor(testRep, false), true, "the test login's does not");
    assert.deepEqual(
      testReadSeats(owner, true, [REP]).map((seat) => seat.seatId),
      [REP.seatId],
      "a test read no longer reaches past the viewer's scope to every territory in the company",
    );

    // The screen: nothing left to switch, and no tick on the reports.
    const app = code("src/components/phoenix-crm/phoenix-crm-app.tsx");
    for (const gone of ["Test mode", "setTestMode", "Real entries", 'kind: "test"']) {
      assert.ok(!app.includes(gone), `the page carries no ${gone} any more`);
    }
    assert.match(app, /const test = viewer\.isTestPersona;/, "the page's one remaining test world is a TEST- login's");
    const reports = code("src/components/phoenix-crm/reports-tab.tsx");
    assert.ok(!reports.includes("Include my test entries"), "the reports tab offers no test tick");
    assert.match(reports, /const withTest = test;/, "and carries test entries only for a test login");
    assert.match(
      code("src/lib/phoenix-crm/server/reports.ts"),
      /canIncludeTest: false/,
      "the server offers the tick to nobody, so a stale screen cannot resurrect it",
    );
    assert.ok(
      !code("src/lib/phoenix-crm/server/double-visit-plans.ts").includes("Switch on test mode"),
      "and no refusal anywhere still points at the retired toggle",
    );
  }

  // ── 3. Every report says what it answers ──────────────────────────────────────────────────────
  {
    const sections = Object.keys(SECTION_TITLES) as ReportSection[];
    assert.equal(sections.length, 15, "fifteen reports, as the tab offers them");
    for (const section of sections) {
      const entry = REPORT_GUIDE[section];
      assert.ok(entry, `${section} is in the guide`);
      assert.ok(REPORT_FAMILY_ORDER.includes(entry.family), `${section} belongs to one of the named subjects`);
      assert.ok(entry.note.length > 0 && entry.note.length <= 40, `${section}'s short note is short`);
      assert.ok(
        entry.answers.length >= 60,
        `${section} answers a question in a sentence, not in three words — that is the whole point of the guide`,
      );
      assert.ok(entry.answers.trim().endsWith("."), `${section}'s answer is written as a sentence`);
      assert.equal(reportAnswers(section), entry.answers, `${section} reads its answer through the one accessor`);
    }
    for (const family of REPORT_FAMILY_ORDER) {
      assert.ok(REPORT_FAMILY_TITLES[family].length > 0, `${family} has a heading a reader can see`);
    }

    // A subject nobody was offered a report for is left OUT, never drawn as an empty heading.
    const offered = [{ value: "visits" as const }, { value: "plan" as const }];
    const groups = groupReportSections(offered);
    assert.deepEqual(
      groups.map((group) => group.family),
      ["work"],
      "only the subjects with something under them are grouped",
    );
    assert.deepEqual(
      groups[0]?.sections.map((entry) => entry.value),
      ["visits", "plan"],
      "and the reports keep the order they were offered in",
    );
    assert.deepEqual(groupReportSections([]), [], "nothing offered draws nothing");

    // 🔴 THE TAB MUST OFFER EVERY SECTION THE GUIDE KNOWS, or a report exists with no way to open it.
    const reports = code("src/components/phoenix-crm/reports-tab.tsx");
    for (const section of sections) {
      assert.ok(reports.includes(`offer("${section}")`), `the tab offers ${section}`);
    }
    assert.match(reports, /combo\s*\?\s*reportAnswers\(activeSection\)\s*:\s*REPORTS_DESCRIPTION;/, "the admin reads the question this report answers");
    // 🔴 WITH ONE EXCEPTION, AND IT IS NOT AN ADMIN/PORTAL ONE. "Double and chain visits" answers
    // "each manager", because its rows are the managers above a team — but a product manager reads
    // that same report about HIMSELF (owner, 2026-10-07), one row with no team on it, so the sentence
    // would be false of what he is looking at. His question is shown on every surface, because the
    // reason he opens it at all is that he could not tell where the visits he rode had gone.
    assert.match(
      reports,
      /productsAudience && activeSection === "managers"\s*\?\s*OWN_RIDE_ALONGS_ANSWER/,
      "and the double visitor reads the question HIS version of that report answers",
    );
    assert.match(reports, /sectionGroups\.map\(\(group\)/, "and picks a report by subject");
  }

  // ── 4. An admin account opens on the company, never on one rep's entry screen ──────────────────
  {
    const rules = code("src/lib/phoenix-crm/opening-tab.ts");
    const opening = rules.slice(rules.indexOf("function openingTab("), rules.indexOf("function territoriesFor("));
    assert.ok(opening.length > 0, "openingTab is where the landing tab is decided");
    assert.match(opening, /surface === "admin" && !viewer\.isRep/, "the admin landing is decided by the surface, never by the role alone");
    assert.match(opening, /if \(tabs\.team\) return "team";/, "he lands on the whole company");
    assert.match(opening, /if \(tabs\.reports\) return "reports";/, "or on the reports, where there is no Team tab");
    assert.match(opening, /return allowed\[0\] \?\? "visits";/, "the portal's own landing is untouched");

    // The territory picker: 74 seats are typed into, not scrolled, and the LINE is in the option
    // itself because the combo box flattens optgroup.
    const app = code("src/components/phoenix-crm/phoenix-crm-app.tsx");
    const picker = app.slice(app.indexOf("function territoryPicker("), app.indexOf("function questionNote("));
    assert.ok(picker.length > 0, "territoryPicker is the module's own territory dropdown");
    assert.match(picker, /const combo = surface === "admin";/, "the picker knows which surface it is on");
    assert.match(picker, /\$\{group\.line\} · \$\{placeOf\(territory\)\}/, "an admin's option carries its line, so typing a line narrows the list");
    assert.match(picker, /<optgroup key=\{group\.line\} label=\{group\.line\}>/, "and the portal keeps its grouped native dropdown");
  }
}
