import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  addBucketToSplit,
  addVisitToSplit,
  emptyVisitCountSplit,
  formatPharmacyFigure,
  formatVisitCountSplit,
  isPharmacyVisitRow,
  mergeVisitCountSplits,
  pharmacyCellNote,
  pharmacyCellValue,
  pharmacyFigureText,
  pharmacyRecordingOf,
  pharmacyTileFigure,
  pharmacyValueText,
  visitCountBucket,
  visitCountSplitTotal,
  type VisitCountSplit,
} from "../src/lib/crm/visit-count-buckets.ts";
import { sumDoubleVisitSplit } from "../src/lib/double-visit-analytics/count-bucket.ts";
import { buildReportSummaryMetrics } from "../src/lib/double-visit-analytics/report-filters.ts";
import type { DoubleVisitReportRow } from "../src/lib/double-visit-analytics/types.ts";
import { buildFieldActivityReport, type FieldActivityVisitRow } from "../src/lib/field-activity/model.ts";
import {
  classifyDoubleVisitRows,
  doubleVisitCompanions,
  privateCalendarActivityKindLabels,
  privateCalendarActivityKinds,
  privateCalendarItemKind,
  summarizePrivateCalendarVisits,
  visitCategoryOfType,
  type PairableDoubleVisitRow,
} from "../src/lib/private-calendar/activity-kinds.ts";
import type { CrmListType } from "../src/lib/crm/contacts-web-client.ts";
import { phoenixVisitLane, type PhoenixVisit } from "../src/lib/crm/phoenix-kpi-rules.ts";
import { summarizeVisits, type VisitRow } from "../src/lib/employee-360/service.ts";
import { fieldVisitActivityKind } from "../src/lib/private-calendar/field-visits.ts";

// THE AM · PM · PHARMACIES GOLDEN RULE (owner, 2026-09-21): every count of CRM visits is AM, PM and
// Pharmacies reported apart, and a pharmacy is NEVER counted inside PM (the doctors) or AM. The
// vendor tags a pharmacy visit with a period like any other — 1,827 pharmacy visits carried 'PM'
// and 426 'AM' between 2026-08-01 and 2026-09-20 — so a count that buckets on `ampm` alone files
// them among the doctors. Plus the Private Calendar's colour key: one colour per kind of day, a
// visit coloured by who went (single, double, chain) crossed with regular or campaign.
export function runVisitCountGoldenRuleTests() {
  // ── the bucket ──────────────────────────────────────────────────────────────────────────────
  assert.equal(visitCountBucket({ ampm: "PM", speciality: "Pharmacy" }), "Pharmacies", "a pharmacy tagged PM is a pharmacy, never a PM doctor");
  assert.equal(visitCountBucket({ ampm: "AM", speciality: "pharmacy" }), "Pharmacies", "a pharmacy tagged AM is a pharmacy, never an AM account");
  assert.equal(visitCountBucket({ ampm: "PM", speciality: "Pediatrics" }), "PM", "a doctor tagged PM stays PM");
  assert.equal(visitCountBucket({ ampm: "AM", speciality: "Hospital" }), "AM", "a hospital account tagged AM stays AM — a hospital is not a pharmacy");
  assert.equal(visitCountBucket({ ampm: null, speciality: null }), "PM", "an unmarked period lands in exactly one bucket, never none");
  assert.equal(
    visitCountBucket({ ampm: "PM", comment: "ص السلامه", speciality: null, visit_type: -30 }),
    "Pharmacies",
    "the -30 field visit carries no contact: the rep's pharmacy shorthand in the comment routes it, the same test the call-rate board uses",
  );
  assert.equal(
    visitCountBucket({ ampm: "PM", comment: "Dr Ahmed clinic", speciality: null, visit_type: -30 }),
    "PM",
    "a -30 visit that does not read as a pharmacy stays with the doctors",
  );
  assert.equal(isPharmacyVisitRow({ comment: "pharmacy", visit_type: 0 }), false, "the comment route is -30's alone; a regular visit is judged by its contact");
  // AND THE CUSTOMER'S OWN LIST, which is how a Phoenix pharmacy call says so: the view hands `list_type`
  // over as `ampm`, and `Pharmacy` is one of its three values. The speciality alone was not enough — 5 of
  // Delta (1)'s 25 pharmacy calls of 2026-10-03 carried none and were counted among the PM DOCTORS.
  assert.equal(visitCountBucket({ ampm: "Pharmacy", speciality: null, visit_type: 0 }), "Pharmacies", "a pharmacy on its list alone, with no speciality to help");
  assert.equal(visitCountBucket({ ampm: "Pharmacy", speciality: "Pharmacy", visit_type: 0 }), "Pharmacies", "and with one");
  assert.equal(isPharmacyVisitRow({ ampm: "Pharmacy" }), true, "the list is read on its own, before anything else on the row");
  assert.notEqual(visitCountBucket({ ampm: "Pharmacy", speciality: null, visit_type: 0 }), "PM", "never among the doctors — a pharmacy call is in no KPI");

  // ── the split and its words ────────────────────────────────────────────────────────────────
  {
    const split = emptyVisitCountSplit();
    addVisitToSplit(split, { ampm: "AM", speciality: "Surgery" });
    addVisitToSplit(split, { ampm: "PM", speciality: "Cardiology" });
    addVisitToSplit(split, { ampm: "PM", speciality: "Cardiology" });
    addVisitToSplit(split, { ampm: "PM", speciality: "Pharmacy" });
    assert.deepEqual(split, { am: 1, pm: 2, pharmacies: 1 });
    assert.equal(visitCountSplitTotal(split), 4, "every visit is counted once, in one bucket");
    assert.equal(formatVisitCountSplit(split), "AM 1 · PM 2 · Pharmacies 1", "the three figures apart, joined by a middle dot");
    assert.equal(formatVisitCountSplit({ am: 0, pm: 3, pharmacies: 0 }, { compact: true }), "PM 3", "a compact chip drops a zero figure");
    assert.equal(formatVisitCountSplit({ am: 0, pm: 0, pharmacies: 0 }, { compact: true }), "No visits");
    assert.equal(formatVisitCountSplit({ am: 0, pm: 0, pharmacies: 0 }), "AM 0 · PM 0 · Pharmacies 0", "the full form always prints all three");
    assert.doesNotMatch(formatVisitCountSplit(split), /\//, "never a slash between the figures");
  }

  // ── regular or campaign ────────────────────────────────────────────────────────────────────
  assert.equal(visitCategoryOfType(0), "regular");
  assert.equal(visitCategoryOfType(-30), "regular", "the unlabelled field visit counts in its normal place, as regular");
  assert.equal(visitCategoryOfType(-8), "campaign");
  assert.equal(visitCategoryOfType(-4), null, "a leave day is not a visit");
  assert.equal(visitCategoryOfType(-9), null, "a training day is not a visit");

  // ── a rep's own CRM rows: which colour, and which rows the Double Visit feed owns ───────────
  assert.equal(fieldVisitActivityKind({ double_crm_id: null, double_hr_id: null, source: "ireports360", visit_type: 0 }), "single_regular");
  assert.equal(fieldVisitActivityKind({ double_crm_id: 0, double_hr_id: null, source: "ireports360", visit_type: -8 }), "single_campaign", "the vendor's 0 partner is no partner");
  assert.equal(
    fieldVisitActivityKind({ double_crm_id: 5123, double_hr_id: null, source: "ireports360", visit_type: 0 }),
    null,
    "a partnered regular visit is the Double Visit feed's — counting it here as well would count it twice",
  );
  assert.equal(fieldVisitActivityKind({ double_crm_id: 5123, double_hr_id: null, source: "ireports360", visit_type: -8 }), null);
  assert.equal(
    fieldVisitActivityKind({ double_crm_id: 5123, double_hr_id: null, source: "ireports360", visit_type: -30 }),
    "double_regular",
    "a partnered -30 visit is a double visit the Double Visit feed does not read, so it is shown here",
  );
  assert.equal(fieldVisitActivityKind({ double_crm_id: null, double_hr_id: null, source: "ireports360", visit_type: -4 }), "vacation");
  assert.equal(fieldVisitActivityKind({ double_crm_id: null, double_hr_id: null, source: "ireports360", visit_type: -9 }), "other_crm");

  // ── double and chain visits: a chain stop is ONE chain visit, counted once ──────────────────
  {
    const base = {
      activity_date: "2026-09-10",
      speciality: null,
      visit_type: 0,
    };
    const rows: PairableDoubleVisitRow[] = [
      // the manager's row naming the rep
      { ...base, double_visitor_hr_id: "DM-1", double_visitor_name: "Dina Manager", id: "r1", period: "PM", visited_employee_hr_id: "MR-1", visited_employee_name: "Mona Rep" },
      // the senior manager's row, re-attributed to the rep by the chain resolver
      {
        ...base,
        chain_hinge_hr_id: "DM-1",
        chain_hinge_name: "Dina Manager",
        double_visitor_hr_id: "RM-1",
        double_visitor_name: "Rami Senior",
        id: "r2",
        period: "PM",
        resolved_via_chain: true,
        visited_employee_hr_id: "MR-1",
        visited_employee_name: "Mona Rep",
      },
      // a plain double visit the same day, at a pharmacy tagged PM
      { ...base, double_visitor_hr_id: "DM-1", double_visitor_name: "Dina Manager", id: "r3", period: "PM", speciality: "Pharmacy", visited_employee_hr_id: "MR-2", visited_employee_name: "Sara Rep" },
      // a campaign double visit
      { ...base, double_visitor_hr_id: "DM-1", double_visitor_name: "Dina Manager", id: "r4", period: "AM", visit_type: -8, visited_employee_hr_id: "MR-2", visited_employee_name: "Sara Rep" },
    ];
    const classified = classifyDoubleVisitRows(rows);
    const byId = new Map(classified.map((entry) => [entry.row.id, entry]));
    assert.equal(byId.get("r1")?.companion, "chain", "the manager's row of a paired chain is a chain visit");
    assert.equal(byId.get("r1")?.seniorName, "Rami Senior");
    assert.equal(byId.get("r2")?.absorbed, true, "the senior manager's half folds into the rep's row");
    assert.equal(byId.get("r2")?.physicalId, "r1", "both halves stand for ONE physical visit");
    assert.equal(byId.get("r3")?.companion, "double");
    assert.equal(byId.get("r3")?.bucket, "Pharmacies", "a pharmacy double visit tagged PM counts as a pharmacy");
    assert.equal(byId.get("r4")?.category, "campaign");
    assert.deepEqual(doubleVisitCompanions(byId.get("r1")!, "received"), ["Dina Manager", "Rami Senior"], "the rep sees both people who went with her");
    assert.deepEqual(doubleVisitCompanions(byId.get("r2")!, "performed"), ["Mona Rep", "Dina Manager"], "the senior manager sees the rep and the manager in between");

    // Every person on the chain has an item: manager (performed), senior (performed) and rep
    // (received). A team view holding all three still counts the stop once.
    const record = (id: string) => [{ bucket: "PM" as const, id }];
    const summary = summarizePrivateCalendarVisits([
      { activityKind: "chain_regular", source: "double_visit", visitRecords: record("r1") },
      { activityKind: "chain_regular", source: "double_visit", visitRecords: record("r1") },
      { activityKind: "chain_regular", source: "double_visit", visitRecords: record("r1") },
      { activityKind: "double_regular", source: "double_visit", visitRecords: [{ bucket: "Pharmacies", id: "r3" }] },
      { activityKind: "single_regular", source: "field_visit", visitCounts: { am: 2, pm: 5, pharmacies: 3 } },
      { activityKind: "vacation", source: "field_visit", visitCounts: null },
    ]);
    assert.deepEqual(summary.chain_regular, { am: 0, pm: 1, pharmacies: 0 }, "a chain stop counts once however many of its people the view holds");
    assert.deepEqual(summary.double_regular, { am: 0, pm: 0, pharmacies: 1 });
    assert.deepEqual(summary.single_regular, { am: 2, pm: 5, pharmacies: 3 });
    assert.deepEqual(summary.all, { am: 2, pm: 6, pharmacies: 4 }, "the total is the kinds added up, pharmacies apart");
  }

  // ── the colour key ─────────────────────────────────────────────────────────────────────────
  assert.equal(privateCalendarActivityKinds.length, 13, "attendance, vacation, excuse, holiday, the approved plan, six visit kinds, other CRM activity and an admin-verified correction");
  assert.equal(new Set(Object.values(privateCalendarActivityKindLabels)).size, 13, "every kind has a name of its own");
  assert.equal(privateCalendarItemKind({ source: "double_visit" }), "double_regular", "an item from before the kinds existed still gets a colour");

  const ui = readFileSync("src/components/employee-portal/private-calendar.tsx", "utf8");
  {
    const tonesStart = ui.indexOf("const kindTones: Record<PrivateCalendarActivityKind");
    const tonesBody = ui.slice(tonesStart, ui.indexOf("\n};\n", tonesStart));
    const swatches = [...tonesBody.matchAll(/swatch: "([^"]+)"/g)].map((match) => match[1]);
    assert.equal(swatches.length, 13, "every kind has a swatch");
    assert.equal(new Set(swatches).size, 13, `every kind wears its own colour, got ${swatches.join(", ")}`);
    const chips = [...tonesBody.matchAll(/chip: "([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(chips).size, 13, "every kind's card is distinct");
    for (const kind of privateCalendarActivityKinds) {
      assert.match(tonesBody, new RegExp(`\\n  ${kind}: \\{`), `${kind} must have its tones`);
    }
    assert.doesNotMatch(tonesBody, /orange|indigo|red-/, "orange (selection, warning), indigo (review) and red (No Activity) are never a kind's colour");
  }
  assert.match(ui, /const noActivitySwatch = "bg-red-700";/, "No Activity Recorded wears its own solid colour");
  assert.match(ui, /exception\.code === NO_ACTIVITY_CODE\) return "border-l-\[3px\] border-l-red-950 bg-red-700 text-white"/);
  assert.doesNotMatch(ui, /function sourceChipTone\(source: PrivateCalendarSource, severity/, "a problem never repaints a kind's colour — severity is an outline");

  // ── key figures and filters: two narrow rows each, collapsible ─────────────────────────────
  assert.match(ui, /aria-controls="private-calendar-key-figures"\s*\n\s*aria-expanded=\{open\}/, "the key figures fold away");
  assert.match(ui, /aria-controls="private-calendar-filters"\s*\n\s*aria-expanded=\{filtersOpen\}/, "the filters fold away");
  assert.match(ui, /"grid grid-cols-2 gap-x-3 gap-y-2 border-t border-slate-100 px-4 py-3 lg:grid-cols-4 lg:items-end"/, "the filters are at most two rows on a desk (four across) — no seven-column strip");
  assert.doesNotMatch(ui, /function Metric\(/, "the eight tall metric cards are gone");
  assert.doesNotMatch(ui, /h-10 w-full/, "the filter controls are the narrow 36px height");
  assert.match(ui, /formatVisitCountSplit\(split, \{ compact: true \}\)/, "the key figures print each kind's visits AM · PM · Pharmacies apart");
  assert.match(ui, /formatVisitCountSplit\(row\.visitCounts\)/, "the team snapshot prints each person's visits AM · PM · Pharmacies apart");
  assert.match(ui, /window\.localStorage/, "a viewer's open or folded choice is remembered in their browser");
  assert.match(ui, /catch \{\s*\n\s*return null;/, "a blocked storage read falls back to the defaults, never throws");

  // ── the golden rule reaches every calendar count, the download included ─────────────────────
  const fieldVisits = readFileSync("src/lib/private-calendar/field-visits.ts", "utf8");
  assert.match(fieldVisits, /addVisitToSplit\(existing\.split, row\)/, "a rep's own visits are bucketed by the golden-rule helper");
  assert.match(fieldVisits, /ampm,speciality,comment/, "the read carries what the bucket needs: period, contact speciality and the -30 comment");
  const exporter = readFileSync("src/lib/private-calendar/export.ts", "utf8");
  assert.match(exporter, /wsSum\.addRow\(\["Visits", "AM", "PM", "Pharmacies"\]\)/, "the download's summary counts visits AM · PM · Pharmacies apart");
  assert.match(exporter, /workspace\.visitSummary \?\? summarizePrivateCalendarVisits\(workspace\.items\)/);
  const helper = readFileSync("src/lib/crm/visit-count-buckets.ts", "utf8");
  assert.doesNotMatch(helper, /^import .*supabase|server-only/m, "the helper stays pure so a client component can import it");

  // ── the Phoenix KPI lanes: the pharmacy outranks the list ──────────────────────────────────
  {
    const lists = new Map<number, ReadonlySet<CrmListType>>([
      [11, new Set<CrmListType>(["PM"])],
      [12, new Set<CrmListType>(["AM"])],
      [13, new Set<CrmListType>(["Pharmacy"])],
    ]);
    const laneVisit = (contact: number, extra: Partial<PhoenixVisit> = {}): PhoenixVisit => ({
      ampm: "PM",
      comment: null,
      contact_crm_id: contact,
      hasCheckin: true,
      speciality: null,
      visit_date: "2026-09-08",
      visit_type: 0,
      visit_type_description: null,
      ...extra,
    });
    assert.equal(phoenixVisitLane(laneVisit(11), lists), "pm", "a doctor on the PM list is a PM visit");
    assert.equal(phoenixVisitLane(laneVisit(12, { ampm: "AM" }), lists), "am", "an account on the AM list is an AM visit");
    assert.equal(
      phoenixVisitLane(laneVisit(11, { speciality: "Pharmacy" }), lists),
      "pharmacy",
      "a pharmacy the rep carries on a PM list is still a pharmacy visit — never one of the PM doctors",
    );
    assert.equal(phoenixVisitLane(laneVisit(12, { ampm: "AM", speciality: "pharmacy" }), lists), "pharmacy", "nor one of the AM accounts");
    assert.equal(
      phoenixVisitLane(laneVisit(11, { comment: "ص السلامه", visit_type: -30 }), lists),
      "pharmacy",
      "a -30 visit whose comment reads as a pharmacy is a pharmacy visit, whatever list the contact sits on",
    );
    assert.equal(phoenixVisitLane(laneVisit(13), lists), "pharmacy", "a Pharmacy-list contact is a pharmacy visit");
  }

  // ── Employee 360: AM · PM · Pharmacies apart ───────────────────────────────────────────────
  {
    const row = (extra: Partial<VisitRow>): VisitRow => ({
      ampm: "PM",
      comment: null,
      contact_crm_id: 1,
      contact_name: null,
      customer_name: null,
      double_crm_id: null,
      double_hr_id: null,
      double_name: null,
      visit_date: "2026-09-08",
      visit_type: 0,
      visit_type_description: "Regular",
      ...extra,
    });
    const summary = summarizeVisits(
      [
        row({ ampm: "AM", speciality: "Surgery" }),
        row({ ampm: "PM", speciality: "Cardiology" }),
        row({ ampm: "PM", speciality: "Pharmacy" }),
        row({ ampm: "AM", speciality: "pharmacy" }),
        row({ ampm: null, speciality: "Cardiology" }),
      ],
      { from: "2026-09-01", label: "September", to: "2026-09-30" },
    );
    assert.deepEqual(
      { am: summary.amVisits, pharmacies: summary.pharmacyVisits, pm: summary.pmVisits },
      { am: 1, pharmacies: 2, pm: 2 },
      "Employee 360 counts a pharmacy under Pharmacies whatever period it carries, and a doctor visit with no period is PM — there is no fourth bucket",
    );
    assert.equal("unknownAmpm" in summary, false, "no 'unmarked' figure is carried beside the three");
    const e360Service = readFileSync("src/lib/employee-360/service.ts", "utf8");
    // `speciality` was the LAST select item until the Phoenix field set was appended on 2026-10-07 and
    // the list became several concatenated literals. It pins the ITEM now: the guarantee is that the
    // speciality is read, not that nothing is read after it.
    assert.match(e360Service, /,source,speciality,/, "the Employee 360 read carries the contact speciality that marks a pharmacy");
    const e360View = readFileSync("src/components/employee-360/employee-360-view.tsx", "utf8");
    assert.match(
      e360View,
      /<KpiTile label="Pharmacy visits" value=\{pharmacyTile\.value\} hint=\{pharmacyTile\.note \?\? undefined\} \/>/,
      "the spend panel shows pharmacy visits as their own tile — worded by the helper, so a Phoenix CRM rep's is never 0",
    );
    assert.match(e360View, /const pharmacyTile = pharmacyTileFigure\(visitSplitOf\(activity\)/);
    // Number first, the way the call rate is written (" AM · " / " PM"): "12 AM · 30 PM · 5 Pharmacies".
    assert.match(
      e360View,
      /\{intFmt\.format\(summary\.amVisits\)\} AM · \{intFmt\.format\(summary\.pmVisits\)\} PM · \{formatPharmacyFigure\(visitSplitOf\(summary\), \{ formatNumber: \(value\) => intFmt\.format\(value\), numberFirst: true \}\)\}/,
    );
    assert.doesNotMatch(e360View, / AM \/ \{intFmt/, "the visit split never joins AM and PM with a slash");
  }

  // ── the executive field-activity bar ───────────────────────────────────────────────────────
  {
    const sfe = readFileSync("src/lib/crm/sfe-field-analytics.ts", "utf8");
    assert.match(sfe, /if \(bucket === "Pharmacies"\) pharmacyVisits\+\+;/, "the SFE field analytics count a pharmacy apart from AM and PM");
    assert.match(sfe, /crm_visit_id,speciality,visit_date/, "the SFE read carries the contact speciality");
    const ceo = readFileSync("src/components/admin/ceo-phase-b.tsx", "utf8");
    assert.match(ceo, />AM · PM · Pharmacies</, "the executive bar is headed AM · PM · Pharmacies");
    assert.doesNotMatch(ceo, />AM \/ PM split</, "never AM / PM joined with a slash");
    assert.match(ceo, /bg-emerald-600" style=\{\{ width: `\$\{share\(pharmacyVisits\)\}%` \}\}/, "pharmacies get their own segment of the bar");
  }

  // ── Business Review, converted 2026-09-26 ─────────────────────────────────────────────────
  //
  // The last surface that counted a pharmacy as a doctor. Measured on production before the change:
  // July 2026's "Doctors reached" read 7,364, of which 1,030 — one in seven — were pharmacies, and
  // the single "Visits" figure folded in 1,680 pharmacy calls. Owner: "everything full detailed",
  // so the split reaches the KPI tiles, every table, the role and people rows and the workbook.
  {
    const visits = readFileSync("src/lib/business-review/sources/visits.ts", "utf8");
    assert.match(visits, /visitCountBucket\(\{/, "the review buckets through the one shared authority, never a second copy");
    assert.match(visits, /ampm, contact_crm_id/, "its projection carries the period tag");
    assert.match(visits, /speciality, visit_date, visit_type/, "and the contact speciality that marks a pharmacy");
    assert.match(
      visits,
      /visitTypes: \[UNLABELLED_FIELD_VISIT_TYPE\]/,
      "the vendor's -30 field visit carries no contact, so its comment is read by a second narrow query",
    );
    // THE CATCH-ALL. Contact 100000 is a slot the vendor writes when the rep named nobody. Every
    // other CRM surface excludes it; this one did not, and added a phantom customer wherever it
    // appeared (6 rows, one phantom doctor, September 2026).
    assert.match(
      visits,
      /row\.contact_crm_id !== CATCH_ALL_CONTACT_CRM_ID/,
      "the catch-all contact is excluded from the customer count, using the shared constant",
    );
    assert.doesNotMatch(visits, /=== 100000|!== 100000/, "by the constant, never a bare literal");

    // Unlike Employee 360, this page files an unmarked period under PM, so the three buckets always
    // sum to the visit total — its figures have to add up against the sales beside them.
    const split = emptyVisitCountSplit();
    for (const row of [
      { ampm: "AM", speciality: "Surgery" },
      { ampm: "PM", speciality: "Cardiology" },
      { ampm: "PM", speciality: "Pharmacy" },
      { ampm: "AM", speciality: "pharmacy" },
      { ampm: null, speciality: "Cardiology" },
    ]) addVisitToSplit(split, row);
    assert.deepEqual(split, { am: 1, pm: 2, pharmacies: 2 }, "an unmarked period lands in PM here, so nothing falls out");
    assert.equal(visitCountSplitTotal(split), 5, "and the three always sum to the total");

    for (const [file, label] of [
      ["src/components/business-review/dashboard.client.tsx", "the admin dashboard"],
      ["src/components/business-review/portal-review.client.tsx", "the portal page"],
      ["src/components/business-review/rollups.client.tsx", "the shared rollup tables"],
      ["src/lib/business-review/excel-export.ts", "the workbook"],
    ] as const) {
      const src = readFileSync(file, "utf8");
      assert.match(src, /formatVisitCountSplit/, `${label} formats the split with the shared formatter`);
      assert.match(src, /AM · PM · Pharmacies/, `${label} names the three figures in the house wording`);
      assert.doesNotMatch(src, /AM ?\/ ?PM/, `${label} must never join them with a slash`);
      assert.doesNotMatch(
        src,
        /"Doctors reached"|>Doctors</,
        `${label} must not print a union of accounts, doctors and pharmacies under the word "Doctors"`,
      );
    }
  }

  runPhoenixPharmacyFigureTests();
}

// ── PHOENIX CRM RECORDS PHARMACY CALLS (owner, 2026-10-03) ────────────────────────────────────────
//
// It did NOT until that ruling, and this suite pinned the consequence: a pharmacy existed in Phoenix CRM
// only as stock feedback typed ON a doctor's visit, so a started team's Pharmacies figure was worded
// "not recorded in Phoenix" rather than printed as 0, under AGENTS.md §7 ("when a data source is
// unavailable, verify the UI says so rather than showing a misleading zero"). Then the owner ruled that a
// pharmacy named on a visit counts as that pharmacy's own visit — no validation, no plan, no approval —
// and Delta (1) logged 25 of them on its first Phoenix day. The source was never unavailable again, so
// the three sets of words became three false statements and `pharmacyRecordingOf` now answers "recorded"
// for every split.
//
// What this function pins now: the figure is a REAL count in every layout, the retired wording appears
// NOWHERE, and the structural half is untouched — every consumer still reads the helper rather than a
// bare figure of its own, and a split still knows which of its rows are Phoenix CRM's (`phoenix`), which
// is what the AM · PM · Pharmacies bar's tooltip reads.
function runPhoenixPharmacyFigureTests() {
  const phoenixVisit = (ampm: "AM" | "PM") => ({ ampm, crm_visit_id: -3543007088324739, source: "phoenix", speciality: "Pediatrics", visit_type: 0 });
  const vendorVisit = (ampm: "AM" | "PM", speciality = "Cardiology") => ({ ampm, crm_visit_id: 9_120_001, source: "ireports360", speciality, visit_type: 0 });
  /** A Phoenix pharmacy call: its customer's own list, and — as 5 of Delta (1)'s 25 were — no speciality. */
  const phoenixPharmacyCall = { ampm: "Pharmacy", crm_visit_id: -948269888598658, source: "phoenix", speciality: null, visit_type: 0 };

  // ── the split learns which rows are Phoenix CRM's ──
  {
    const vendorOnly = emptyVisitCountSplit();
    addVisitToSplit(vendorOnly, vendorVisit("AM"));
    addVisitToSplit(vendorOnly, vendorVisit("PM", "Pharmacy"));
    assert.deepEqual(vendorOnly, { am: 1, pm: 0, pharmacies: 1 }, "a split with no Phoenix row never carries the key — every old literal means what it did");
    assert.equal(pharmacyRecordingOf(vendorOnly), "recorded");

    const phoenixOnly = emptyVisitCountSplit();
    addVisitToSplit(phoenixOnly, phoenixVisit("AM"));
    addVisitToSplit(phoenixOnly, phoenixVisit("PM"));
    addVisitToSplit(phoenixOnly, { ampm: "PM", crm_visit_id: -12, speciality: null, visit_type: 0 });
    assert.deepEqual(phoenixOnly, { am: 1, pm: 2, pharmacies: 0, phoenix: 3 }, "a reader that never selected `source` is told by the negative id");
    assert.equal(pharmacyRecordingOf(phoenixOnly), "recorded", "a Phoenix-only split's 0 is a true 0 — nobody called a pharmacy that day");

    // A PHOENIX PHARMACY CALL LANDS IN PHARMACIES ON ITS LIST ALONE. Its customer carries no speciality,
    // so reading only the speciality filed it among the PM DOCTORS — 5 of Delta (1)'s 25 calls of
    // 3 October, three of B-158's and two of B-100's, against the rule that a pharmacy is in no KPI.
    assert.equal(visitCountBucket(phoenixPharmacyCall), "Pharmacies", "the customer's list says pharmacy, with no speciality to help");
    assert.equal(visitCountBucket({ ...phoenixPharmacyCall, speciality: "Pharmacy" }), "Pharmacies", "and with one");
    const phoenixWithPharmacy = emptyVisitCountSplit();
    addVisitToSplit(phoenixWithPharmacy, phoenixVisit("PM"));
    addVisitToSplit(phoenixWithPharmacy, phoenixPharmacyCall);
    assert.deepEqual(phoenixWithPharmacy, { am: 0, pm: 1, pharmacies: 1, phoenix: 2 }, "never 2 PM doctors");
    assert.equal(pharmacyRecordingOf(phoenixWithPharmacy), "recorded", "and Phoenix's own count is the whole count");

    const both = mergeVisitCountSplits(mergeVisitCountSplits(emptyVisitCountSplit(), vendorOnly), phoenixOnly);
    assert.deepEqual(both, { am: 2, pm: 2, pharmacies: 1, phoenix: 3 }, "a merge carries the Phoenix share with the figures");
    assert.equal(pharmacyRecordingOf(both), "recorded", "beside vendor rows the figure counts BOTH sources, so \"(iReports360 only)\" would be false");
    assert.deepEqual(emptyVisitCountSplit(), { am: 0, pm: 0, pharmacies: 0 }, "the empty split keeps its shape");
    assert.deepEqual(addBucketToSplit(emptyVisitCountSplit(), "PM", 2, true), { am: 0, pm: 2, pharmacies: 0, phoenix: 2 });
    assert.deepEqual(addBucketToSplit(emptyVisitCountSplit(), "PM", 2), { am: 0, pm: 2, pharmacies: 0 });
    assert.deepEqual(
      sumDoubleVisitSplit([{ n: 2, p: true }, { n: 1, p: false }], () => "PM", (row) => row.n, (row) => row.p),
      { am: 0, pm: 3, pharmacies: 0, phoenix: 2 },
      "Double Visit Analytics' sum marks its Phoenix rows too",
    );
  }

  // ── THE WORDS: one case now — the figure — in every layout, full and compact ──
  {
    const phoenixOnly: VisitCountSplit = { am: 2, pm: 5, pharmacies: 0, phoenix: 7 };
    const phoenixWithPharmacies: VisitCountSplit = { am: 2, pm: 5, pharmacies: 3, phoenix: 10 };
    const both: VisitCountSplit = { am: 3, pm: 9, pharmacies: 2, phoenix: 4 };
    const vendorOnly: VisitCountSplit = { am: 3, pm: 9, pharmacies: 2 };

    assert.equal(formatVisitCountSplit(vendorOnly), "AM 3 · PM 9 · Pharmacies 2", "no Phoenix row: exactly as before");
    assert.equal(formatVisitCountSplit(vendorOnly, { compact: true }), "AM 3 · PM 9 · Pharmacies 2");
    assert.equal(formatVisitCountSplit({ am: 0, pm: 4, pharmacies: 0 }, { compact: true }), "PM 4", "and a compact chip still drops a real zero");

    // THE HEADLINE, INVERTED BY THE 2026-10-03 RULING: a Phoenix split prints its pharmacy COUNT. A 0 is
    // a true 0 — the rep called no pharmacy — and 3 is three calls Phoenix recorded.
    assert.equal(formatVisitCountSplit(phoenixWithPharmacies), "AM 2 · PM 5 · Pharmacies 3", "Phoenix's own pharmacy calls, counted");
    assert.equal(formatVisitCountSplit(phoenixOnly), "AM 2 · PM 5 · Pharmacies 0", "and a 0 means none was called, not that none could be");
    assert.equal(formatVisitCountSplit({ am: 0, pm: 5, pharmacies: 0, phoenix: 5 }, { compact: true }), "PM 5", "a compact chip drops it like any real zero");
    assert.equal(formatVisitCountSplit(both), "AM 3 · PM 9 · Pharmacies 2", "beside vendor rows the figure counts both sources");
    assert.equal(formatVisitCountSplit(both, { compact: true }), "AM 3 · PM 9 · Pharmacies 2");

    // THE RETIRED WORDING REACHES NO LAYOUT AT ALL. This is the assertion that fails if anything rewires
    // `pharmacyRecordingOf` to speak again, and it is checked against every split shape and every helper.
    const retired = /not recorded in Phoenix|iReports360 only|logs no pharmacy|Not recorded/;
    for (const split of [phoenixOnly, phoenixWithPharmacies, both, vendorOnly, { am: 0, pm: 0, pharmacies: 2, phoenix: 2 }]) {
      assert.equal(pharmacyRecordingOf(split), "recorded", "every split's pharmacy figure is the whole count");
      for (const text of [
        formatVisitCountSplit(split),
        formatVisitCountSplit(split, { compact: true }),
        formatPharmacyFigure(split),
        formatPharmacyFigure(split, { numberFirst: true }),
        pharmacyFigureText(split),
        pharmacyValueText(split),
        pharmacyTileFigure(split).value,
        pharmacyTileFigure(split).note ?? "",
        pharmacyCellNote(split) ?? "",
      ]) {
        assert.doesNotMatch(text, retired, `no layout says the retired wording — got "${text}"`);
      }
      assert.doesNotMatch(formatVisitCountSplit(split), /\//, "never a slash");
      assert.doesNotMatch(formatVisitCountSplit(split), /…/, "never an ellipsis");
    }

    // Distinct customers are judged by the visits they were counted from — still accepted, and it no
    // longer changes the answer, so no caller had to be edited.
    const customers: VisitCountSplit = { am: 4, pm: 10, pharmacies: 0 };
    assert.equal(formatVisitCountSplit(customers, { fromVisits: phoenixOnly }), "AM 4 · PM 10 · Pharmacies 0");
    assert.equal(formatVisitCountSplit({ am: 4, pm: 10, pharmacies: 1 }, { fromVisits: both }), "AM 4 · PM 10 · Pharmacies 1");
    assert.equal(formatVisitCountSplit(customers, { fromVisits: vendorOnly }), "AM 4 · PM 10 · Pharmacies 0");

    // The figure, in every other layout.
    assert.equal(formatPharmacyFigure(phoenixWithPharmacies), "Pharmacies 3");
    assert.equal(formatPharmacyFigure(both, { numberFirst: true }), "2 Pharmacies");
    assert.equal(formatPharmacyFigure(vendorOnly, { numberFirst: true, formatNumber: (n) => n.toLocaleString("en-US") }), "2 Pharmacies");
    assert.equal(formatPharmacyFigure(phoenixWithPharmacies, { label: "pharmacies", numberFirst: true }), "3 pharmacies");
    assert.equal(pharmacyFigureText(phoenixWithPharmacies), "3");
    assert.equal(pharmacyValueText(phoenixWithPharmacies), "3");
    assert.equal(pharmacyValueText(both), "2");
    assert.equal(pharmacyValueText(vendorOnly), "2");
    assert.deepEqual(pharmacyTileFigure(phoenixWithPharmacies), { note: null, value: "3" });
    assert.deepEqual(pharmacyTileFigure(both), { note: null, value: "2" });
    assert.deepEqual(pharmacyTileFigure(vendorOnly), { note: null, value: "2" });

    // A WORKBOOK CELL IS THE COUNT AGAIN — never blank, and with no note to explain a blank.
    assert.equal(pharmacyCellValue(phoenixOnly), 0, "0 calls is 0, not a blank cell");
    assert.equal(pharmacyCellValue(phoenixWithPharmacies), 3);
    assert.equal(pharmacyCellValue(both), 2);
    assert.equal(pharmacyCellValue(vendorOnly), 2);
    for (const split of [phoenixOnly, phoenixWithPharmacies, both, vendorOnly]) {
      assert.equal(pharmacyCellNote(split), null, "no cell carries a note any more, so no footnote is added either");
    }
  }

  // ── the private calendar: a double visit record carries the mark into the summary ──
  {
    const summary = summarizePrivateCalendarVisits([
      { activityKind: "double_regular", source: "double_visit", visitRecords: [{ bucket: "PM", id: "p1", phoenix: true }] },
      { activityKind: "single_regular", source: "field_visit", visitCounts: { am: 1, pm: 3, pharmacies: 0, phoenix: 4 } },
    ]);
    assert.deepEqual(summary.all, { am: 1, pm: 4, pharmacies: 0, phoenix: 5 });
    assert.equal(formatVisitCountSplit(summary.all), "AM 1 · PM 4 · Pharmacies 0", "the key figures and the team snapshot print the count");
  }

  // ── Employee 360: the summary counts its Phoenix visits; the page prints through the helper ──
  {
    const row = (extra: Partial<VisitRow>): VisitRow => ({
      ampm: "PM",
      comment: null,
      contact_crm_id: 1,
      contact_name: null,
      customer_name: null,
      double_crm_id: null,
      double_hr_id: null,
      double_name: null,
      visit_date: "2026-10-04",
      visit_type: 0,
      visit_type_description: "Regular Visit",
      ...extra,
    });
    const summary = summarizeVisits(
      [row({ ampm: "AM", source: "phoenix" }), row({ ampm: "PM", source: "phoenix" }), row({ ampm: "PM", source: "phoenix" })],
      { from: "2026-10-01", label: "October", to: "2026-10-31" },
    );
    assert.deepEqual(
      { am: summary.amVisits, pharmacies: summary.pharmacyVisits, phoenix: summary.phoenixVisits, pm: summary.pmVisits },
      { am: 1, pharmacies: 0, phoenix: 3, pm: 2 },
      "the figures are untouched; the summary only learns which of them Phoenix CRM gave",
    );
    const vendor = summarizeVisits([row({ ampm: "PM", source: "ireports360" })], { from: "2026-09-01", label: "September", to: "2026-09-30" });
    assert.equal(vendor.phoenixVisits, 0);
  }

  // ── Field activity: a Phoenix CRM day reads "not recorded", the period total too ──
  {
    const fieldVisit = (extra: Partial<FieldActivityVisitRow>): FieldActivityVisitRow => ({
      agentCrmId: 1397,
      agentHrId: "B-100",
      agentName: "A Medical Rep",
      ampm: "PM",
      comment: null,
      contactCrmId: 500,
      contactGrade: "A",
      contactName: "A Doctor",
      doubleHrId: null,
      doubleName: null,
      double2HrId: null,
      double2Name: null,
      savedAt: "2026-10-04 11:00:00+00",
      speciality: "Pediatrics",
      visitDate: "2026-10-04",
      visitType: 0,
      visitTypeDescription: "Regular Visit",
      ...extra,
    });
    const report = buildFieldActivityReport({
      checkins: [],
      fromIso: "2026-10-04",
      leave: [],
      punches: [],
      subject: { areaName: null, hrId: "B-100", jobTitle: "Medical Rep", lineName: "Pedia", name: "A Medical Rep", regionName: null },
      toIso: "2026-10-04",
      trips: [],
      visits: [fieldVisit({ source: "phoenix" }), fieldVisit({ ampm: "AM", contactCrmId: 501, source: "phoenix" })],
    });
    assert.deepEqual(report.days[0].counts, { am: 1, pm: 1, pharmacies: 0, phoenix: 2 });
    assert.equal(formatVisitCountSplit(report.totals.counts), "AM 1 · PM 1 · Pharmacies 0", "the period total prints the count — these two days held no pharmacy call");
    const fieldReport = readFileSync("src/lib/field-activity/report.ts", "utf8");
    // `source` was the LAST select item until the Phoenix field set was appended on 2026-10-07, so this
    // pinned the end of the string. It pins the ITEM now — the guarantee is that `source` is read, not
    // that nothing is read after it, and a pin on the tail would go red every time the list grows.
    assert.match(fieldReport, /crm_save_date, source, "/, "the read carries `source`, or no row is ever known as Phoenix CRM's");
    assert.match(fieldReport, /source: \(row\.source as string \| null\) \?\? null/);
  }

  // ── Double Visit Report: the summary metric is words, never 0, when Phoenix CRM rows are behind it ──
  {
    const reportRow = (extra: Partial<DoubleVisitReportRow>): DoubleVisitReportRow => ({
      activityDate: "2026-10-04",
      areaName: "Tanta",
      countBucket: "PM",
      daysSinceVisitedHire: null,
      doubleVisitorHrId: "DM-1",
      doubleVisitorName: "A Manager",
      doubleVisitorRole: "District Manager",
      lineName: "Pedia",
      period: "PM",
      regionName: "Delta (1)",
      visitCount: 1,
      visitedEmployeeHireDate: null,
      visitedHrId: "MR-1",
      visitedName: "A Rep",
      visitedStatus: "active_mapped",
      visitKind: "Regular",
      ...extra,
    });
    const metric = (rows: DoubleVisitReportRow[]) =>
      buildReportSummaryMetrics({ logRows: rows, neverVisitedRows: [], probationRows: [] }).find((m) => m.metric === "Pharmacy Visits")?.value;
    assert.equal(metric([reportRow({ fromPhoenix: true }), reportRow({ countBucket: "AM", fromPhoenix: true, period: "AM" })]), 0, "Phoenix rows only, no pharmacy call: a true 0");
    assert.equal(metric([reportRow({ fromPhoenix: true }), reportRow({ countBucket: "Pharmacies", visitCount: 3 })]), 3, "and beside Phoenix rows the count is the whole count");
    assert.equal(metric([reportRow({ countBucket: "Pharmacies", visitCount: 3 })]), 3, "no Phoenix row: the count, exactly as before");
  }

  // ── every consumer reads the helper's answer, never a bare figure of its own ──
  {
    const src = (file: string) => readFileSync(file, "utf8");
    const fieldVisits = src("src/lib/private-calendar/field-visits.ts");
    assert.match(fieldVisits, /comment,source|source,visit_type/, "the calendar's read carries `source`");
    assert.match(src("src/lib/private-calendar/activity-kinds.ts"), /addBucketToSplit\(summary\.all, record\.bucket, 1, record\.phoenix === true\)/);
    const exporter = src("src/lib/private-calendar/export.ts");
    assert.match(exporter, /pharmacyCellValue\(split\)/, "the calendar download leaves the cell BLANK, never 0");
    assert.doesNotMatch(exporter, /split\.am, split\.pm, split\.pharmacies\]/);
    assert.match(src("src/lib/business-review/sources/visits.ts"), /addBucketToSplit\(agent\.visitSplit, countBucket, 1, fromPhoenix\)/);
    assert.match(src("src/lib/business-review/sources/visits.ts"), /addBucketToSplit\(manager\.rideSplit, countBucket, 1, fromPhoenix\)/);
    assert.match(src("src/lib/business-review/sources/field-link.ts"), /addBucketToSplit\(entry\.fact\.split, countBucket, 1, fromPhoenix\)/);
    assert.match(src("src/lib/crm/sfe-field-analytics.ts"), /isPhoenixNativeVisitRow\(visit\)\) phoenixVisits\+\+/);
    assert.match(src("src/components/admin/ceo-phase-b.tsx"), /AM \{n\(data\.amVisits\)\} · PM \{n\(data\.pmVisits\)\} · \{pharmacyFigure\}/);
    assert.match(src("src/lib/crm/visit-workload.ts"), /double_hr_id, source, speciality, visit_date, visit_type/, "the live trip read carries `source`");
    assert.match(src("src/lib/double-visit-analytics/service.ts"), /isPhoenixNativeVisitRow\(visit\) \? \{ from_phoenix: true \}/);
    for (const [file, label] of [
      ["src/components/outstation/expense-report.tsx", "the outstation report's live evidence"],
      ["src/components/outstation/trip-workload-evidence.tsx", "the trip evidence panel"],
      ["src/lib/outstation/review-document.ts", "the outstation review PDF"],
    ] as const) {
      assert.match(src(file), /formatPharmacyFigure\(/, `${label} words its live pharmacy figure through the helper`);
    }
    for (const [file, label] of [
      ["src/components/business-review/dashboard.client.tsx", "the admin dashboard"],
      ["src/components/business-review/portal-review.client.tsx", "the portal page"],
      ["src/components/business-review/rollups.client.tsx", "the shared rollup tables"],
      ["src/lib/business-review/excel-export.ts", "the workbook"],
    ] as const) {
      assert.match(src(file), /fromVisits: (row|c)\.customerVisitSplit \?\? (row|c)\.visitSplit/, `${label} judges a customer split by the visits it came from`);
    }
  }
}
