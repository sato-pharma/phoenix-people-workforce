import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ExcelJS from "exceljs";

import { stripComments } from "./support/comment-strip.ts";

import { HEARD_OBJECTIONS } from "../src/lib/phoenix-crm/field-heard.ts";
import { buildObjectionsByCustomer, objectionCustomerRows, type ObjectionVisit } from "../src/lib/phoenix-crm/objections-by-customer.ts";
import { PHARMACY_LIST_TYPE } from "../src/lib/phoenix-crm/pharmacy-call-rules.ts";
import { REPORT_GUIDE, SECTION_TITLES } from "../src/lib/phoenix-crm/report-guide.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { PHOENIX_CRM_DEFAULT_SETTINGS } from "../src/lib/phoenix-crm/types.ts";
import { readsTeamReports, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { insightTerritories, loadObjectionsByCustomerReport, objectionVisitsOf, type ObjectionsByCustomerView } from "../src/lib/phoenix-crm/server/insight-reports.ts";
import { buildPhoenixCrmReportsWorkbook, packSections, type ReportsPackInput } from "../src/lib/phoenix-crm/server/reports-workbook.ts";

/**
 * Objections by customer (owner, 3 November 2026): each rep's customers and what they objected to, for the
 * managers alone. Counts only, by name and never by a count, and it never scores a rep.
 */

const THIS_MODULE = "objections-by-customer";

function visit(patch: Partial<ObjectionVisit> = {}): ObjectionVisit {
  return {
    repKey: "R-1",
    repName: "Mona Adel",
    territoryName: "Giza 1",
    customerId: "C-1",
    customerName: "Dr Salma",
    speciality: "Pediatrics",
    visitDate: "2026-10-05",
    listType: "PM",
    products: ["Ivyronc"],
    objection: "price",
    objectionNote: null,
    ...patch,
  };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

// ── 1 · Grouping: rep → customer → objection ────────────────────────────────────────────────────────

function runGroupingTests(): void {
  const result = buildObjectionsByCustomer([
    visit({ visitDate: "2026-10-01", products: ["Ivyronc", " Ivyronc ", "", "Lacto Advanced"], objectionNote: "  Too   dear for his patients " }),
    visit({ visitDate: "2026-10-09", listType: "AM" }),
    visit({ visitDate: "2026-10-03", objection: "safety", territoryName: "Giza 2" }),
    visit({ customerId: "C-2", customerName: "Dr Amir", speciality: null }),
    visit({ repKey: "R-2", repName: "Karim Nabil", territoryName: null, customerId: "C-1" }),
  ]);

  assert.deepEqual(result.reps.map((rep) => rep.repName), ["Karim Nabil", "Mona Adel"], "one entry per rep");
  const mona = result.reps[1]!;
  assert.deepEqual(mona.territories, ["Giza 1", "Giza 2"], "a rep's territories, by name");
  assert.deepEqual(mona.customers.map((customer) => customer.customerName), ["Dr Amir", "Dr Salma"], "the customers sit under the rep");

  const salma = mona.customers[1]!;
  assert.equal(salma.speciality, "Pediatrics");
  assert.deepEqual(
    salma.objections.map((entry) => [entry.key, entry.label, entry.am, entry.pm]),
    HEARD_OBJECTIONS.filter((entry) => entry.key === "price" || entry.key === "safety").map((entry) =>
      entry.key === "price" ? [entry.key, entry.label, 1, 1] : [entry.key, entry.label, 0, 1],
    ),
    "the objections sit under the customer, in the form's own order, with AM and PM apart",
  );

  const price = salma.objections.find((entry) => entry.key === "price")!;
  assert.deepEqual(
    price.visits.map((line) => line.visitDate),
    ["2026-10-09", "2026-10-01"],
    "the visits behind a count, the newest first",
  );
  assert.deepEqual(
    price.visits[1],
    { visitDate: "2026-10-01", listType: "PM", products: ["Ivyronc", "Lacto Advanced"], note: "Too dear for his patients" },
    "each visit keeps its product, its day and the rep's note, cleaned and with no product twice",
  );
  assert.equal(price.visits[0]!.note, null, "a visit with no note says so as null, never as an empty string");
  assert.deepEqual(price.visits[0]!.listType, "AM");

  // The same customer under two reps is one customer in the total and one row under each rep.
  assert.deepEqual(result.totals, { objections: { am: 1, pm: 4 }, customers: 2, reps: 2 }, "the report's whole total");

  const rows = objectionCustomerRows(result);
  assert.deepEqual(
    rows.map((row) => [row.repName, row.customerName]),
    [
      ["Karim Nabil", "Dr Salma"],
      ["Mona Adel", "Dr Amir"],
      ["Mona Adel", "Dr Salma"],
    ],
    "the flat rows keep the report's own order",
  );
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, "the same customer under two reps is two keys");
}

// ── 2 · No "none", no blank, no pharmacy ──────────────────────────────────────────────────────────

function runDroppedTests(): void {
  const result = buildObjectionsByCustomer([
    visit({ customerId: "C-NONE", objection: "none" }),
    visit({ customerId: "C-NULL", objection: null }),
    visit({ customerId: "C-EMPTY", objection: "" }),
    visit({ customerId: "C-SPACE", objection: "   " }),
    visit({ customerId: "C-UNKNOWN", objection: "not_a_real_objection" }),
    visit({ customerId: "C-PHARMACY", listType: PHARMACY_LIST_TYPE }),
  ]);
  assert.deepEqual(result.reps, [], "none, null, a blank, an unknown key and a pharmacy call never appear");
  assert.deepEqual(result.totals, { objections: { am: 0, pm: 0 }, customers: 0, reps: 0 }, "and count nowhere");

  // Beside a real one they vanish just the same, and the rep is not listed for a "none" alone.
  const mixed = buildObjectionsByCustomer([
    visit({ objection: "competitor" }),
    visit({ objection: "none" }),
    visit({ repKey: "R-9", repName: "Only None", customerId: "C-9", objection: "none" }),
  ]);
  assert.deepEqual(mixed.reps.map((rep) => rep.repName), ["Mona Adel"], "a rep whose customers raised nothing is not on the list");
  assert.deepEqual(mixed.reps[0]!.customers[0]!.objections.map((entry) => entry.key), ["competitor"]);
  assert.ok(
    !HEARD_OBJECTIONS.some((entry) => (entry.key as string) === "none"),
    "the form's list this report walks does not hold none",
  );
}

// ── 3 · Field allow-list: no rate, percent, rank or score can leave the module ─────────────────────

const ALLOWED_KEYS = new Set([
  "reps",
  "totals",
  "key",
  "repName",
  "territories",
  "customers",
  "customerName",
  "speciality",
  "objections",
  "label",
  "am",
  "pm",
  "visits",
  "visitDate",
  "listType",
  "products",
  "note",
]);
const SCORE_WORD = /rate|percent|share|rank|score|pct|ratio/i;

function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, into);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      allKeys(entry, into);
    }
  }
  return into;
}

function runAllowListTests(): void {
  const result = buildObjectionsByCustomer([visit(), visit({ repKey: "R-2", repName: "Karim Nabil", customerId: "C-2", objection: "safety", listType: "AM", objectionNote: "Asked about side effects" })]);
  const keys = allKeys(result);
  assert.deepEqual([...keys].filter((key) => !ALLOWED_KEYS.has(key)), [], "every field of the output is on the allow-list");
  assert.deepEqual([...keys].filter((key) => SCORE_WORD.test(key)), [], "no field is a rate, a percentage, a rank or a score");
  assert.deepEqual(Object.keys(result.reps[0]!).sort(), ["customers", "key", "repName", "territories"], "a rep carries no total of his own");
  assert.deepEqual([...allKeys(objectionCustomerRows(result))].filter((key) => SCORE_WORD.test(key)), [], "nor do the flat rows");

  // The source too: no division, nothing rounded, no percentage word in the code that builds it.
  const source = stripComments(read("src/lib/phoenix-crm/objections-by-customer.ts"));
  assert.doesNotMatch(source, /Math\.(round|floor|ceil)|toFixed|%`|\b(percent|rate|rank|score)\b/i, "the module computes no rate");
  assert.doesNotMatch(source, /\.am\s*\+\s*[\w.?]*\.pm\b|\.pm\s*\+\s*[\w.?]*\.am\b/, "AM and PM are never added");

  const screen = stripComments(read("src/components/phoenix-crm/insight-reports.tsx"));
  const drawn = screen.slice(screen.indexOf("function customerObjectionLines"));
  assert.ok(drawn.length > 0 && drawn.includes("ObjectionsByCustomerSection"), "the section is where this test looks");
  assert.doesNotMatch(drawn, /percentText|rows\s*\.\s*sort|\[\.\.\.rows\]|No objection/, "the section draws no percentage, never re-sorts the rows and never says no objection");
}

// ── 4 · Sorted by name, never by a count ──────────────────────────────────────────────────────────

function runSortTests(): void {
  // The rep and the customer with the most objections come LAST by name: a count-sort would flip them.
  const busy = Array.from({ length: 5 }, (_, index) => visit({ repKey: "R-Z", repName: "Ziad Omar", customerId: "C-Z", customerName: "Dr Zein", visitDate: `2026-10-0${index + 1}` }));
  const result = buildObjectionsByCustomer([
    ...busy,
    visit({ repKey: "R-A", repName: "Amal Fathy", customerId: "C-Y", customerName: "Dr Yara" }),
    visit({ repKey: "R-A", repName: "Amal Fathy", customerId: "C-Y", customerName: "Dr Yara", objection: "safety" }),
    visit({ repKey: "R-A", repName: "Amal Fathy", customerId: "C-Y", customerName: "Dr Yara", objection: "efficacy" }),
    visit({ repKey: "R-A", repName: "Amal Fathy", customerId: "C-B", customerName: "Dr Bassem" }),
  ]);
  assert.deepEqual(result.reps.map((rep) => rep.repName), ["Amal Fathy", "Ziad Omar"], "reps by name: five objections do not float a rep up");
  assert.deepEqual(result.reps[0]!.customers.map((customer) => customer.customerName), ["Dr Bassem", "Dr Yara"], "customers by name: three objections do not float a customer up");

  // The arrival order changes nothing, and two people of one name stay two rows in a steady order.
  const shuffled = buildObjectionsByCustomer([
    visit({ repKey: "R-B", repName: "Same Name", customerId: "C-2" }),
    visit({ repKey: "R-A", repName: "Same Name", customerId: "C-1" }),
  ]);
  assert.deepEqual(shuffled.reps.map((rep) => rep.key), ["R-A", "R-B"], "two reps of one name are two rows, in a steady order");

  // The form's own order on a customer, whichever objection is the most frequent.
  const order = buildObjectionsByCustomer([
    ...HEARD_OBJECTIONS.slice().reverse().flatMap((entry, index) => Array.from({ length: index + 1 }, () => visit({ objection: entry.key }))),
  ]);
  assert.deepEqual(
    order.reps[0]!.customers[0]!.objections.map((entry) => entry.key),
    HEARD_OBJECTIONS.map((entry) => entry.key),
    "a customer's objections in the form's own order, never by how many",
  );
}

// ── 5 · The read: rows to visits ──────────────────────────────────────────────────────────────────

function runReadMappingTests(): void {
  const seat = { seatId: "S-1", areaName: "Giza 1", lineName: "Pedia", lineCode: "pedia", seatLabel: null } as unknown as OrgSeat;
  const named = {
    customers: new Map([["C-1", { name: "Dr Salma", speciality: "Pediatrics" }]]),
    people: new Map([
      ["R-1", "Mona Adel"],
      ["D-1", "Hany Saad"],
    ]),
    seats: new Map([["S-1", seat]]),
  };
  const [own, managers, nameless] = objectionVisitsOf(
    [
      { seat_id: "S-1", customer_id: "C-1", list_type: "PM", visit_date: "2026-10-05T00:00:00Z", rep_hr_id: "r-1", manager_hr_id: "D-1", products: ["Ivyronc"], objection: "price", objection_note: " note " },
      { seat_id: "S-1", customer_id: "C-1", list_type: "AM", visit_date: "2026-10-06", rep_hr_id: null, manager_hr_id: "D-1", products: null, objection: "safety", objection_note: null },
      { seat_id: "S-GONE", customer_id: "C-GONE", list_type: "AM", visit_date: "2026-10-07", rep_hr_id: "X-1", manager_hr_id: null, products: [], objection: "safety", objection_note: "" },
    ],
    named,
  );
  assert.equal(own!.repName, nameOfPerson(own!.repKey, named.people), "the rep by his name");
  assert.equal(own!.visitDate, "2026-10-05", "the day alone");
  assert.equal(own!.customerName, "Dr Salma");
  assert.equal(own!.speciality, "Pediatrics");
  assert.ok(own!.territoryName, "the territory by its name");
  assert.match(managers!.repName, /Hany Saad \(own visits\)/, "a manager's own visit is said in his name");
  assert.deepEqual(managers!.products, [], "a visit with no products list is an empty list");
  assert.equal(nameless!.customerName, "Unnamed customer", "a customer who cannot be read is never a raw id");
  assert.notEqual(nameless!.repName, "X-1", "and a person who cannot be read is never printed as an HR id");
  assert.equal(nameless!.territoryName, null);
}

function nameOfPerson(key: string, people: ReadonlyMap<string, string>): string | undefined {
  return people.get(key.toUpperCase());
}

// ── 6 · Who reads it: the gate ────────────────────────────────────────────────────────────────────

const CEO: OrgSeat = {
  seatId: "SEAT-CEO",
  parentSeatId: null,
  tier: "CEO",
  path: ["SEAT-CEO"],
  occupantHrId: "C-1",
  lineCode: null,
  lineName: null,
  areaName: null,
  regionName: null,
  seatLabel: "CEO",
};

function under(parent: OrgSeat, patch: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "occupantHrId">): OrgSeat {
  return { ...parent, parentSeatId: parent.seatId, path: [...parent.path, patch.seatId], areaName: null, regionName: null, seatLabel: null, ...patch };
}

const PED_NSM = under(CEO, { seatId: "SEAT-PED-NSM", tier: "NSM", occupantHrId: "N-1", lineCode: "pedia", lineName: "Pedia" });
const PED_DM_1 = under(PED_NSM, { seatId: "SEAT-PED-DM-1", tier: "DM", occupantHrId: "D-1" });
const PED_REP_1 = under(PED_DM_1, { seatId: "SEAT-PED-REP-1", tier: "REP", occupantHrId: "R-1", areaName: "Giza 1" });
const PED_REP_2 = under(PED_DM_1, { seatId: "SEAT-PED-REP-2", tier: "REP", occupantHrId: "R-2", areaName: "Giza 2" });
const PED_DM_2 = under(PED_NSM, { seatId: "SEAT-PED-DM-2", tier: "DM", occupantHrId: "D-2" });
const PED_REP_3 = under(PED_DM_2, { seatId: "SEAT-PED-REP-3", tier: "REP", occupantHrId: "R-3", areaName: "Alex 1" });
const CNS_NSM = under(CEO, { seatId: "SEAT-CNS-NSM", tier: "NSM", occupantHrId: "N-2", lineCode: "cns", lineName: "CNS" });
const CNS_DM = under(CNS_NSM, { seatId: "SEAT-CNS-DM-1", tier: "DM", occupantHrId: "D-3" });
const CNS_REP = under(CNS_DM, { seatId: "SEAT-CNS-REP-1", tier: "REP", occupantHrId: "R-4", areaName: "Cairo 1" });

const ORG = buildOrgIndex([CEO, PED_NSM, PED_DM_1, PED_REP_1, PED_REP_2, PED_DM_2, PED_REP_3, CNS_NSM, CNS_DM, CNS_REP]);
const OPEN_LINES = new Set(["pedia", "cns"]);
const COMPANY_ROLES = new Set(["Super Admin", "CEO", "SFE Manager"]);

/** A viewer built the way resolvePhoenixCrmViewer builds one, from the organogram above. */
function viewerFor(hrId: string, role: string): PhoenixCrmViewer {
  const isSuperAdmin = role === "Super Admin";
  const basis = COMPANY_ROLES.has(role) ? "all" : "tree";
  const isOpen = (seat: OrgSeat) => Boolean(seat.lineCode && OPEN_LINES.has(seat.lineCode));
  const scope = territoriesInScope(ORG, hrId, basis);
  const held = ownTerritories(ORG, hrId);
  return {
    hrId,
    role,
    isSuperAdmin,
    isSfeManager: role === "SFE Manager",
    isTestPersona: false,
    basis,
    canCreate: false,
    canApprove: false,
    canUpdate: false,
    org: ORG,
    config: { settings: PHOENIX_CRM_DEFAULT_SETTINGS, lineRollout: [] },
    cairoToday: "2026-10-02",
    visitDay: "2026-10-02",
    openLines: OPEN_LINES,
    ownTerritories: held.filter(isOpen),
    waitingTerritories: held.filter((seat) => !isOpen(seat)),
    scopeTerritories: isSuperAdmin ? scope : scope.filter(isOpen),
    waitingScopeTerritories: isSuperAdmin ? [] : scope.filter((seat) => !isOpen(seat)),
    managerSeats: heldManagerSeats(ORG, hrId),
  } as unknown as PhoenixCrmViewer;
}

const MANAGERS_ONLY = /district managers, national sales managers, SFE and the Super Admin/;

async function refused(viewer: PhoenixCrmViewer, filters: Record<string, unknown>, message: RegExp, label: string): Promise<void> {
  await assert.rejects(
    () => loadObjectionsByCustomerReport(viewer, filters),
    (error: unknown) => {
      const failure = error as { status?: number; message?: string };
      return failure.status === 403 && message.test(String(failure.message));
    },
    label,
  );
}

async function runGateTests(): Promise<void> {
  // Refused by the real loader, and with a 403: a read that had started would fail some other way.
  for (const [hrId, role] of [
    ["R-1", "Medical Rep"],
    ["A-10", "Product Manager"],
    ["A-8", "Group Product Manager"],
    ["A-9", "Marketing Manager"],
    ["T-1", "Training Manager"],
    ["H-1", "HR Operations"],
  ] as const) {
    const viewer = viewerFor(hrId, role);
    assert.equal(readsTeamReports(viewer), false, `${role} is not a reader`);
    await refused(viewer, {}, MANAGERS_ONLY, `${role} is refused Objections by customer`);
  }
  await refused(viewerFor("R-1", "Medical Rep"), { seatId: "SEAT-PED-REP-1" }, MANAGERS_ONLY, "a rep is refused even for his own territory");

  // A manager sees his own team only.
  const dm = viewerFor("D-1", "District Manager");
  assert.equal(readsTeamReports(dm), true);
  assert.deepEqual(insightTerritories(dm, {}).seats.map((seat) => seat.seatId), ["SEAT-PED-REP-1", "SEAT-PED-REP-2"], "a district manager's own team, and no other");
  await refused(dm, { seatId: "SEAT-PED-REP-3" }, /outside your scope/, "another district manager's territory is refused");
  await refused(dm, { lineCode: "cns" }, /outside your scope/, "another line is refused");

  // Every reader he named passes the gate.
  for (const [hrId, role] of [
    ["B-10", "Super Admin"],
    ["S-1", "SFE Manager"],
    ["C-1", "CEO"],
  ] as const) {
    const viewer = viewerFor(hrId, role);
    assert.equal(readsTeamReports(viewer), true, `${role} reads it`);
    assert.ok(insightTerritories(viewer, {}).seats.length >= 4, `${role} reads company-wide`);
  }

  // The gate is the loader's first line, and the read names the view that leaves the copied history out.
  const server = stripComments(read("src/lib/phoenix-crm/server/insight-reports.ts"));
  const body = server.slice(server.indexOf("export async function loadObjectionsByCustomerReport"));
  const firstLine = body.split("\n")[1]!.trim();
  assert.equal(firstLine, "const { seats, includeTest } = insightTerritories(viewer, raw);", "the gate comes before anything else");
  const read_ = body.slice(0, body.indexOf("phoenix_crm_customers"));
  assert.ok(read_.includes('.from("phoenix_crm_countable_visits")'), "the visits come from the view that skips the copied iReports360 history");
  assert.ok(!read_.includes("phoenix_crm_countable_visits_with_history"), "never the view that keeps it");
  assert.ok(read_.includes('query.eq("is_test", false)'), "real entries only, unless the reader's test rule says otherwise");
}

// ── 7 · The door: the tab, the route, the workbook ────────────────────────────────────────────────

const VIEW: ObjectionsByCustomerView = {
  ...buildObjectionsByCustomer([
    visit({ objectionNote: "Too dear", products: ["Ivyronc", "Lacto Advanced"] }),
    visit({ visitDate: "2026-10-06", listType: "AM" }),
    visit({ repKey: "R-2", repName: "Karim Nabil", customerId: "C-2", customerName: "Dr Amir", objection: "safety" }),
  ]),
  includeTest: false,
  period: { from: "2026-10-01", to: "2026-10-07" } as ObjectionsByCustomerView["period"],
};

function workbookInput(patch: Partial<ReportsPackInput>): ReportsPackInput {
  return {
    viewerName: "Omar Gawish",
    periodText: "2026-10-01 to 2026-10-07",
    scopeText: "4 territories in scope",
    includeTest: false,
    generatedAtIso: "2026-10-02T06:00:00.000Z",
    visits: null,
    plan: null,
    dailyPlan: null,
    coverage: null,
    frequency: null,
    tracking: null,
    calendar: null,
    managers: null,
    locations: null,
    exceptions: null,
    adoption: null,
    bricks: null,
    capacity: null,
    heard: null,
    stock: null,
    samples: null,
    objections: null,
    ...patch,
  };
}

async function sheetRows(input: ReportsPackInput, title: string): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildPhoenixCrmReportsWorkbook(input)) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet(title);
  assert.ok(sheet, `the ${title} sheet is there`);
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    row.eachCell((cell) => cells.push(String(cell.text ?? "")));
    rows.push(cells);
  });
  return rows;
}

async function runDoorTests(): Promise<void> {
  // The guide offers it, in the family of What the field heard.
  assert.equal(SECTION_TITLES.objections, "Objections by customer");
  assert.ok(SECTION_TITLES.objections.length <= 31, "a sheet name Excel accepts");
  assert.equal(REPORT_GUIDE.objections.family, "heard");

  // The tab offers it on the managers' own flag, not the narrower one that leaves out the CEO.
  const tab = stripComments(read("src/components/phoenix-crm/reports-tab.tsx"));
  assert.ok(tab.includes('...(view.canReadTeamReports ? [offer("objections")] : [])'), "the chip stands on canReadTeamReports");
  assert.ok(tab.includes('(section === "objections" && view && !view.canReadTeamReports)'), "an address typed by hand falls back");
  const scope = stripComments(read("src/lib/phoenix-crm/server/reports.ts"));
  assert.ok(scope.includes("canReadTeamReports: readsTeamReports(viewer)"), "the flag is the gate's own predicate");

  // Both routes go through the gated loader; the export asks only for the managers.
  const route = stripComments(read("app/api/phoenix-crm/reports/route.ts"));
  assert.ok(route.includes('section === "objections") report = await loadObjectionsByCustomerReport(viewer, filters)'), "the route serves it through the loader");
  const exportRoute = stripComments(read("app/api/phoenix-crm/reports/export/route.ts"));
  assert.ok(exportRoute.includes("managerSections ? loadObjectionsByCustomerReport(viewer, filters) : Promise.resolve(null)"), "the export asks for it only for a manager");

  // The workbook: no sheet for anyone else, and for a manager a sheet by name holding only counts.
  assert.ok(!packSections(workbookInput({})).includes(SECTION_TITLES.objections), "no view, no sheet");
  assert.ok(packSections(workbookInput({ objections: VIEW })).includes(SECTION_TITLES.objections), "the cover promises it");
  const rows = await sheetRows(workbookInput({ objections: VIEW }), SECTION_TITLES.objections);
  const text = rows.map((row) => row.join(" | "));
  const karim = text.findIndex((line) => line.startsWith("Karim Nabil"));
  const mona = text.findIndex((line) => line.startsWith("Mona Adel"));
  assert.ok(karim >= 0 && mona > karim, "the counts run by the rep's name, though Mona's customer objected more");
  assert.ok(text.some((line) => line.includes("Too dear")), "the rep's note reaches the sheet");
  assert.ok(text.some((line) => line.includes("Ivyronc, Lacto Advanced")), "the products reach the sheet");
  const headerCells = rows.filter((row) => row[0] === "Rep").flat();
  assert.deepEqual(headerCells.filter((cell) => SCORE_WORD.test(cell)), [], "no column is a rate, a percentage, a rank or a score");
  assert.ok(!text.some((line) => /\bNo objection\b/.test(line)), "no row says no objection");
}

// ── 8 · It never scores a rep: nothing that measures a person may import it ────────────────────────

function walk(path: string, into: string[] = []): string[] {
  if (!existsSync(path)) return into;
  if (statSync(path).isFile()) {
    into.push(path);
    return into;
  }
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith("_wt-") || entry === ".git") continue;
    walk(join(path, entry), into);
  }
  return into;
}

/** The modules that measure a person. Each path must exist, so a move cannot empty this ban silently. */
const NEVER_IMPORT: ReadonlyArray<string> = [
  // Phoenix Ranks
  "src/lib/rep-ranks",
  // The KPIs
  "src/lib/crm/kpi-board-agents.ts",
  "src/lib/crm/kpi-index.ts",
  "src/lib/crm/kpis-board.ts",
  "src/lib/crm/kpis-board-workbook.ts",
  "src/lib/crm/kpis-brick-table.ts",
  "src/lib/crm/kpis-call-rate-route.ts",
  "src/lib/crm/kpis-doctor-bricks.ts",
  "src/lib/crm/kpis-doctor-filters.ts",
  "src/lib/crm/kpis-filters.ts",
  "src/lib/crm/kpis-manager-rows.ts",
  "src/lib/crm/kpis-tabs.ts",
  "src/lib/crm/kpis-trend.ts",
  "src/lib/crm/kpis-trend-options.ts",
  "src/lib/crm/phoenix-kpi-data.ts",
  "src/lib/crm/phoenix-kpi-rules.ts",
  "src/lib/crm/rep-kpi-reports.ts",
  "src/lib/crm/rep-kpi-reports-data.ts",
  "src/lib/business-review/sources/crm-kpis.ts",
  "src/lib/business-review/pack/kpi-sections.ts",
  // Pay
  "src/lib/payroll",
  "src/lib/automated-payroll",
  "src/lib/incentives",
  // Coaching
  "src/lib/coaching",
  "src/components/coaching",
  // The integrity board
  "src/lib/phoenix-crm/server/integrity-board.ts",
  "src/lib/phoenix-crm/server/behaviour.ts",
  "src/lib/phoenix-crm/server/location-integrity.ts",
  "src/lib/phoenix-crm/behaviour-integrity.ts",
  "src/lib/phoenix-crm/integrity-settlement.ts",
  "src/lib/phoenix-crm/location-integrity.ts",
  "src/lib/crm-integrity",
];

/** The only files that may name this module, whatever else is added beside them. */
const MAY_IMPORT = new Set([
  "src/lib/phoenix-crm/server/insight-reports.ts",
  "src/lib/phoenix-crm/server/reports-workbook.ts",
  "src/components/phoenix-crm/insight-reports.tsx",
  "tests/phoenix-crm-objections-by-customer.test.ts",
]);

const IMPORTS_THIS = new RegExp(`(from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)["'][^"']*${THIS_MODULE}(\\.ts)?["']`);

function runImportBanTests(): void {
  assert.ok(IMPORTS_THIS.test(`import { x } from "@/lib/phoenix-crm/${THIS_MODULE}";`), "the scan sees a static import");
  assert.ok(IMPORTS_THIS.test(`const m = await import("../${THIS_MODULE}.ts");`), "the scan sees a dynamic import");

  for (const path of NEVER_IMPORT) {
    assert.ok(existsSync(path), `${path} still exists: if it moved, move it here too`);
    for (const file of walk(path).filter((name) => /\.(ts|tsx|mjs)$/.test(name))) {
      assert.ok(!IMPORTS_THIS.test(read(file)), `${relative(process.cwd(), file)} must never import ${THIS_MODULE}: it measures people, and this list never scores a rep`);
    }
  }

  // The whole source tree, so a new scoring module cannot slip past a list of today's paths.
  const importers = ["src", "app", "scripts", "tests"]
    .flatMap((root) => walk(resolve(root)))
    .filter((name) => /\.(ts|tsx|mjs)$/.test(name))
    .filter((name) => IMPORTS_THIS.test(read(name)))
    .map((name) => relative(process.cwd(), name).replaceAll("\\", "/"));
  assert.deepEqual(importers.filter((name) => !MAY_IMPORT.has(name)), [], "only the report itself imports this module");
  assert.ok(importers.includes("src/lib/phoenix-crm/server/insight-reports.ts"), "the scan found the one real importer, so it is looking at real files");
}

export async function runPhoenixCrmObjectionsByCustomerTests(): Promise<void> {
  runGroupingTests();
  runDroppedTests();
  runAllowListTests();
  runSortTests();
  runReadMappingTests();
  await runGateTests();
  await runDoorTests();
  runImportBanTests();
}
