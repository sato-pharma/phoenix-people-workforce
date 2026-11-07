/**
 * THE PHOENIX FIELD SET ON THE OLD CRM'S ADMIN REPORTS, and the three tiers that decide who reads what.
 *
 * Owner, 2026-10-07, asked directly: the old CRM reports get "everything, GPS and evidence included"
 * from Phoenix CRM, because a report that shows a vendor visit in full and a Phoenix visit in outline is
 * the same drop he asked us to remove.
 *
 * 🔴 THAT RULING DOES NOT REOPEN THE SIGHT HE NARROWED HIMSELF SIX DAYS EARLIER. On 2026-10-02 he set
 * golden rule #1's three tiers, and on 2026-09-29 he made the own-row blinding absolute. "Everything"
 * therefore means everything the READER's tier earns, and this file is what stops a later sweep reading
 * it as "everything to everyone" — a change nobody would see in a diff of a report page.
 *
 * Every assertion below is on BEHAVIOUR, not on source text: a sight rule pinned only by a grep survives
 * being rewritten into something that silently widens it.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  PHOENIX_VISIT_DETAIL_COLUMNS,
  phoenixDetailSight,
  phoenixDetailViewer,
  phoenixRowSight,
  phoenixVisitDetail,
  phoenixVisitDetailColumns,
  phoenixVisitDetailHeaders,
  type PhoenixVisitDetailRow,
} from "../src/lib/crm/phoenix-visit-detail.ts";
import { buildRepVisits, type VisitForRepDrilldown } from "../src/lib/crm/rep-visits.ts";
import {
  buildCombinedAuditWorkbook,
  type DoubleVisitAuditData,
  type DoubleVisitAuditSection,
} from "../src/lib/double-visit-analytics/audit-export.ts";
import { buildVisitDetail, type CrmDetailRow } from "../src/lib/company-activity-report/crm-detail.ts";

/** A Phoenix visit carrying every measurement the app records, so each tier can be read off one row. */
const FULL_ROW: PhoenixVisitDetailRow = {
  visit_kind: "chain",
  entered_by_hr_id: "B-155",
  products: ["Ivyronc", "Guamusin"],
  samples_given: { Ivyronc: 1, Guamusin: 2 },
  product_availability: { Ivyronc: "has", Guamusin: "missing" },
  objection: "safety",
  objection_note: "asked about the paediatric dose",
  next_step: "follow_up_next_visit",
  next_step_on: "2026-10-12",
  visit_pharmacy_name: "El Ezaby Nasr City",
  is_unplanned: true,
  unplanned_kind: "out_of_plan",
  photo_path: "visits/abc.jpg",
  voice_note_path: "visits/abc.m4a",
  voice_note_seconds: 130,
  lat: 30.0444,
  lon: 31.2357,
  accuracy_meters: 42,
  distance_meters: 1800,
  location_flag: "far",
  photo_lat: 30.0445,
  photo_lon: 31.2358,
  photo_accuracy_meters: 12,
  dwell_seconds: 540,
  form_open_seconds: 95,
  capture_source: "phone",
  offline_seconds: 300,
  device_skew_minutes: 7,
  phoenix_synced_at: "2026-10-07T09:30:00Z",
};

function runTierTests(): void {
  const full = phoenixVisitDetail(FULL_ROW, "full");
  const distance = phoenixVisitDetail(FULL_ROW, "distance");
  const none = phoenixVisitDetail(FULL_ROW, "none");

  // ── THE WORK HALF IS WHOLE AT EVERY TIER ────────────────────────────────────────────────────────
  // It is the rep's own work, never an integrity signal, so no tier may thin it. A reader who can see
  // that a visit happened but not what was discussed is reading a worse report than before.
  for (const [label, detail] of [
    ["full", full],
    ["distance", distance],
    ["none", none],
  ] as const) {
    assert.deepEqual(detail.products, ["Ivyronc", "Guamusin"], `${label}: the products are the rep's own work`);
    assert.equal(detail.samples, "Ivyronc ×1 · Guamusin ×2", `${label}: what he left behind`);
    assert.equal(detail.availability, "Ivyronc in stock · Guamusin out of stock", `${label}: the shelf as he found it`);
    assert.match(detail.objection ?? "", /paediatric dose/, `${label}: the doctor's objection, in the doctor's terms`);
    assert.match(detail.nextStep ?? "", /12 Oct/, `${label}: the next step and its day, as a day and never an ISO string`);
    assert.equal(detail.pharmacyFeedback, "El Ezaby Nasr City", `${label}: the pharmacy he named as feedback`);
    assert.equal(detail.offPlan, "Out of plan", `${label}: an off-plan visit says so`);
    assert.equal(detail.kindLabel, "Chain visit", `${label}: the kind, named`);
  }

  // ── TIER 1: the measurement BEHIND a reading is the Super Admin's and the SFE Manager's ─────────
  assert.ok(full.location, "full sight reads the distance sentence");
  assert.match(full.evidence ?? "", /at the door/, "full sight reads how long he stood there — behaviour, not work");
  assert.match(full.evidence ?? "", /photo fix/, "full sight reads where the phone thought the photo was taken");
  assert.match(full.capture ?? "", /offline/, "full sight reads how long the row waited offline");
  assert.match(full.capture ?? "", /phone clock 7 min out/, "full sight reads the phone-clock warning");

  // ── TIER 2: every reader below them gets the DISTANCE ONLY ──────────────────────────────────────
  assert.ok(distance.location, "a District Manager reads the distance");
  assert.doesNotMatch(distance.location ?? "", /within/, "but never the accuracy behind the reading");
  assert.equal(distance.capture, null, "and no capture timing at all — source, offline, clock, sync");
  assert.doesNotMatch(distance.evidence ?? "", /at the door/, "and not the dwell");
  assert.doesNotMatch(distance.evidence ?? "", /photo fix/, "and not the photo's own fix");
  assert.match(distance.evidence ?? "", /Photo/, "he does read THAT a photo exists");
  assert.match(distance.evidence ?? "", /Voice note/, "and that a voice note exists, with its length");

  // ── A WEAK READING IS A PLAIN DISTANCE TO HIM, NEVER A DOUBT ────────────────────────────────────
  // The owner's words, 2026-10-02: no weak-signal wording below the Super Admin and the SFE Manager. A
  // manager told "the phone was not sure where it was" reads it as a doubt about the REP.
  const weak = phoenixVisitDetail({ ...FULL_ROW, location_flag: "weak_gps" }, "distance");
  assert.doesNotMatch(weak.location ?? "", /not sure/, "a weak reading never reaches a District Manager as a doubt");
  const weakFull = phoenixVisitDetail({ ...FULL_ROW, location_flag: "weak_gps" }, "full");
  assert.match(weakFull.location ?? "", /not sure/, "the Super Admin and the SFE Manager do read it");

  // ── TIER 3: his own row tells him nothing about himself ─────────────────────────────────────────
  assert.equal(none.location, null, "a reader on his own row as its rep reads no distance");
  assert.equal(none.capture, null, "no capture timing");
  assert.doesNotMatch(none.evidence ?? "", /at the door/, "and no dwell");

  // ── A VENDOR ROW CARRIES NOTHING, AND PRINTS NOTHING — never a zero ─────────────────────────────
  // iReports360 recorded no products, no GPS and no evidence. A `0` would read as a measurement that
  // was taken and came back empty, which is a worse answer than a blank.
  const vendor = phoenixVisitDetail({}, "full");
  assert.equal(vendor.kindLabel, null, "a row with no kind is a vendor row or a day activity");
  assert.deepEqual(vendor.products, [], "and carries no products");
  assert.equal(vendor.location, null, "no location");
  assert.equal(vendor.evidence, null, "no evidence");
  assert.equal(vendor.capture, null, "no capture");
}

function runViewerTests(): void {
  // The two roles that read the measurement behind a reading are the SAME two names
  // `readsLocationDetail` holds in the Phoenix CRM module. Any other admin seat — a District Manager,
  // an RSM, the NSM, the CEO — reads the distance alone, and the CEO is deliberately NOT in tier 1.
  assert.equal(phoenixDetailSight("Super Admin"), "full");
  assert.equal(phoenixDetailSight("SFE Manager"), "full");
  for (const role of ["CEO", "National Sales Manager", "Regional Sales Manager", "District Manager", "HR Manager", null]) {
    assert.equal(phoenixDetailSight(role), "distance", `${role ?? "no role"} reads the distance and nothing behind it`);
  }
  assert.equal(phoenixDetailSight("District Manager", { ownRow: true }), "none", "and nothing at all on his own row");

  // OWN-ROW BLINDING IS PER ROW, which is the whole reason a page-wide answer is not enough: a District
  // Manager's own board carries his reps' rows AND his own, and only his own blinds him.
  const dm = phoenixDetailViewer("District Manager", "B-900");
  assert.equal(phoenixRowSight(dm, "B-900"), "none", "his own row as its rep tells him nothing");
  assert.equal(phoenixRowSight(dm, "b-900"), "none", "hr ids compare case-insensitively, as everywhere else");
  assert.equal(phoenixRowSight(dm, "B-155"), "distance", "a rep's row keeps its distance");
  assert.equal(phoenixRowSight(dm, null), "distance", "a row with no agent is nobody's own row");

  // The Super Admin and the SFE Manager are never blinded, their own rows included: the measurement is
  // their job, and blinding them would leave nobody able to read it at all.
  const sa = phoenixDetailViewer("Super Admin", "B-10");
  assert.equal(phoenixRowSight(sa, "B-10"), "full", "the Super Admin reads his own row whole");
}

function runSheetTests(): void {
  // A SHEET HAS NO VIEWPORT, so the fits-the-screen rule does not reach it and nothing is merged: a
  // manager filtering on "Objection" wants that objection in its own cell. The TIERS are identical — a
  // sheet is not a reason to widen anyone's sight — and a column a reader may not read is ABSENT rather
  // than empty, so a blank cell never reads as "there was no reading".
  const full = phoenixVisitDetailColumns(FULL_ROW, "full");
  const distance = phoenixVisitDetailColumns(FULL_ROW, "distance");
  const none = phoenixVisitDetailColumns(FULL_ROW, "none");

  for (const header of ["Accuracy (m)", "Latitude", "Longitude", "At the door", "Phone clock out (min)", "Synced"]) {
    assert.ok(header in full, `the full sheet carries ${header}`);
    assert.ok(!(header in distance), `and the distance sheet does NOT carry ${header} — absent, never an empty cell`);
    assert.ok(!(header in none), `nor the own-row sheet`);
  }
  assert.equal(distance["Distance (m)"], 1800, "a District Manager's sheet carries the distance itself");
  assert.equal(none["Distance (m)"], null, "and his own row carries none");
  assert.equal(full.Objection, distance.Objection, "the work half is the same cell at every tier");
  assert.equal(full.Products, "Ivyronc, Guamusin", "products are comma-joined for a spreadsheet, not dot-joined");

  // The header list is what each export writes, so it must be the keys of the same map, in order.
  assert.deepEqual(phoenixVisitDetailHeaders("full"), Object.keys(full), "the full sheet's headers are its own columns");
  assert.deepEqual(phoenixVisitDetailHeaders("distance"), Object.keys(distance));
}

function runSelectListTests(): void {
  // 🔴 A SELECT IS A STRING. Every column the shaper reads has to be in the select list, or it reads
  // `undefined` and prints a blank — the exact shape of the defect this whole change exists to remove,
  // and nothing type-checks it. So the list is compared against the DOOR'S OWN appended names.
  const selected = new Set(PHOENIX_VISIT_DETAIL_COLUMNS.split(",").map((part) => part.trim()));
  const migration = readFileSync(
    "supabase/migrations/20261008010000_crm_visits_door_carries_the_phoenix_field_set.sql",
    "utf8",
  );
  const appended = [...migration.matchAll(/^\s*null::[a-z [\]]+ as ([a-z0-9_]+),?$/gm)].map((match) => match[1]);
  // The four appended by #5477 are not the field set; the 29 after them are.
  const earlier = ["phoenix_customer_validated", "double2_crm_id", "double2_name", "double2_hr_id"];
  const fieldSet = appended.filter((name) => !earlier.includes(name));
  assert.equal(fieldSet.length, 29, "the door appends 29 field-set columns");
  for (const name of fieldSet) {
    assert.ok(selected.has(name), `PHOENIX_VISIT_DETAIL_COLUMNS must select ${name} — the door serves it and the shaper reads it`);
  }
  assert.equal(selected.size, fieldSet.length, "and selects nothing the door does not serve");
}

function drilldownVisit(overrides: Partial<VisitForRepDrilldown> = {}): VisitForRepDrilldown {
  return {
    agent_crm_id: 1397,
    agent_hr_id: "B-100",
    agent_name: "A Medical Rep",
    ampm: "PM",
    comment: null,
    contact_crm_id: 500,
    contact_name: "Dr A",
    crm_contact_grade: "A",
    crm_region_id: null,
    crm_region_name: null,
    crm_save_date: "2026-10-07 11:00:00+00",
    crm_visit_id: -9001,
    customer_name: null,
    double_crm_id: null,
    double_hr_id: "B-900",
    double_name: "A District Manager",
    double2_hr_id: "B-155",
    double2_name: "A Product Manager",
    source: "phoenix",
    speciality: "Pediatrics",
    visit_date: "2026-10-07",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...overrides,
  } as VisitForRepDrilldown;
}

function runDrilldownTests(): void {
  const UNMAPPED = new Map();

  // ── BOTH MANAGERS ON A CHAIN VISIT ─────────────────────────────────────────────────────────────
  // The door has returned slot 2 since #5477 and the drill-down named one of them, so one of the two
  // people who gave that ride was invisible on the very page that lists it.
  const { rows } = buildRepVisits([drilldownVisit()], [], { territoryIndex: UNMAPPED });
  assert.equal(rows[0].partnerName, "A District Manager", "slot 1 is named");
  assert.equal(rows[0].partner2Name, "A Product Manager", "and so is slot 2");
  assert.equal(rows[0].partner2HrId, "B-155", "with his hr id, so a name map can resolve him");

  // ── NO VIEWER, NO PHOENIX HALF ─────────────────────────────────────────────────────────────────
  // Every caller that has not opted in gets exactly what it got before 2026-10-07, so this change
  // cannot have widened anybody's sight by default.
  assert.equal(rows[0].phoenix, null, "without a viewer there is no field set on the row");
  assert.equal(rows[0].phoenixColumns, null, "and no sheet cells either");

  // ── THE TIER TRAVELS WITH THE ROW, AND THE OWN-ROW RULE IS APPLIED PER ROW ──────────────────────
  const visits = [
    drilldownVisit({ ...FULL_ROW, agent_hr_id: "B-100" }),
    drilldownVisit({ ...FULL_ROW, agent_hr_id: "B-900", crm_visit_id: -9002 }),
  ];
  const dm = buildRepVisits(visits, [], {
    territoryIndex: UNMAPPED,
    viewer: phoenixDetailViewer("District Manager", "B-900"),
  });
  const repRow = dm.rows.find((row) => row.phoenix?.location);
  const ownRow = dm.rows.find((row) => row.phoenix && !row.phoenix.location);
  assert.ok(repRow, "the District Manager reads his rep's distance");
  assert.ok(ownRow, "and reads none on the row where HE is the rep — resolved per row, never per page");
  assert.equal(repRow.phoenix?.capture, null, "neither row carries a capture timing at his tier");
  assert.match(repRow.phoenix?.objection ?? "", /paediatric dose/, "and the work half is whole on both");

  const sa = buildRepVisits(visits, [], {
    territoryIndex: UNMAPPED,
    viewer: phoenixDetailViewer("Super Admin", "B-10"),
  });
  assert.ok(
    sa.rows.every((row) => row.phoenix?.capture),
    "the Super Admin reads the capture timing on every row",
  );
  assert.ok(
    sa.rows.every((row) => row.phoenixColumns && "Accuracy (m)" in row.phoenixColumns),
    "and his sheet carries the accuracy column",
  );
}


/** One coach, one dated visit — enough for the detail block's header row, which is what is at stake. */
const AUDIT_DATA: DoubleVisitAuditData = {
  dateFrom: "2026-09-01",
  dateTo: "2026-10-31",
  period: "ALL",
  role: "ALL",
  scopeLabel: "All lines and areas (company-wide)",
  generatedAt: "2026-10-08",
  weeks: [{ index: 1, label: "W1 (Sep 1-7)", rangeLabel: "Sep 1-7", start: "2026-09-01", end: "2026-09-07" }],
  phoenixHeaders: [],
  coaches: [
    {
      hrId: "B-900",
      name: "A District Manager",
      roleCode: "DSM",
      roleLabel: "District Manager",
      area: "Tanta",
      line: "Pedia",
      status: "",
      totalDvs: 1,
      activeDays: 1,
      am: 0,
      pm: 1,
      pharmacies: 0,
      distinctMrs: 1,
      daysWithGps: 0,
      reps: [],
      perDay: [],
      detail: [
        {
          date: "2026-09-02",
          weekday: "Wed",
          weekLabel: "Sep 1-7",
          repName: "A Medical Rep",
          repStatus: "",
          customer: "Dr A",
          speciality: "Pediatrics",
          period: "PM",
          visitType: "Regular",
          partner2: "A Product Manager",
          phoenixColumns: { "Visit kind": "Chain visit", Products: "Ivyronc", "Distance (m)": 1800 },
        },
      ],
    },
  ],
};

/** The five admin reports, and the constant each one must fold the field set into. */
const REPORT_SELECTS: readonly { file: string; what: string }[] = [
  { file: "src/lib/crm/rep-visits-data.ts", what: "the rep drill-down" },
  { file: "src/lib/field-activity/report.ts", what: "Field Activity" },
  { file: "src/lib/double-visit-analytics/service.ts", what: "Double Visit Analytics" },
  { file: "src/lib/double-visit-analytics/audit-export.ts", what: "the double-visit audit export" },
  { file: "src/lib/employee-360/service.ts", what: "Employee 360" },
  { file: "src/lib/company-activity-report/crm-detail.ts", what: "Company Activity" },
];

function runReportCarryTests(): void {
  // 🔴 EVERY REPORT MUST FOLD IN THE CONSTANT, NEVER RETYPE THE 29 NAMES. A report that lists them
  // itself is a second place for one to go missing, and a missing column reads `undefined` and prints a
  // blank — which on a report is indistinguishable from a visit that recorded nothing. This is the one
  // guarantee a type cannot give, because a PostgREST select is a string.
  for (const report of REPORT_SELECTS) {
    // 🔴 COUNTED, NOT MERELY FOUND. A bare search for the name matches the `import` statement, so a
    // report whose select list had been replaced by a hand-typed subset still read as carrying the field
    // set — I replaced `field-activity/report.ts`'s list with two columns and this assertion stayed
    // green. Two mentions means the import AND a use, and a select list is the only thing it is used in.
    const source = readFileSync(report.file, "utf8");
    const mentions = source.split("PHOENIX_VISIT_DETAIL_COLUMNS").length - 1;
    assert.ok(
      mentions >= 2,
      `${report.what} must add PHOENIX_VISIT_DETAIL_COLUMNS to its select list, not name the columns again ` +
        `(found ${mentions} mention(s) — one of them is the import, which proves nothing about the select list)`,
    );
  }
}

async function runAuditSheetTests(): Promise<void> {
  // 🔴 ONE HEADER ROW PER SHEET, WHATEVER THE SECTIONS HOLD. A coach's combined tab stacks several
  // months one under another under a SINGLE header. Sight is decided per row, so two months can produce
  // different column sets — and a per-section header would put the same cell under two headings on one
  // sheet, which is how a distance gets read as a dwell. The union, in first-appearance order, is the fix.
  const sections: DoubleVisitAuditSection[] = [
    { label: "Sep", data: { ...AUDIT_DATA, phoenixHeaders: ["Visit kind", "Products"] } },
    { label: "Oct", data: { ...AUDIT_DATA, phoenixHeaders: ["Visit kind", "Distance (m)"] } },
  ];
  const workbook = await buildCombinedAuditWorkbook(sections);
  const sheet = workbook.worksheets.find((candidate) => candidate.name.toLowerCase() !== "summary");
  assert.ok(sheet, "the combined workbook has a coach tab");
  const headerRows: string[][] = [];
  sheet.eachRow((row) => {
    const values = (row.values as unknown[]).slice(1).map((value) => String(value ?? ""));
    // "Per day" above it starts with Date · Day · Week too — the 4th cell is what tells them apart.
    if (values[0] === "Date" && values[1] === "Day" && values[3] === "Rep") headerRows.push(values);
  });
  assert.equal(headerRows.length, 2, "both months print the detail header");
  assert.deepEqual(headerRows[0], headerRows[1], "and both print the SAME one — a shifted column is a misread cell");
  assert.deepEqual(
    headerRows[0].slice(9),
    ["And With", "Visit kind", "Products", "Distance (m)"],
    "the second coach is named and the union of both months' field-set columns follows, in order",
  );
}


function runCompanyActivityTests(): void {
  const phoenixRow: CrmDetailRow = {
    id: "1",
    crm_visit_id: -9001,
    visit_date: "2026-10-07",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    comment: null,
    customer_name: null,
    contact_name: "Dr A",
    ampm: "PM",
    agent_hr_id: "B-100",
    double_hr_id: "B-900",
    double2_hr_id: "B-155",
    double2_name: "A Product Manager",
    agent_crm_id: 1397,
    contact_crm_id: 500,
    double_crm_id: null,
    crm_save_date: "2026-10-07 11:00:00+00",
    ...FULL_ROW,
  };

  // 🔴 NO READER NAMED MEANS NO PHOENIX DETAIL, which is NOT the `none` tier. `none` still shows the
  // work half — it blinds the integrity signals only — so defaulting an unnamed caller to it would print
  // a rep's products and objections to code that never said who was reading.
  assert.equal(buildVisitDetail(phoenixRow, null).phoenix, null, "no reader named: the cell reads as it always did");
  assert.equal(buildVisitDetail(phoenixRow, null).partner2Name, "A Product Manager", "but the second manager is still named");

  // 🔴 THE `rows.map(buildVisitDetail)` TRAP. `map` passes the INDEX second, so a bare function reference
  // would hand the sight parameter a number — and `0` is not a tier, so the shaper would fall through to
  // its widest reading for every row. These two assertions are what a reintroduced bare reference breaks.
  const distance = buildVisitDetail(phoenixRow, "distance");
  assert.equal(distance.phoenix?.products.join(", "), "Ivyronc, Guamusin", "the work half is whole at the distance tier");
  assert.ok(distance.phoenix?.location, "and the distance itself is read");
  assert.equal(distance.phoenix?.capture, null, "but never the capture timing — that is the Super Admin's and the SFE Manager's");

  const own = buildVisitDetail(phoenixRow, "none");
  assert.equal(own.phoenix?.products.join(", "), "Ivyronc, Guamusin", "his own row still shows his own work");
  assert.equal(own.phoenix?.location, null, "and no location at all");

  // A vendor visit carries no `visit_kind`, so it carries nothing — at EVERY tier, the Super Admin's too.
  const vendor: CrmDetailRow = { ...phoenixRow, ...Object.fromEntries(Object.keys(FULL_ROW).map((key) => [key, null])) };
  assert.equal(buildVisitDetail(vendor, "full").phoenix, null, "a vendor visit prints nothing rather than a row of blanks");

  // 🔴 "CAMPAIGN" IS NOW UNPLANNED (owner, 6 Nov 2026). The report's count read visit type −8 alone, which no
  // Phoenix visit ever carries (the door serves them all as type 0), so it read 0 for every day from 6 Nov.
  assert.equal(buildVisitDetail(phoenixRow, null).isCampaign, true, "a Phoenix visit marked unplanned counts as unplanned");
  assert.equal(buildVisitDetail(phoenixRow, null).label, "Unplanned visit", "and names itself, never \"Regular\" beside the highlight");
  const planned = buildVisitDetail({ ...phoenixRow, is_unplanned: false }, null);
  assert.equal(planned.isCampaign, false, "a planned Phoenix visit is not unplanned");
  assert.notEqual(planned.label, "Unplanned visit", "and keeps its own label");
  const archiveCampaign = buildVisitDetail({ ...vendor, visit_type: -8, visit_type_description: "Campaign/Prospection" }, null);
  assert.equal(archiveCampaign.isCampaign, true, "an archive-day campaign visit (−8) is unplanned, the 29 Oct mapping");
  assert.equal(buildVisitDetail(vendor, null).isCampaign, false, "an archive-day regular visit is not");
}

export async function runPhoenixFieldSetOnAdminReportsTests(): Promise<void> {
  runTierTests();
  runViewerTests();
  runSheetTests();
  runSelectListTests();
  runDrilldownTests();
  runReportCarryTests();
  runCompanyActivityTests();
  await runAuditSheetTests();
}
