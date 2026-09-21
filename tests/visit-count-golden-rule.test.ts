import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  addVisitToSplit,
  emptyVisitCountSplit,
  formatVisitCountSplit,
  isPharmacyVisitRow,
  visitCountBucket,
  visitCountSplitTotal,
} from "../src/lib/crm/visit-count-buckets.ts";
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
  assert.equal(privateCalendarActivityKinds.length, 11, "attendance, vacation, excuse, holiday, six visit kinds and other CRM activity");
  assert.equal(new Set(Object.values(privateCalendarActivityKindLabels)).size, 11, "every kind has a name of its own");
  assert.equal(privateCalendarItemKind({ source: "double_visit" }), "double_regular", "an item from before the kinds existed still gets a colour");

  const ui = readFileSync("src/components/employee-portal/private-calendar.tsx", "utf8");
  {
    const tonesStart = ui.indexOf("const kindTones: Record<PrivateCalendarActivityKind");
    const tonesBody = ui.slice(tonesStart, ui.indexOf("\n};\n", tonesStart));
    const swatches = [...tonesBody.matchAll(/swatch: "([^"]+)"/g)].map((match) => match[1]);
    assert.equal(swatches.length, 11, "every kind has a swatch");
    assert.equal(new Set(swatches).size, 11, `every kind wears its own colour, got ${swatches.join(", ")}`);
    const chips = [...tonesBody.matchAll(/chip: "([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(chips).size, 11, "every kind's card is distinct");
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
      { am: summary.amVisits, pharmacies: summary.pharmacyVisits, pm: summary.pmVisits, unmarked: summary.unknownAmpm },
      { am: 1, pharmacies: 2, pm: 1, unmarked: 1 },
      "Employee 360 counts a pharmacy under Pharmacies whatever period it carries, and an unmarked doctor visit stays unmarked",
    );
    const e360Service = readFileSync("src/lib/employee-360/service.ts", "utf8");
    assert.match(e360Service, /comment,source,speciality",/, "the Employee 360 read carries the contact speciality that marks a pharmacy");
    const e360View = readFileSync("src/components/employee-360/employee-360-view.tsx", "utf8");
    assert.match(e360View, /<KpiTile label="Pharmacy visits" value=\{intFmt\.format\(activity\.pharmacyVisits\)\} \/>/, "the spend panel shows pharmacy visits as their own tile");
    // Number first, the way the call rate is written (" AM · " / " PM"): "12 AM · 30 PM · 5 Pharmacies".
    assert.match(e360View, /\{intFmt\.format\(summary\.amVisits\)\} AM · \{intFmt\.format\(summary\.pmVisits\)\} PM · \{intFmt\.format\(summary\.pharmacyVisits \?\? 0\)\} Pharmacies/);
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
}
