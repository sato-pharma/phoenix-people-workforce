import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { dayLabel } from "../src/components/phoenix-crm/format.ts";
import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import { formatPhoenixLongDate } from "../src/lib/i18n/format.ts";
import { PHOENIX_CRM_EMAIL_EVENT_TYPES, phoenixCrmChannels } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, personKey, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { canWriteAsRep, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { phoenixCrmRefusal } from "../src/lib/phoenix-crm/server/db.ts";
import { visitAskDeliveries } from "../src/lib/phoenix-crm/server/notifications.ts";
import {
  assertVisitAskAnswerer,
  canAnswerVisitAsk,
  raiseVisitAskFromVisit,
  visitAskInboxReach,
  visitAskSavedNote,
  type VisitAskGateRow,
} from "../src/lib/phoenix-crm/server/visit-asks.ts";
import {
  isVisitAskAskableRole,
  isVisitAskOpen,
  productManagersOfLine,
  raisesVisitAsk,
  resolveVisitAskAddressees,
  resolveVisitAskDay,
  VISIT_ASK_ASKABLE_ROLES,
  VISIT_ASK_CHOICE_LABELS,
  VISIT_ASK_DAYS_AHEAD,
  VISIT_ASK_MARKETING_MANAGER_LINE_CODES,
  VISIT_ASK_NEXT_STEP,
  VISIT_ASK_PRODUCT_MANAGER_ROLES,
  visitAskDayChoices,
  visitAskProductManagerRolesOfLine,
  visitAskInboxText,
  visitAskPartOf,
  visitAskStatusText,
  visitAskWithText,
  wishedVisitAskDay,
  type ProductManagerReach,
  type VisitAskAddresseeResult,
} from "../src/lib/phoenix-crm/visit-ask-rules.ts";
import { VISIT_NEXT_STEPS } from "../src/lib/phoenix-crm/visit-outcome.ts";

/**
 * Phoenix CRM — a rep's ask for a visit with somebody (owner, 2026-10-02).
 *
 * He picked "Double-visit asks reach DM: when a rep picks 'Arrange a double visit' as a next step, his
 * district manager sees the doctor and date. Nothing reads it today", and added: "the medical rep can
 * request a double visit with his manager / product manager / or request a chain visit to a certain
 * dr". His rulings: the product manager is one the rep picks from his line's product managers; a chain
 * visit is his district manager and the next manager up, and both are told; the rep sees "accepted,
 * Tue 6 Oct" on his request — and the district manager's own double-visit plan stays hidden from him.
 * And, asked the same day: "Hossam, for CNS only — CNS reps can pick Hossam Mohamed Reda for a
 * product-manager visit. Pedia and Anti Infective reps keep their own product managers only."
 *
 * What this file pins:
 *   1. who is asked — the organogram's reviewer, the next manager up where a district is vacant, a
 *      chain's two managers, and only the line's own product managers — the Marketing Manager on CNS
 *      alone, never outside it;
 *   2. the product managers of each line as production holds them on 2026-10-02;
 *   3. the days — today to four weeks on, never a Friday or a public holiday — and how an ask reads;
 *   4. the identity gate: only the person recorded as asked answers, in one world;
 *   5. who is told of each kind and step, never by email, each step once;
 *   6. the next step "Arrange a double visit" raises the ask by itself, once per visit, never costing
 *      the visit;
 *   7. the database half, and that nothing here reads or writes the district manager's own plan.
 */

// ── The organogram the matrix runs on ───────────────────────────────────────────────────────────

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: overrides.path.length > 1 ? overrides.path[overrides.path.length - 2] : null,
    occupantHrId: null,
    lineCode: "pedia",
    lineName: "Pedia",
    areaName: null,
    regionName: null,
    seatLabel: null,
    ...overrides,
  };
}

const CEO = seat({ seatId: "SEAT-CEO", tier: "CEO", path: ["SEAT-CEO"], occupantHrId: "B-2", lineCode: null, lineName: null });
const NSM = seat({ seatId: "SEAT-PED-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-PED-NSM"], occupantHrId: "A-12" });
// Delta (1): the district manager sits straight under the national manager.
const DM1 = seat({ seatId: "SEAT-PED-DM-D1", tier: "DM", path: [...NSM.path, "SEAT-PED-DM-D1"], occupantHrId: "B-40", regionName: "Delta (1)" });
const D11 = seat({ seatId: "SEAT-PED-REP-D11", tier: "REP", path: [...DM1.path, "SEAT-PED-REP-D11"], occupantHrId: "B-7", areaName: "Tanta", regionName: "Delta (1)" });
const D12 = seat({ seatId: "SEAT-PED-REP-D12", tier: "REP", path: [...DM1.path, "SEAT-PED-REP-D12"], occupantHrId: "B-8", areaName: "Mahalla", regionName: "Delta (1)" });
// Upper Egypt: a regional manager between the district and the national manager.
const RSM = seat({ seatId: "SEAT-PED-RSM-UE", tier: "RSM", path: [...NSM.path, "SEAT-PED-RSM-UE"], occupantHrId: "B-60", regionName: "Upper Egypt" });
const DMU = seat({ seatId: "SEAT-PED-DM-UE1", tier: "DM", path: [...RSM.path, "SEAT-PED-DM-UE1"], occupantHrId: "B-61", regionName: "Upper Egypt 1" });
const U11 = seat({ seatId: "SEAT-PED-REP-UE11", tier: "REP", path: [...DMU.path, "SEAT-PED-REP-UE11"], occupantHrId: "B-62", areaName: "Minia 1", regionName: "Upper Egypt 1" });
// A vacant district — the shape Cairo Pedia's district seat has today, on purpose.
const DMV = seat({ seatId: "SEAT-PED-DM-GZ", tier: "DM", path: [...NSM.path, "SEAT-PED-DM-GZ"], occupantHrId: null, regionName: "Giza" });
const G11 = seat({ seatId: "SEAT-PED-REP-GZ11", tier: "REP", path: [...DMV.path, "SEAT-PED-REP-GZ11"], occupantHrId: "B-80", areaName: "Dokki", regionName: "Giza" });
// The acting district manager, as production holds one: his acting seat, and his own rep seat UNDER it.
const ADM = seat({ seatId: "SEAT-PED-ADM-D2", tier: "ACTING_DM", path: [...NSM.path, "SEAT-PED-ADM-D2"], occupantHrId: "B-1", regionName: "Delta (2)" });
const A21 = seat({ seatId: "SEAT-PED-REP-D21", tier: "REP", path: [...ADM.path, "SEAT-PED-REP-D21"], occupantHrId: "B-1", areaName: "Mansoura", regionName: "Delta (2)" });
const A22 = seat({ seatId: "SEAT-PED-REP-D22", tier: "REP", path: [...ADM.path, "SEAT-PED-REP-D22"], occupantHrId: "B-90", areaName: "Damietta", regionName: "Delta (2)" });
// A line whose whole chain is vacant: nobody to ask.
const CNS_NSM = seat({ seatId: "SEAT-CNS-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-CNS-NSM"], occupantHrId: null, lineCode: "cns", lineName: "CNS" });
const CNS_DM = seat({ seatId: "SEAT-CNS-DM-C1", tier: "DM", path: [...CNS_NSM.path, "SEAT-CNS-DM-C1"], occupantHrId: null, lineCode: "cns", lineName: "CNS" });
const K11 = seat({
  seatId: "SEAT-CNS-REP-K11",
  tier: "REP",
  path: [...CNS_DM.path, "SEAT-CNS-REP-K11"],
  occupantHrId: "B-121",
  lineCode: "cns",
  lineName: "CNS",
  areaName: "Heliopolis",
});
// A CNS district with its manager in his seat: the one told when his rep asks the Marketing Manager.
const CNS_DM2 = seat({ seatId: "SEAT-CNS-DM-C2", tier: "DM", path: [...CNS_NSM.path, "SEAT-CNS-DM-C2"], occupantHrId: "B-130", lineCode: "cns", lineName: "CNS" });
const K21 = seat({
  seatId: "SEAT-CNS-REP-K21",
  tier: "REP",
  path: [...CNS_DM2.path, "SEAT-CNS-REP-K21"],
  occupantHrId: "B-131",
  lineCode: "cns",
  lineName: "CNS",
  areaName: "Nasr City",
});

const org = buildOrgIndex([CEO, NSM, DM1, D11, D12, RSM, DMU, U11, DMV, G11, ADM, A21, A22, CNS_NSM, CNS_DM, K11, CNS_DM2, K21]);
const OPEN_LINES: ReadonlySet<string> = new Set(["pedia", "cns"]);

/** Friday 2 October 2026, the day the owner asked for it. */
const FRIDAY = "2026-10-02";

type ViewerOptions = { superAdmin?: boolean; sfe?: boolean; testPersona?: boolean; canCreate?: boolean; canApprove?: boolean; company?: boolean };

/** A viewer exactly as resolvePhoenixCrmViewer builds one: the matrix grants, the organogram scope, open lines. */
function viewerFor(hrId: string, role: string, options: ViewerOptions = {}): PhoenixCrmViewer {
  const company = Boolean(options.superAdmin || options.sfe || options.company);
  const scope = company ? org.territories : territoriesInScope(org, hrId, "tree");
  const isOpen = (entry: OrgSeat) => Boolean(entry.lineCode && OPEN_LINES.has(entry.lineCode));
  const held = ownTerritories(org, hrId);
  return {
    hrId: personKey(hrId),
    role,
    isSuperAdmin: options.superAdmin ?? false,
    isSfeManager: options.sfe ?? false,
    isTestPersona: options.testPersona ?? false,
    basis: company ? "all" : "tree",
    canCreate: options.canCreate ?? true,
    canApprove: options.canApprove ?? true,
    canUpdate: options.superAdmin ?? false,
    org,
    config: { lineRollout: [] },
    cairoToday: FRIDAY,
    visitDay: FRIDAY,
    openLines: OPEN_LINES,
    ownTerritories: held.filter(isOpen),
    waitingTerritories: held.filter((entry) => !isOpen(entry)),
    scopeTerritories: options.superAdmin ? scope : scope.filter(isOpen),
    waitingScopeTerritories: [],
    managerSeats: heldManagerSeats(org, hrId),
  } as unknown as PhoenixCrmViewer;
}

// The phoenix_crm grants per role (tests/phoenix-crm-boundary.test.ts GRANTS).
const rep = viewerFor("B-7", "Medical Rep", { canApprove: false });
const dm = viewerFor("B-40", "District Manager");
const otherDm = viewerFor("B-61", "District Manager");
const nsm = viewerFor("A-12", "National Sales Manager", { canCreate: false });
const ceo = viewerFor("B-2", "CEO", { company: true, canCreate: false, canApprove: false });
const sfe = viewerFor("B-300", "SFE Manager", { sfe: true, canCreate: false });
const owner = viewerFor("B-10", "Super Admin", { superAdmin: true });
// A product manager holds no seat: he is an APP ROLE, and phoenix_crm `read` is all he holds.
const rasha = viewerFor("A-8", "Group Product Manager", { canCreate: false, canApprove: false });
const nahed = viewerFor("A-10", "Product Manager", { canCreate: false, canApprove: false });
const hossam = viewerFor("A-9", "Marketing Manager", { canCreate: false, canApprove: false });
const testDm = viewerFor("B-40", "District Manager", { testPersona: true });
const testRep = viewerFor("B-7", "Medical Rep", { testPersona: true, canApprove: false });
const testRasha = viewerFor("A-8", "Group Product Manager", { testPersona: true, canCreate: false, canApprove: false });

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

function refused(run: () => unknown, status: number, pattern: RegExp, message: string): void {
  assert.throws(run, (error: unknown) => error instanceof ApiError && error.status === status && pattern.test(error.message), message);
}

function refusedWithCode(run: () => unknown, status: number, code: string, message: string): void {
  assert.throws(run, (error: unknown) => error instanceof ApiError && error.status === status && error.code === code, message);
}

function addressees(result: VisitAskAddresseeResult): { askedHrId: string; toldHrId: string | null } | string {
  return result.ok ? result.value : result.kind;
}

// ── Production's product managers, read 2026-10-02 ──────────────────────────────────────────────

/**
 * Each sign-in holding a product manager's app role (or the Marketing Manager's) with the product
 * families his own product list covers — `app_auth_users.product_scope_override`, the field-heard
 * report's rule, through `familiesOfCodes`, which keeps a product the list names even when it is
 * no longer active.
 */
const REACH: ProductManagerReach[] = [
  // Rasha Sabry — the GROUP Product Manager.
  { hrId: "A-8", role: "Group Product Manager", families: ["Guamusin", "Ivyronc", "Lacto Advanced"] },
  // Hossam Mohamed Reda — the MARKETING Manager, whose list covers every line. Offered on CNS ONLY
  // (the owner's CNS rule); never on Pedia or Anti Infective, though his list covers them too.
  {
    hrId: "A-9",
    role: "Marketing Manager",
    families: ["Conviban", "Dolabactin", "Dopaminict", "Guamusin", "Ivyronc", "Lacto Advanced", "Rispadex", "Royafloxacin", "Saginko", "Tebofortin"],
  },
  // Nahed Tarek — Product Manager, Anti Infective.
  { hrId: "A-10", role: "Product Manager", families: ["Royafloxacin", "Saginko"] },
  // Ahmed SharafEldeen — Product Manager. Osteosat (Anti Infective) and Tigogrow are no longer active.
  { hrId: "B-155", role: "Product Manager", families: ["Guamusin", "Ivyronc", "Osteosat", "Tigogrow"] },
];

/** Each line's ACTIVE product families (`lineProductsByFamily`), as production holds them. */
const LINE_FAMILIES: Record<string, string[]> = {
  Pedia: ["Guamusin", "Ivyronc", "Lacto Advanced"],
  "Anti Infective": ["Royafloxacin", "Saginko"],
  CNS: ["Conviban", "Dolabactin", "Dopaminict", "Rispadex", "Tebofortin"],
};

const ASK = "6d1c2b4e-1f0a-4c7e-9a52-3e8f7b2d9c10";
const NAMES: ReadonlyMap<string, string> = new Map([
  ["B-7", "Mostafa Adel"],
  ["B-40", "Dina Hamdy"],
  ["A-12", "Ali Mohamed Ali"],
  ["A-8", "Rasha Sabry"],
  ["A-9", "Hossam Mohamed Reda"],
  ["B-130", "Karim Nabil"],
  ["B-131", "Omar Saeed"],
]);

export async function runPhoenixCrmVisitAsksTests(): Promise<void> {
  // ── 1. Who is asked ───────────────────────────────────────────────────────────────────────────
  {
    const ask = (
      seatId: string,
      kind: "double" | "chain" | "product_manager",
      repHrId: string,
      productManagerHrId?: unknown,
      productManagers = productManagersOfLine(REACH, LINE_FAMILIES.Pedia, "pedia"),
    ) => addressees(resolveVisitAskAddressees({ org, seatId, kind, repHrId, productManagers, productManagerHrId }));

    // A double visit: the territory's reviewer — his district manager.
    assert.deepEqual(ask(D11.seatId, "double", "B-7"), { askedHrId: "B-40", toldHrId: null }, "a double visit asks his district manager, and tells nobody else");
    assert.deepEqual(ask(U11.seatId, "double", "B-62"), { askedHrId: "B-61", toldHrId: null }, "under a regional manager too, it is the district manager");
    // A vacant district passes to the next manager up — exactly as a plan or a request is routed.
    assert.deepEqual(ask(G11.seatId, "double", "B-80"), { askedHrId: "A-12", toldHrId: null }, "a vacant district's double visit goes to the next manager up");
    // The acting district manager never reviews his own territory: his own asks go above him.
    assert.deepEqual(ask(A21.seatId, "double", "B-1"), { askedHrId: "A-12", toldHrId: null }, "an acting district manager's own territory asks the manager above him");
    assert.deepEqual(ask(A22.seatId, "double", "B-90"), { askedHrId: "B-1", toldHrId: null }, "and his rep asks him");
    // Nobody above at all: nothing to ask, said in words.
    assert.equal(ask(K11.seatId, "double", "B-121"), "no_manager", "a territory whose whole chain is vacant has nobody to ask");
    const noManager = resolveVisitAskAddressees({ org, seatId: K11.seatId, kind: "double", repHrId: "B-121", productManagers: [] });
    assert.ok(!noManager.ok && /no manager above it in the organogram/.test(noManager.error), "and says so, in words the rep can read");
    // The Super Admin trying it in the test world asks the territory's real chain, never himself.
    assert.deepEqual(ask(D11.seatId, "double", "B-10"), { askedHrId: "B-40", toldHrId: null }, "the Super Admin's test ask goes up the territory's own chain");

    // A chain visit: the district manager answers and picks the day; the next manager up is told.
    assert.deepEqual(ask(D11.seatId, "chain", "B-7"), { askedHrId: "B-40", toldHrId: "A-12" }, "a chain visit: the district manager, and the national manager above him");
    assert.deepEqual(ask(U11.seatId, "chain", "B-62"), { askedHrId: "B-61", toldHrId: "B-60" }, "or the regional manager, where one sits between");
    assert.deepEqual(ask(A22.seatId, "chain", "B-90"), { askedHrId: "B-1", toldHrId: "A-12" }, "the acting district manager and the manager above him");
    assert.equal(ask(G11.seatId, "chain", "B-80"), "no_senior", "a vacant district has only one manager above it — no chain to ask for");
    assert.equal(ask(A21.seatId, "chain", "B-1"), "no_senior", "nor the acting district manager's own territory");
    assert.equal(ask(K11.seatId, "chain", "B-121"), "no_manager");

    // A product manager's visit: one of HIS line's product managers, the one he picked; his district
    // manager is told.
    assert.deepEqual(ask(D11.seatId, "product_manager", "B-7", "A-8"), { askedHrId: "A-8", toldHrId: "B-40" }, "the product manager he picked answers, and his district manager is told");
    assert.deepEqual(ask(D11.seatId, "product_manager", "B-7", " b-155 "), { askedHrId: "B-155", toldHrId: "B-40" }, "an hr id is compared as a person, never by its case or spaces");
    assert.equal(ask(D11.seatId, "product_manager", "B-7", "A-10"), "not_line_product_manager", "another line's product manager cannot be picked");
    assert.equal(
      ask(D11.seatId, "product_manager", "B-7", "A-9"),
      "not_line_product_manager",
      "nor, by a Pedia rep, the Marketing Manager — the owner's CNS rule offers him on CNS alone",
    );
    assert.equal(
      ask(D11.seatId, "product_manager", "B-7", "A-9", productManagersOfLine(REACH, LINE_FAMILIES["Anti Infective"], "anti_infective")),
      "not_line_product_manager",
      "nor by an Anti Infective rep",
    );
    // The owner's CNS rule: a CNS rep picks the Marketing Manager; his district manager is told.
    assert.deepEqual(
      ask(K21.seatId, "product_manager", "B-131", "A-9", productManagersOfLine(REACH, LINE_FAMILIES.CNS, "cns")),
      { askedHrId: "A-9", toldHrId: "B-130" },
      "a CNS rep asks Hossam Mohamed Reda for a product manager visit, and his district manager is told",
    );
    assert.equal(ask(D11.seatId, "product_manager", "B-7", undefined), "not_line_product_manager", "a product manager's visit names the product manager");
    assert.equal(ask(D11.seatId, "product_manager", "B-7", { hrId: "A-8" }), "not_line_product_manager", "and only by an hr id");
    assert.equal(ask(D11.seatId, "product_manager", "B-7", "A-8", []), "no_product_manager", "a line with no product manager has none to offer");
    assert.equal(
      ask(D11.seatId, "product_manager", "B-7", "B-7", [{ hrId: "B-7", role: "Product Manager" }]),
      "not_line_product_manager",
      "nobody asks himself",
    );
    assert.deepEqual(
      ask(K11.seatId, "product_manager", "B-121", "A-8", [{ hrId: "A-8", role: "Group Product Manager" }]),
      { askedHrId: "A-8", toldHrId: null },
      "with no manager above the territory, nobody is told — the product manager is still asked",
    );
    assert.deepEqual(
      ask(G11.seatId, "product_manager", "B-80", "A-8"),
      { askedHrId: "A-8", toldHrId: "A-12" },
      "a vacant district's rep: the manager above it is the one told",
    );
  }

  // ── 2. The product managers of each line (production, 2026-10-02) ─────────────────────────────
  {
    assert.deepEqual([...VISIT_ASK_PRODUCT_MANAGER_ROLES], ["Product Manager", "Group Product Manager"], "two app roles are a product manager on every line");
    // The owner's CNS rule, by APP ROLE and line code — never a person.
    assert.deepEqual([...VISIT_ASK_MARKETING_MANAGER_LINE_CODES], ["cns"], "the Marketing Manager is offered on CNS alone");
    assert.deepEqual([...visitAskProductManagerRolesOfLine("cns")], ["Product Manager", "Group Product Manager", "Marketing Manager"], "on CNS he is offered beside them");
    assert.deepEqual([...visitAskProductManagerRolesOfLine(" CNS ")], [...visitAskProductManagerRolesOfLine("cns")], "a line code is read loosely");
    for (const line of ["pedia", "anti_infective", "", null, undefined]) {
      assert.deepEqual([...visitAskProductManagerRolesOfLine(line)], ["Product Manager", "Group Product Manager"], `${String(line)}: never the Marketing Manager outside CNS`);
    }
    assert.deepEqual([...VISIT_ASK_ASKABLE_ROLES], ["Product Manager", "Group Product Manager", "Marketing Manager"], "everyone an ask can reach on some line");

    assert.deepEqual(
      productManagersOfLine(REACH, LINE_FAMILIES.Pedia, "pedia"),
      [
        { hrId: "A-8", role: "Group Product Manager" },
        { hrId: "B-155", role: "Product Manager" },
      ],
      "Pedia: Rasha Sabry (Group Product Manager) and Ahmed SharafEldeen (Product Manager) — never the Marketing Manager, though his list covers Pedia",
    );
    assert.deepEqual(
      productManagersOfLine(REACH, LINE_FAMILIES["Anti Infective"], "anti_infective"),
      [{ hrId: "A-10", role: "Product Manager" }],
      "Anti Infective: Nahed Tarek — never the Marketing Manager; and Ahmed's Osteosat is no longer one of the line's products",
    );
    assert.deepEqual(
      productManagersOfLine(REACH, LINE_FAMILIES.CNS, "cns"),
      [{ hrId: "A-9", role: "Marketing Manager" }],
      "CNS: Hossam Mohamed Reda, the Marketing Manager — the owner's CNS rule (CNS has no product manager)",
    );
    assert.deepEqual(
      productManagersOfLine([{ hrId: "B-500", role: "Product Manager", families: ["Rispadex"] }, ...REACH], LINE_FAMILIES.CNS, "cns"),
      [
        { hrId: "B-500", role: "Product Manager" },
        { hrId: "A-9", role: "Marketing Manager" },
      ],
      "beside any product manager of CNS, never instead of one",
    );
    assert.deepEqual(
      productManagersOfLine([{ hrId: "A-9", role: "Marketing Manager", families: ["Guamusin", "Saginko"] }], LINE_FAMILIES.CNS, "cns"),
      [],
      "only when his own product scope covers CNS",
    );
    assert.deepEqual(
      productManagersOfLine([{ hrId: "A-9", role: "Marketing Manager", families: null }], LINE_FAMILIES.CNS, "cns").map((entry) => entry.hrId),
      ["A-9"],
      "a Marketing Manager with no bound at all covers CNS",
    );
    assert.deepEqual(
      productManagersOfLine([{ hrId: "A-9", role: "Marketing Manager", families: null }], LINE_FAMILIES.Pedia, "pedia"),
      [],
      "and still never Pedia's",
    );
    // A line with no product manager that is NOT CNS stays greyed, with its reason, whatever the
    // Marketing Manager's list covers.
    const otherLine = productManagersOfLine(REACH, ["Respirol"], "respiratory");
    assert.deepEqual(otherLine, [], "a line that is not CNS offers no Marketing Manager");
    const greyed = resolveVisitAskAddressees({ org, seatId: D11.seatId, kind: "product_manager", repHrId: "B-7", productManagers: otherLine, productManagerHrId: "A-9" });
    assert.ok(!greyed.ok && greyed.kind === "no_product_manager" && greyed.error === "No product manager covers your line's products yet.", "and the choice says why, in words");
    assert.deepEqual(
      productManagersOfLine([{ hrId: "B-500", role: "Product Manager", families: null }], LINE_FAMILIES.CNS, "cns"),
      [{ hrId: "B-500", role: "Product Manager" }],
      "a product manager with no bound at all covers every line",
    );
    assert.deepEqual(
      productManagersOfLine([{ hrId: "a-8", role: "Group Product Manager", families: ["lacto  advanced"] }], LINE_FAMILIES.Pedia, "pedia"),
      [{ hrId: "A-8", role: "Group Product Manager" }],
      "families are matched as names, never by their case or spacing, and the hr id is stored upper case",
    );
    assert.deepEqual(
      productManagersOfLine([REACH[0], { ...REACH[0], families: ["Guamusin"] }], LINE_FAMILIES.Pedia, "pedia").map((entry) => entry.hrId),
      ["A-8"],
      "each person once",
    );
    assert.deepEqual(productManagersOfLine([REACH[0]], [], "pedia"), [], "a line with no products on file offers nobody");

    // Their permission is NOT widened to answer: `read` is what each of them holds, and all he needs.
    for (const role of ["Product Manager", "Group Product Manager", "Marketing Manager"] as const) {
      assert.deepEqual([...(permissionMatrix[role].phoenix_crm ?? [])], ["read"], `${role} still holds phoenix_crm read and nothing else`);
    }
  }

  // ── 3. The days, and how an ask reads ───────────────────────────────────────────────────────────
  {
    const none = new Map<string, string>();
    assert.equal(VISIT_ASK_DAYS_AHEAD, 27, "today and the 27 days after it: four field weeks");
    const days = visitAskDayChoices(FRIDAY, none);
    assert.equal(days[0], "2026-10-03", "a Friday is never offered — the first day is Saturday");
    assert.equal(days[days.length - 1], "2026-10-29", "and the last is four weeks on");
    assert.equal(days.length, 24, "28 days less four Fridays");
    assert.ok(days.every((day) => new Date(`${day}T12:00:00Z`).getUTCDay() !== 5), "never a Friday");
    assert.equal(visitAskDayChoices("2026-10-03", none)[0], "2026-10-03", "on a field day, today is offered");
    const holidays = new Map([["2026-10-06", "Armed Forces Day"]]);
    assert.equal(visitAskDayChoices(FRIDAY, holidays).includes("2026-10-06"), false, "never a confirmed public holiday");

    // The wish: kept when it can be a field day to come, dropped — never refused — otherwise.
    assert.equal(wishedVisitAskDay("2026-10-05", FRIDAY), "2026-10-05");
    assert.equal(wishedVisitAskDay(" 2026-10-29 ", FRIDAY), "2026-10-29", "the last day of the four weeks");
    assert.equal(wishedVisitAskDay("2026-10-31", FRIDAY), null, "past four weeks: dropped");
    assert.equal(wishedVisitAskDay("2026-10-09", FRIDAY), null, "a Friday: dropped");
    assert.equal(wishedVisitAskDay("2026-10-01", FRIDAY), null, "a day that has passed: dropped");
    assert.equal(wishedVisitAskDay("next week", FRIDAY), null, "words: dropped");
    assert.equal(wishedVisitAskDay(20261005, FRIDAY), null, "a number: dropped");

    // The day picked on accepting: checked before the database is asked.
    const day = (value: unknown, cairoToday = FRIDAY, held: ReadonlyMap<string, string> = none) => {
      const result = resolveVisitAskDay({ day: value, cairoToday, holidays: held });
      return result.ok ? result.day : result.kind;
    };
    assert.equal(day("2026-10-07"), "2026-10-07");
    assert.equal(day("2026-10-03", "2026-10-03"), "2026-10-03", "today, when today is a field day");
    assert.equal(day(""), "bad_input");
    assert.equal(day(null), "bad_input");
    assert.equal(day("2026-10-09"), "not_field_day", "never a Friday");
    assert.equal(day("2026-10-01"), "passed", "never a day that has passed");
    assert.equal(day("2026-10-31"), "too_far", "never beyond four weeks");
    assert.equal(day("2026-10-06", FRIDAY, holidays), "holiday", "never a public holiday");
    const holiday = resolveVisitAskDay({ day: "2026-10-06", cairoToday: FRIDAY, holidays });
    assert.ok(!holiday.ok && holiday.error.includes("Armed Forces Day"), "and the holiday is named");

    // In play: waiting, or accepted for a day still to come.
    assert.equal(isVisitAskOpen({ status: "waiting", visitOn: null }, FRIDAY), true);
    assert.equal(isVisitAskOpen({ status: "accepted", visitOn: "2026-10-02" }, FRIDAY), true, "accepted for today: still in play");
    assert.equal(isVisitAskOpen({ status: "accepted", visitOn: "2026-10-01" }, FRIDAY), false, "accepted for a day that has passed: he may ask again");
    assert.equal(isVisitAskOpen({ status: "declined", visitOn: null }, FRIDAY), false);
    assert.equal(isVisitAskOpen({ status: "cancelled", visitOn: null }, FRIDAY), false);

    // The owner's own words for the rep's request.
    assert.equal(visitAskStatusText({ status: "waiting", askedName: "Dina Hamdy", visitOnText: null }), "Waiting for Dina Hamdy");
    assert.equal(visitAskStatusText({ status: "accepted", askedName: "Dina Hamdy", visitOnText: dayLabel("2026-10-06") }), "Accepted, Tue 6 Oct", "\"accepted, Tue 6 Oct\"");
    assert.equal(visitAskStatusText({ status: "declined", askedName: "Dina Hamdy", visitOnText: null }), "Declined");
    assert.equal(visitAskWithText({ kind: "double", askedName: "Dina Hamdy", toldName: null }), "Double visit with Dina Hamdy");
    assert.equal(visitAskWithText({ kind: "product_manager", askedName: "Rasha Sabry", toldName: "Dina Hamdy" }), "Visit with Rasha Sabry");
    assert.equal(visitAskWithText({ kind: "chain", askedName: "Dina Hamdy", toldName: "Ali Mohamed Ali" }), "Chain visit with Dina Hamdy and Ali Mohamed Ali");
    assert.deepEqual(VISIT_ASK_CHOICE_LABELS, { double: "My manager", product_manager: "A product manager", chain: "Chain visit" }, "the three choices, in the owner's words");

    // Where each reader stands, and how the ask reads to him.
    assert.equal(visitAskPartOf({ askedHrId: "B-40", toldHrId: "A-12" }, "b-40"), "asked");
    assert.equal(visitAskPartOf({ askedHrId: "B-40", toldHrId: "A-12" }, "A-12"), "told");
    assert.equal(visitAskPartOf({ askedHrId: "B-40", toldHrId: "A-12" }, "B-300"), "reader");
    assert.equal(visitAskInboxText({ kind: "double", part: "asked", askedName: "Dina Hamdy", toldName: null }), "Double visit with you");
    assert.equal(
      visitAskInboxText({ kind: "chain", part: "told", askedName: "Dina Hamdy", toldName: "Ali Mohamed Ali" }),
      "Chain visit with Dina Hamdy and you — Dina Hamdy picks the day",
    );
    // A product manager's visit names the VISIT, never a title — on CNS the person asked is the Marketing Manager.
    assert.equal(visitAskInboxText({ kind: "product_manager", part: "told", askedName: "Rasha Sabry", toldName: "Dina Hamdy" }), "Product manager visit with Rasha Sabry");
    assert.equal(visitAskInboxText({ kind: "product_manager", part: "asked", askedName: "Hossam Mohamed Reda", toldName: "Karim Nabil" }), "Product manager visit with you");
  }

  // ── 4. Who answers, who reads, and who asks ──────────────────────────────────────────────────────
  {
    const real: VisitAskGateRow = { askedHrId: "B-40", isTest: false, status: "waiting" };
    const test: VisitAskGateRow = { ...real, isTest: true };

    // Only the person RECORDED as asked answers a real ask — never another manager, never the Super Admin.
    assert.equal(canAnswerVisitAsk(dm, real), true, "the district manager asked answers it");
    assert.equal(canAnswerVisitAsk(dm, { ...real, askedHrId: "b-40" }), true, "compared as a person");
    for (const [viewer, label] of [
      [otherDm, "another district manager"],
      [nsm, "the manager above"],
      [rep, "the rep"],
      [sfe, "SFE"],
      [ceo, "the CEO"],
      [rasha, "a product manager not asked"],
      [hossam, "the Marketing Manager, not asked"],
    ] as const) {
      assert.equal(canAnswerVisitAsk(viewer, real), false, `${label} does not answer it`);
      refused(() => assertVisitAskAnswerer(viewer, real), 403, /^Only the person asked answers this ask\.$/, `${label} is refused`);
    }
    refused(() => assertVisitAskAnswerer(owner, real), 403, /The Super Admin answers test entries only/, "the Super Admin decides no real ask");
    refused(() => assertVisitAskAnswerer(testDm, real), 403, /This is a test login/, "a test account never answers a real ask");
    assert.equal(canAnswerVisitAsk(rasha, { ...real, askedHrId: "A-8" }), true, "a product manager answers the ask made of him");
    assert.equal(canAnswerVisitAsk(hossam, { ...real, askedHrId: "A-9" }), true, "and the Marketing Manager the one a CNS rep made of him — read from the row, no permission widened");

    // The test world: the Super Admin answers any test ask, a test account as the person it mirrors.
    assert.equal(canAnswerVisitAsk(owner, test), true, "the Super Admin answers a test ask");
    assert.equal(canAnswerVisitAsk(testDm, test), true, "a test account answers as the district manager it mirrors");
    assert.equal(canAnswerVisitAsk(testRasha, { ...test, askedHrId: "A-8" }), true, "and as the product manager it mirrors");
    refused(() => assertVisitAskAnswerer(dm, test), 403, /Test entries are the Super Admin's/, "a real person never answers a test ask");
    refused(() => assertVisitAskAnswerer(testRep, test), 403, /^Only the person asked answers this ask\.$/, "a test account mirroring someone else is refused");

    // An ask that no longer waits is never answered again — and the screen is told to read it again.
    refusedWithCode(() => assertVisitAskAnswerer(dm, { ...real, status: "accepted" }), 409, "phoenix_crm_visit_ask_answered", "an accepted ask is answered once");
    refusedWithCode(() => assertVisitAskAnswerer(dm, { ...real, status: "declined" }), 409, "phoenix_crm_visit_ask_answered", "so is a declined one");
    refusedWithCode(() => assertVisitAskAnswerer(dm, { ...real, status: "cancelled" }), 409, "phoenix_crm_visit_ask_cancelled", "a cancelled ask is the rep's");
    assert.equal(canAnswerVisitAsk(owner, { ...test, status: "accepted" }), false, "not even by the Super Admin");

    // The inbox: the people an ask can reach read their own; SFE and the Super Admin read them all.
    assert.deepEqual(visitAskInboxReach(dm, false), { mode: "own", canAnswer: true }, "a district manager reads and answers his own");
    assert.deepEqual(visitAskInboxReach(nsm, false), { mode: "own", canAnswer: true }, "so does a national manager a vacant district's asks reach");
    assert.deepEqual(visitAskInboxReach(rasha, false), { mode: "own", canAnswer: true }, "and a product manager, by his app role, with no seat at all");
    assert.deepEqual(visitAskInboxReach(nahed, false), { mode: "own", canAnswer: true });
    // The Marketing Manager reads his own: an empty inbox until a CNS rep asks him — never a refusal, so
    // his Reports page draws nothing rather than an error.
    assert.deepEqual(visitAskInboxReach(hossam, false), { mode: "own", canAnswer: true }, "the Marketing Manager reads and answers the asks made of him");
    assert.equal(visitAskInboxReach(hossam, true), null, "in the real world only");
    assert.equal(isVisitAskAskableRole("Marketing Manager"), true);
    for (const role of ["Medical Rep", "District Manager", "SFE Manager", "Training Manager", "CEO", null]) {
      assert.equal(isVisitAskAskableRole(role), false, `${String(role)} is not asked by app role`);
    }
    assert.equal(visitAskInboxReach(rep, false), null, "a rep reads his asks on his customer's page, never here");
    assert.equal(visitAskInboxReach(ceo, false), null, "the CEO is not a district");
    assert.deepEqual(visitAskInboxReach(sfe, false), { mode: "all", canAnswer: false }, "SFE reads every real ask and answers none");
    assert.equal(visitAskInboxReach(sfe, true), null, "the test world is the Super Admin's and the test accounts'");
    assert.deepEqual(visitAskInboxReach(owner, false), { mode: "all", canAnswer: false }, "the Super Admin reads every real ask, and answers none");
    assert.deepEqual(visitAskInboxReach(owner, true), { mode: "all", canAnswer: true }, "and answers in the test world");
    assert.equal(visitAskInboxReach(dm, true), null, "a real person is in the real world only");
    assert.deepEqual(visitAskInboxReach(testDm, true), { mode: "own", canAnswer: true }, "a test account in the test world only");
    assert.equal(visitAskInboxReach(testDm, false), null);
    assert.deepEqual(visitAskInboxReach(testRasha, true), { mode: "own", canAnswer: true });

    // Asking: the territory's own rep, in his world; the Super Admin and a test account in the test world.
    assert.equal(canWriteAsRep(rep, D11, false), true, "the rep asks for his own customer");
    assert.equal(canWriteAsRep(rep, D12, false), false, "never for another rep's");
    assert.equal(canWriteAsRep(dm, D11, false), false, "a manager reads the asks on his rep's customer and asks none");
    assert.equal(canWriteAsRep(owner, D11, false), false, "the Super Admin raises no real ask");
    assert.equal(canWriteAsRep(owner, D11, true), true, "he tries it in the test world");
    assert.equal(canWriteAsRep(testRep, D11, true), true, "a test account asks as the rep it mirrors, in the test world");
    assert.equal(canWriteAsRep(testRep, D11, false), false, "and never in the real one");
  }

  // ── 5. Who is told, never by email, each step once ─────────────────────────────────────────────
  {
    const notice = (overrides: Partial<Parameters<typeof visitAskDeliveries>[0]>): Parameters<typeof visitAskDeliveries>[0] => ({
      kind: "visit_ask",
      seat: D11,
      askId: ASK,
      askKind: "double",
      status: "waiting",
      repHrId: "B-7",
      askedHrId: "B-40",
      toldHrId: null,
      customerName: "Ahmed Fathy",
      listType: "PM",
      wishedOn: null,
      visitOn: null,
      ...overrides,
    });
    const shape = (deliveries: ReturnType<typeof visitAskDeliveries>) =>
      deliveries.map((delivery) => ({
        to: delivery.recipients,
        event: delivery.eventType,
        tab: delivery.tab,
        key: delivery.idempotencyKey,
        inAppOnly: delivery.inAppOnly === true,
      }));
    const key = (status: string, who: string) => `phoenix_crm:visit_ask:${ASK}:${status}:${who}`;

    // Raised.
    const double = visitAskDeliveries(notice({}), NAMES);
    assert.deepEqual(
      shape(double),
      [{ to: ["B-40"], event: "visit_ask_waiting", tab: "team", key: key("waiting", "asked"), inAppOnly: false }],
      "a double visit tells the district manager, on his Team tab, and nobody else",
    );
    assert.equal(
      double[0].message,
      "Mostafa Adel asks for a double visit with you to Ahmed Fathy (PM) on Tanta · Pedia. Any day suits them. Accept it and pick the day, or decline it, in Phoenix CRM.",
      "he reads the rep, the customer and the territory — and nothing about where anybody stood",
    );
    const wished = visitAskDeliveries(notice({ wishedOn: "2026-10-05" }), NAMES);
    assert.ok(wished[0].message.includes(`They would like ${formatPhoenixLongDate("2026-10-05")}.`), "the day the rep wished for, when he named one");

    assert.deepEqual(
      shape(visitAskDeliveries(notice({ askKind: "chain", toldHrId: "A-12" }), NAMES)),
      [
        { to: ["B-40"], event: "visit_ask_waiting", tab: "team", key: key("waiting", "asked"), inAppOnly: false },
        { to: ["A-12"], event: "visit_ask_told", tab: "team", key: key("waiting", "told"), inAppOnly: false },
      ],
      "a chain visit: both are told — the district manager to answer, the manager above by Telegram and the phone as well",
    );
    assert.deepEqual(
      shape(visitAskDeliveries(notice({ askKind: "product_manager", askedHrId: "A-8", toldHrId: "B-40" }), NAMES)),
      [
        { to: ["A-8"], event: "visit_ask_waiting", tab: "reports", key: key("waiting", "asked"), inAppOnly: false },
        { to: ["B-40"], event: "visit_ask_told", tab: "team", key: key("waiting", "told"), inAppOnly: true },
      ],
      "a product manager's visit: he answers on Reports, the one page he opens; the district manager is told in the bell alone",
    );
    assert.deepEqual(
      shape(visitAskDeliveries(notice({ askKind: "product_manager", askedHrId: "A-8", toldHrId: null }), NAMES)).map((entry) => entry.to),
      [["A-8"]],
      "with no district manager above the territory, nobody else is told",
    );

    // Answered: the rep, whose request it is, and the person told again.
    const accepted = visitAskDeliveries(notice({ status: "accepted", visitOn: "2026-10-07" }), NAMES);
    assert.deepEqual(
      shape(accepted),
      [{ to: ["B-7"], event: "visit_ask_accepted", tab: "list", key: key("accepted", "rep"), inAppOnly: false }],
      "the rep hears the answer, on his List where the customer is",
    );
    assert.equal(
      accepted[0].message,
      `Dina Hamdy accepted your double visit to Ahmed Fathy (PM). The visit is on ${formatPhoenixLongDate("2026-10-07")}.`,
      "he sees the day, so they can meet",
    );
    const chainAccepted = visitAskDeliveries(notice({ askKind: "chain", toldHrId: "A-12", status: "accepted", visitOn: "2026-10-07" }), NAMES);
    assert.deepEqual(
      shape(chainAccepted).map((entry) => [entry.to[0], entry.event, entry.key]),
      [
        ["B-7", "visit_ask_accepted", key("accepted", "rep")],
        ["A-12", "visit_ask_accepted", key("accepted", "told")],
      ],
      "a chain visit's answer reaches the rep and the manager above",
    );
    assert.ok(chainAccepted[0].message.endsWith("Ali Mohamed Ali is told too."), "the rep knows the manager above knows");
    assert.ok(chainAccepted[1].message.endsWith(", and you are on it too."), "and the manager above knows he is on it");
    const declined = visitAskDeliveries(notice({ askKind: "product_manager", askedHrId: "A-8", toldHrId: "B-40", status: "declined" }), NAMES);
    assert.deepEqual(
      shape(declined),
      [
        { to: ["B-7"], event: "visit_ask_declined", tab: "list", key: key("declined", "rep"), inAppOnly: false },
        { to: ["B-40"], event: "visit_ask_declined", tab: "team", key: key("declined", "told"), inAppOnly: true },
      ],
    );
    assert.equal(declined[0].message, "Rasha Sabry declined your visit to Ahmed Fathy (PM).");

    // The owner's CNS rule: the Marketing Manager a CNS rep asks is told exactly as a product manager is —
    // on his Reports page, in the app, by Telegram and on the phone, never by email — and the rep's
    // district manager in the bell alone.
    const cns = visitAskDeliveries(notice({ seat: K21, repHrId: "B-131", askKind: "product_manager", askedHrId: "A-9", toldHrId: "B-130" }), NAMES);
    assert.deepEqual(
      shape(cns),
      [
        { to: ["A-9"], event: "visit_ask_waiting", tab: "reports", key: key("waiting", "asked"), inAppOnly: false },
        { to: ["B-130"], event: "visit_ask_told", tab: "team", key: key("waiting", "told"), inAppOnly: true },
      ],
      "the product manager visit's own shape, for Hossam Mohamed Reda",
    );
    assert.equal(
      cns[0].message,
      "Omar Saeed asks for a visit with you to Ahmed Fathy (PM) on Nasr City · CNS. Any day suits them. Accept it and pick the day, or decline it, in Phoenix CRM.",
    );
    assert.equal(
      cns[1].message,
      "Omar Saeed asked Hossam Mohamed Reda for a product manager visit to Ahmed Fathy (PM) on Nasr City · CNS. You are told when it is answered.",
      "the district manager reads the VISIT named, never a title Hossam does not hold",
    );
    for (const delivery of cns) {
      // No email for any step (owner, 2026-10-13): in-app, Telegram and the phone.
      assert.equal(PHOENIX_CRM_EMAIL_EVENT_TYPES.includes(delivery.eventType), false, "no visit-ask notice emails (owner, 2026-10-13)");
      assert.deepEqual(
        phoenixCrmChannels(delivery.eventType, delivery.inAppOnly),
        delivery.inAppOnly ? ["in_app"] : ["in_app", "telegram", "push"],
      );
    }

    // Every step: the ask's own record, the rep as its subject, and a key per step and person — so
    // one ask's notices never overwrite each other, and a step sent twice reaches nobody twice.
    const chainRaised = visitAskDeliveries(notice({ askKind: "chain", toldHrId: "A-12" }), NAMES);
    const pmRaised = visitAskDeliveries(notice({ askKind: "product_manager", askedHrId: "A-8", toldHrId: "B-40" }), NAMES);
    for (const [label, oneAsk] of [
      ["the chain visit", [...chainRaised, ...chainAccepted]],
      ["the product manager visit", [...pmRaised, ...declined]],
    ] as const) {
      const keys = oneAsk.map((delivery) => delivery.idempotencyKey);
      assert.equal(new Set(keys).size, keys.length, `no two notices of ${label} share a key`);
    }
    assert.deepEqual(
      shape(visitAskDeliveries(notice({ askKind: "chain", toldHrId: "A-12" }), NAMES)),
      shape(chainRaised),
      "the same step makes the same notices, under the same keys",
    );
    const all = [...double, ...chainRaised, ...pmRaised, ...accepted, ...chainAccepted, ...declined];
    for (const delivery of all) {
      assert.equal(delivery.recordId, ASK);
      assert.equal(delivery.subjectHrId, "B-7");
      assert.ok(delivery.idempotencyKey.startsWith(`phoenix_crm:visit_ask:${ASK}:`), "every notice of an ask shares the prefix it is withdrawn by");
      // Never by email — and a test ask stays in the app, reaching only the test accounts.
      assert.equal(PHOENIX_CRM_EMAIL_EVENT_TYPES.includes(delivery.eventType), false, `${delivery.eventType} never emails`);
      assert.deepEqual(
        phoenixCrmChannels(delivery.eventType, delivery.inAppOnly),
        delivery.inAppOnly ? ["in_app"] : ["in_app", "telegram", "push"],
      );
      assert.deepEqual(phoenixCrmChannels(delivery.eventType, true), ["in_app"], "a test ask is told in the app alone");
      assert.doesNotMatch(delivery.message, /\bdoctor/i, "a customer, never a doctor");
      if (delivery.recipients.includes("B-7")) {
        assert.doesNotMatch(delivery.message, /flag|integrity|distance|far from|suspicious|check/i, "nothing the rep reads judges him (Golden Rule #1)");
      }
    }

    // The notice carries no address and no position — there is nothing of the kind to write into one.
    const notify = source("src/lib/phoenix-crm/server/notifications.ts");
    // 🔴 THE VISIT ASK'S OWN MEMBER, and nothing after it. This used to run to `type Delivery`, which
    // was the end of the union only while visit_ask happened to be last — so the day-start notice
    // (owner, 2026-10-03), which carries a position DELIBERATELY because he ruled the rep's location
    // goes to his managers, landed inside a check written about a different notice. The rule being
    // held here is about THIS notice: a rep asking for a double visit tells nobody where anyone is.
    const memberStart = notify.indexOf('kind: "visit_ask";');
    const member = notify.slice(memberStart, notify.indexOf("\n    }", memberStart));
    assert.ok(member.includes("customerName: string;"), "the visit ask notice is where it was");
    assert.equal(member.includes("day_start"), false, "and the slice stops at its own member");
    assert.doesNotMatch(member, /\b(address|lat|lon|latitude|longitude|place|distance)\b/i, "and it names no address, no place and no position");
    // Answering withdraws the "accept or decline" line; cancelling withdraws them all, announcing nothing.
    const service = source("src/lib/phoenix-crm/server/visit-asks.ts");
    assert.match(service, /await withdrawPhoenixCrmVisitAskNotices\(askId, "waiting"\);/, "an answer takes the waiting notices back");
    assert.match(service, /await withdrawPhoenixCrmVisitAskNotices\(askId\);\n/, "a cancel takes every notice of the ask back");
    const cancel = service.slice(service.indexOf("export async function cancelVisitAsk("), service.indexOf("export type VisitAskInboxView"));
    assert.equal(cancel.includes("notifyPhoenixCrm("), false, "and a cancel tells nobody");
  }

  // ── 6. "Arrange a double visit" asks by itself, once per visit ─────────────────────────────────
  {
    assert.equal(VISIT_ASK_NEXT_STEP, "arrange_double");
    assert.ok(
      VISIT_NEXT_STEPS.some((step) => step.key === VISIT_ASK_NEXT_STEP && step.label === "Arrange a double visit"),
      "it is the visit's own next step",
    );
    assert.equal(raisesVisitAsk("arrange_double"), true);
    for (const other of ["follow_up", "send_data", "invite_event", "pharmacy_stock", "none", null, undefined]) {
      assert.equal(raisesVisitAsk(other), false, `${String(other)} asks nobody`);
    }

    // It never costs the visit: with nobody above the territory there is nothing to ask, and the answer
    // is null — before the database is ever reached.
    const lone = viewerFor("B-121", "Medical Rep", { canApprove: false });
    const nothing = await raiseVisitAskFromVisit(lone, {
      seat: K11,
      isTest: false,
      visitId: "0f8c3a52-7a1d-4b7c-8d21-5c6e9f0a1b23",
      customerId: "4b2e9d71-3c5a-4f08-9e16-7a8b0c1d2e3f",
      repHrId: "B-121",
      wishedOn: "2026-10-05",
    });
    assert.equal(nothing, null, "no manager above: no ask, no error, and the visit stays saved");
    assert.equal(visitAskSavedNote(null), null, "and the saved banner says nothing about it");
    assert.equal(
      visitAskSavedNote({ askedName: "Dina Hamdy", created: true }),
      "Dina Hamdy is asked for a double visit with you to this customer. The answer shows on the customer's page.",
    );
    assert.equal(
      visitAskSavedNote({ askedName: "Dina Hamdy", created: false }),
      "A double visit to this customer is already asked of Dina Hamdy. The answer shows on the customer's page.",
      "a save sent twice asks once, and says so",
    );

    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    const save = visits.slice(visits.indexOf("export async function saveVisit("));
    const raiseAt = save.indexOf("raiseVisitAskFromVisit(viewer, {");
    assert.ok(raiseAt > 0, "the visit's save raises the ask");
    assert.ok(save.indexOf('"phoenix_crm_save_visit"') >= 0 && save.indexOf('"phoenix_crm_save_visit"') < raiseAt, "only once the visit itself is saved");
    assert.match(save, /enteredAs === "rep" && raisesVisitAsk\(visit\.outcome\.nextStep\)\s+\? await raiseVisitAskFromVisit\(viewer, \{/, "only the rep's own visit, only for that step");
    assert.match(save, /visitId,\n\s+customerId: visit\.customerId,/, "keyed on the visit");
    assert.match(save, /wishedOn: visit\.outcome\.nextStepOn,/, "the step's own date is the day wished for");
    assert.match(save, /visitAskNote: visitAskSavedNote\(visitAsk\),/);

    const service = source("src/lib/phoenix-crm/server/visit-asks.ts");
    const fromVisit = service.slice(service.indexOf("export async function raiseVisitAskFromVisit("), service.indexOf("export function visitAskSavedNote("));
    assert.match(fromVisit, /^export async function raiseVisitAskFromVisit\([\s\S]*?\{\n\s+const \{ seat, isTest \} = input;\n\s+try \{/, "everything it does is inside one try");
    assert.match(fromVisit, /\} catch \(error\) \{[\s\S]*?return null;\n\s+\}\n\}\s*$/, "and a failure answers null, never an error");
    assert.match(fromVisit, /kind: "double",\n\s+rep_hr_id: personKey\(input\.repHrId\),/, "a double visit, for the rep whose visit it is");
    assert.match(fromVisit, /visit_id: input\.visitId,/, "keyed on the visit — the database raises one ask per visit id");
    assert.match(fromVisit, /if \(created\) \{\n\s+await notifyPhoenixCrm\(/, "and tells the manager only when it raised one");
  }

  // ── 7. The database half, the routes, and the plan it never touches ────────────────────────────
  {
    const path = "supabase/migrations/20261002135638_phoenix_crm_visit_asks.sql";
    const sql = stripSqlComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    assert.match(sql, /create table if not exists public\.phoenix_crm_visit_asks \(/, "one table of its own");
    assert.match(sql, /constraint phoenix_crm_visit_asks_kind check \(kind in \('double', 'product_manager', 'chain'\)\)/);
    assert.match(sql, /constraint phoenix_crm_visit_asks_status check \(status in \('waiting', 'accepted', 'declined', 'cancelled'\)\)/);
    assert.match(
      sql,
      /case kind when 'double' then told_hr_id is null when 'chain' then told_hr_id is not null else true end/,
      "a double visit tells nobody else; a chain visit always tells the manager above",
    );
    assert.match(sql, /and asked_hr_id <> rep_hr_id/, "nobody asks himself");
    assert.match(sql, /constraint phoenix_crm_visit_asks_accepted check \(\(status = 'accepted'\) = \(visit_on is not null\)\)/, "an accepted ask always has its day, and only then");
    assert.match(
      sql,
      /\(visit_on is null or extract\(isodow from visit_on\) <> 5\) and \(wished_on is null or extract\(isodow from wished_on\) <> 5\)/,
      "never a Friday, picked or wished",
    );
    assert.match(
      sql,
      /create unique index if not exists phoenix_crm_visit_asks_waiting_uniq\s+on public\.phoenix_crm_visit_asks \(seat_id, customer_id, kind, is_test\)\s+where status = 'waiting';/,
      "one waiting ask per territory, customer and kind, per world",
    );
    assert.match(
      sql,
      /create unique index if not exists phoenix_crm_visit_asks_visit_uniq\s+on public\.phoenix_crm_visit_asks \(visit_id\)\s+where visit_id is not null;/,
      "one ask per visit — the next step raises it once, however often the save is sent",
    );

    const fn = (name: string) => {
      const start = sql.indexOf(`create or replace function public.${name}(p jsonb)`);
      assert.ok(start >= 0, `${name} is in the migration`);
      return sql.slice(start, sql.indexOf("\n$$;", start));
    };
    const raise = fn("phoenix_crm_raise_visit_ask");
    assert.match(
      raise,
      /pg_advisory_xact_lock\(\s*hashtext\('phoenix_crm:visit_ask:' \|\| v_seat \|\| ':' \|\| v_customer_id::text \|\| ':' \|\| v_kind \|\| ':' \|\| v_is_test::text\)\s*\);/,
      "under the ask's own lock, per world",
    );
    assert.match(raise, /where c\.id = v_customer_id and c\.seat_id = v_seat and c\.is_test = v_is_test;/, "the customer is the territory's, in the ask's world");
    const byVisit = raise.indexOf("where a.visit_id = v_visit_id;");
    const inPlay = raise.indexOf("and (a.status = 'waiting' or (a.status = 'accepted' and a.visit_on >= v_today))");
    assert.ok(byVisit > 0 && inPlay > byVisit, "a visit's own ask is found first, then the one in play");
    assert.match(raise, /if v_customer\.status not in \('active', 'pending'\) then\s+raise exception 'phoenix_crm:visit_ask_not_on_list';/, "a customer on the list only");
    assert.match(
      raise,
      /if v_found and v_visit_id is null then\s+raise exception 'phoenix_crm:visit_ask_already_open';/,
      "from the customer's page a second ask is refused; from a visit's next step the one in play is the answer",
    );
    assert.match(raise, /'created', v_created,/, "and the service learns whether to tell anybody");
    assert.match(raise, /v_wished := null;/, "a wished day that cannot be one is dropped, never refused");
    assert.equal((sql.match(/v_today \+ 27\b/g) ?? []).length, 2, `the wish and the answer hold the same four weeks as VISIT_ASK_DAYS_AHEAD (${VISIT_ASK_DAYS_AHEAD})`);
    assert.equal((sql.match(/v_today date := \(now\(\) at time zone 'Africa\/Cairo'\)::date;/g) ?? []).length, 2, "the Cairo day, stated");

    const answer = fn("phoenix_crm_answer_visit_ask");
    assert.match(answer, /where a\.id = v_id and a\.is_test = v_is_test\s+for update;/, "the ask is locked, in its own world");
    assert.match(answer, /if v_ask\.status = 'cancelled' then\s+raise exception 'phoenix_crm:visit_ask_cancelled';/);
    assert.match(answer, /if v_ask\.status <> 'waiting' then\s+raise exception 'phoenix_crm:visit_ask_answered';/, "answered once");
    assert.match(
      answer,
      /if v_day is null or v_day < v_today or v_day > v_today \+ 27 or extract\(isodow from v_day\) = 5 then\s+raise exception 'phoenix_crm:visit_ask_bad_day';/,
      "the day: today to four weeks on, never a Friday",
    );
    const cancel = fn("phoenix_crm_cancel_visit_ask");
    assert.match(cancel, /where a\.id = v_id and a\.seat_id = v_seat and a\.is_test = v_is_test\s+for update;/, "the rep's own territory's ask, in its own world");
    assert.match(cancel, /if v_ask\.status in \('accepted', 'declined'\) then\s+raise exception 'phoenix_crm:visit_ask_answered';/, "an answered ask stays as it was answered");

    // Every refusal it raises has words a person can act on (db.ts REFUSALS), never the fallback.
    const raised = [...new Set([...sql.matchAll(/raise exception 'phoenix_crm:([a-z_]+)'/g)].map((match) => match[1]))];
    assert.ok(raised.length >= 8, "the refusals were read");
    for (const code of raised) {
      const refusal = phoenixCrmRefusal({ message: `phoenix_crm:${code}` });
      assert.ok(refusal, `${code} is a refusal`);
      assert.equal(refusal.code, `phoenix_crm_${code}`);
      assert.notEqual(refusal.message, "This entry could not be saved. Reload the page and try again.", `${code} has its own words`);
    }

    // The district manager's own double-visit plan: never read, never written, never imported here.
    for (const file of [
      path,
      "src/lib/phoenix-crm/visit-ask-rules.ts",
      "src/lib/phoenix-crm/server/visit-asks.ts",
      "src/components/phoenix-crm/visit-asks.tsx",
      "app/api/phoenix-crm/visit-asks/route.ts",
      "app/api/phoenix-crm/visit-asks/cancel/route.ts",
      "app/api/phoenix-crm/visit-asks/answer/route.ts",
      "app/api/phoenix-crm/visit-asks/inbox/route.ts",
    ]) {
      const text = file.endsWith(".sql") ? sql : source(file);
      assert.doesNotMatch(text, /double_visit_plans|double-visit-plan|DoubleVisitPlan/, `${file} never touches the district manager's own plan`);
    }

    // The answer route: `read` — the narrowest gate every person asked holds — then IDENTITY from the row.
    const answerRoute = source("app/api/phoenix-crm/visit-asks/answer/route.ts");
    assert.match(answerRoute, /await assertPermission\(access, "phoenix_crm", "read"\);[\s\S]*?answerVisitAsk\(viewer, body\)/);
    const service = source("src/lib/phoenix-crm/server/visit-asks.ts");
    const answering = service.slice(service.indexOf("export async function answerVisitAsk("), service.indexOf("function recentFilter("));
    const gateAt = answering.indexOf('assertVisitAskAnswerer(viewer, { askedHrId: String(row.asked_hr_id ?? ""), isTest, status });');
    assert.ok(gateAt > answering.indexOf("const row = await loadAskRow(askId);"), "the person asked is read from the ROW");
    assert.ok(gateAt < answering.indexOf('callPhoenixCrm<Row>("phoenix_crm_answer_visit_ask"'), "and checked before anything is written");
    assert.match(answering, /actor_hr_id: viewer\.hrId,/, "the answer is recorded as the viewer's own");
    // Who is asked is never the phone's to say.
    for (const field of ["askedHrId", "toldHrId", "repHrId", "asked_hr_id", "told_hr_id"]) {
      assert.equal(service.includes(`body.${field}`), false, `the body never names ${field}`);
    }
    const raising = service.slice(service.indexOf("export async function raiseVisitAsk("), service.indexOf("export type VisitAskFromVisit"));
    assert.match(raising, /territoryForRepWrite\(viewer, body\.seatId, readTestFlag\(body\.test\)\)/, "only the territory's own rep raises one");
    assert.match(raising, /asked_hr_id: resolved\.value\.askedHrId,\n\s+told_hr_id: resolved\.value\.toldHrId,/, "the people come from the organogram and the line's product managers");
    assert.match(raising, /rep_hr_id: viewer\.hrId,/);

    // Where it is drawn: the customer's page, the Team tab's Double visits section, and a product
    // manager's Reports.
    const customer = source("src/components/phoenix-crm/list-customer.tsx");
    assert.match(customer, /<CustomerVisitAsks\s/, "the customer's page carries the rep's asks");
    const team = source("src/components/phoenix-crm/team-tab.tsx");
    const inboxAt = team.indexOf('{current === "double" && visitAsks ? <VisitAskInbox cairoToday={cairoToday} onChanged={refresh} place="team" test={test} /> : null}');
    assert.ok(inboxAt > 0, "the Team tab draws the asks in the Double visits section");
    // The district manager's double-visit planner that sat below it was retired on 2026-10-16 — his weekly
    // plan replaced it, in its own Team-tab sections — so the asks are the whole of this section now.
    assert.equal(team.includes("<DoubleVisitPlanSection"), false, "the retired planner is no longer drawn beside the asks");
    const reports = source("src/components/phoenix-crm/reports-tab.tsx");
    assert.match(
      reports,
      /\{productsAudience && view\?\.answersVisitAsks \? <VisitAskInbox cairoToday=\{today\} place="reports" test=\{test\} \/> : null\}/,
      "a product manager answers above his Reports",
    );
    // The server says who answers there: a product manager, and the Marketing Manager whom CNS reps may
    // ask — the same roles the inbox serves, so that page never meets a refusal.
    assert.match(
      source("src/lib/phoenix-crm/server/reports.ts"),
      /answersVisitAsks: !readsTeamReports\(viewer\) && isVisitAskAskableRole\(viewer\.role\),/,
      "the Reports page draws the asks for every role the inbox serves by app role — the Marketing Manager's included",
    );
    const asksService = source("src/lib/phoenix-crm/server/visit-asks.ts");
    assert.match(asksService, /const reachable = viewer\.managerSeats\.length > 0 \|\| isVisitAskAskableRole\(viewer\.role\);/, "the inbox and the waiting count serve the same roles");
    assert.match(asksService, /const holders = await activeRoleSignIns\(VISIT_ASK_ASKABLE_ROLES\);/, "the list a line chooses from holds the Marketing Manager too");
    assert.match(asksService, /return productManagersOfLine\(\s*reach,\s*families\.map\(\(entry\) => entry\.family\),\s*seat\.lineCode,\s*\);/, "and each line chooses by its own code");
    const screen = source("src/components/phoenix-crm/visit-asks.tsx");
    assert.ok(screen.includes("Ask for a visit with…"), "the rep's one action, in the owner's words");
    assert.doesNotMatch(screen, /\bdoctors?\b/i, "the rep's screens say customer, never doctor");
    assert.doesNotMatch(screen, /integrity|suspicious|flagged|distance/i, "nothing on them judges the rep");
    // The waiting count: Team for a manager, Reports for a product manager, who has no Team tab.
    const app = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
    assert.match(app, /const count = key === "team" \? waitingCount : key === "reports" && !overview\.tabs\.team \? visitAskCount : 0;/);
    const chooser = source("src/components/phoenix-crm/module-chooser.tsx");
    assert.match(chooser, /const reportsWaiting = overview\.tabs\.team \? 0 : overview\.waitingForYou\.visitAsks;/);
  }
}
