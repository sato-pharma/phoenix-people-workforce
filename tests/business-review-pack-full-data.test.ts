import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { totalAreas } from "@/lib/business-review/canonical";
import {
  defaultSelectionFor,
  metricsForLevel,
  REVIEW_METRICS,
  type ReviewMetricId,
} from "@/lib/business-review/pack/metrics";
import { buildSalesReviewPack, sumSlices, type PackInput } from "@/lib/business-review/pack/model";
import { buildSpecialtyMix } from "@/lib/business-review/specialty-mix";
import type { AreaSummary } from "@/lib/business-review/types";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The Sales Review pack draws EVERYTHING it offers — owner, 2026-09-28.
 *
 * 🔴 WHY THIS SUITE EXISTS. The picker offered 22 metrics and the pack model drew 9. Achievement
 * excluding vacant, per product, per family, month by month, against the previous window, visits,
 * coverage and frequency, double visits, marketing against the trend and by role were all ticked by
 * default and silently produced NOTHING — no error, no empty slide, just absent. A medical rep's pack
 * came out as five sections with every field KPI missing, and nothing anywhere said so. The owner:
 * "what the fuck you're showing me three only things … show his all data … as he filters, the pack
 * is exported."
 *
 * So the first pin is structural: every metric in the catalogue must be drawn by SOME section. A
 * metric that is offered and drawn by nothing is exactly how the first ten went missing, and this
 * catches the eleventh the moment it is added to the catalogue without a builder behind it.
 */

const ROUTE = "app/api/business-review/pack/route.ts";

const slice = (sales: number, target: number, graded = sales) => ({
  ach: target !== 0 ? Math.round((graded / target) * 10000) / 100 : null,
  graded,
  sales,
  target,
});

/** A whole area, every field the new sections read — no field left for a builder to find missing. */
const area = (code: string, over: Partial<AreaSummary> = {}): PackInput["areas"][number] =>
  ({
    allProducts: slice(900, 1000),
    area: `Area ${code}`,
    areaCode: code,
    byMonth: { "2026-07": slice(400, 500), "2026-08": slice(500, 500) },
    campaignVisits: 4,
    customersAm: 3,
    customersByMonth: { "2026-07": 6, "2026-08": 8 },
    customersPharmacy: 2,
    customersPm: 7,
    customersTotal: 12,
    dm: "A District Manager",
    dmSeatId: "SEAT-DM-1",
    doubleVisits: 3,
    hasReturns: false,
    hasTarget: true,
    includeOnly: slice(900, 1000),
    marketingCommitted: 2500,
    marketingRequests: 2,
    outstationApproved: 700,
    outstationClaimed: 800,
    products: { "Product One": slice(600, 700), "Product Two": slice(300, 300) },
    region: "Cairo",
    regularVisits: 36,
    repHrIds: ["REP-1"],
    reps: 1,
    trend: [400, 500, 0],
    ungradeable: false,
    vacant: false,
    visitSplit: { am: 10, pharmacies: 8, pm: 22 },
    visits: 40,
    visitsByMonth: { "2026-07": 18, "2026-08": 22 },
    ...over,
  }) as unknown as PackInput["areas"][number];

const person = (
  name: string,
  role: string,
  over: Partial<PackInput["people"][number]> = {},
): PackInput["people"][number] =>
  ({
    activeMonths: 2,
    areaCode: "CA1",
    avgPerActiveMonth: 20,
    campaignVisits: 4,
    customers: 12,
    customersAm: 3,
    customersByMonth: { "2026-07": 6, "2026-08": 8 },
    customersPharmacy: 2,
    customersPm: 7,
    dmSeatId: "SEAT-DM-1",
    employmentStatus: "active",
    fieldVisits: 40,
    hireDate: null,
    hrId: name,
    jobTitle: role,
    lastWorkingDate: null,
    marketingRequests: 1,
    name,
    outstationClaimed: 800,
    regularVisits: 36,
    repsCoached: 0,
    ridesLed: 0,
    role,
    visitSplit: { am: 10, pharmacies: 8, pm: 22 },
    ...over,
  }) as unknown as PackInput["people"][number];

const dm = {
  allProducts: slice(1800, 2000),
  dm: "A District Manager",
  dmSeatId: "SEAT-DM-1",
  doubleVisits: 3,
  doubleVisitsLed: 3,
  familyAch: { "Family A": 88.5, "Family B": 101.2 },
  marketingCost: 5000,
  outstationCost: 1600,
  // A real list, so the specialty section has something to draw — an empty mix is correctly dropped.
  specialityMix: buildSpecialtyMix([
    { contactCrmId: 1, speciality: "Pediatrics", visits: 3 },
    { contactCrmId: 2, speciality: "Pharmacy", visits: 1 },
  ]),
} as unknown as PackInput["dms"][number];

/** Every metric can answer: two lines, a vacant area, a manager who rode, two roles, spend. */
function everything(level: PackInput["subject"]["level"], selection: readonly ReviewMetricId[]): PackInput {
  return {
    areas: [
      area("CA1", { lineLabel: "Pedia" } as never),
      area("CA2", { lineLabel: "CNS", vacant: true, dm: "Cairo (vacant)" } as never),
    ],
    concentration: null,
    coverageNote: "Every figure covers Jul – Aug 2026.",
    dms: [dm],
    generatedAt: "2026-09-28T12:00:00.000Z",
    months: ["2026-07", "2026-08"],
    people: [
      person("A Rep", "Medical Rep"),
      person("A Manager", "District Manager", { fieldVisits: 12, ridesLed: 3, repsCoached: 2 }),
    ],
    selection,
    subject: { level, line: null, title: "All company", windowLabel: "Jul – Aug 2026" },
    visitsAvailable: true,
  };
}

/**
 * The metric a section is filed under, for metrics that SHARE a section. "Sales against target" is
 * a column of the Areas table, and outstation and spend-per-point are columns of the Cost table —
 * they are drawn, just not under their own id.
 */
const DRAWN_AS: Partial<Record<ReviewMetricId, ReviewMetricId>> = {
  "outstation-claimed": "marketing-committed",
  "sales-vs-target": "achievement",
  "spend-per-point": "marketing-committed",
};
/** Drawn only from the Monthly Closing's customer-grain rows, which this fixture does not load. */
const NEEDS_DETAIL = new Set<ReviewMetricId>(["brick-spread", "customer-concentration", "channel-split"]);

export function runBusinessReviewPackFullDataTests() {
  // ------------------------------------------------------------------ 1. every offered metric is drawn
  {
    const all = REVIEW_METRICS.map((m) => m.id);
    const pack = buildSalesReviewPack(everything("company", all));
    const drawn = new Set(pack.sections.map((s) => s.metric));
    const missing = all
      .filter((id) => !NEEDS_DETAIL.has(id))
      .filter((id) => !drawn.has(DRAWN_AS[id] ?? id));
    assert.deepEqual(
      missing,
      [],
      `the catalogue offers these and NOTHING draws them — a tick that exports nothing: ${missing.join(", ")}`,
    );
  }

  // ------------------------------------------------------------------ 2. a rep's pack carries his KPIs
  {
    const repSelection = defaultSelectionFor("rep");
    const rep: PackInput = {
      ...everything("rep", repSelection),
      areas: [area("CA1")],
      dms: [], // the route withholds the district row from a rep — see block 7
      people: [person("A Rep", "Medical Rep")],
      subject: { level: "rep", line: "pedia", title: "A Rep", windowLabel: "Jul – Aug 2026" },
    };
    const titles = buildSalesReviewPack(rep).sections.map((s) => s.title);
    for (const expected of [
      "Areas",
      "Per product",
      "Month by month",
      "Against the previous window",
      "Visits",
      "Coverage and frequency",
      "Double visits — received, by area",
      "Rep by rep",
      "Unique customers per month",
      "Cost",
      "Marketing against the trend",
    ]) {
      assert.ok(titles.includes(expected), `a medical rep's pack must carry "${expected}" — it had: ${titles.join(" · ")}`);
    }
    assert.ok(titles.length >= 11, `a rep's pack came out with only ${titles.length} sections`);
  }

  // ------------------------------------------------------------------ 3. one rule for achievement
  {
    // sumSlices restates totalAreas for slices that are not whole areas. Two rules would be two
    // opinions about achievement, so on whole areas they must agree to the piastre.
    const areas = [
      area("A1", { allProducts: slice(1234.56, 1500, 1100.1) }),
      area("A2", { allProducts: slice(987.65, 800, 950.5) }),
      area("A3", { allProducts: slice(10, 0, 0) }),
    ] as unknown as AreaSummary[];
    assert.deepEqual(
      sumSlices(areas.map((a) => a.allProducts)),
      totalAreas(areas),
      "sumSlices must total by the review's own rule — graded actual over target — exactly as totalAreas does",
    );
    assert.equal(sumSlices([slice(5, 0, 0)]).ach, null, "no target is null, never 0");
  }

  // ------------------------------------------------------------------ 4. AM · PM · Pharmacies stay apart
  {
    const pack = buildSalesReviewPack(everything("district", ["visits-split"]));
    const visits = pack.sections.find((s) => s.metric === "visits-split");
    assert.ok(visits, "visits-split was ticked and drew a section");
    for (const column of ["AM", "PM", "Pharmacies"]) {
      assert.ok(visits.columns.includes(column), `"${column}" is its own column — the three figures are never merged`);
    }
    assert.ok(!visits.columns.some((c) => c.includes("/")), "never joined with a slash");
    assert.match(visits.note, /never counted inside PM or AM/, "and the golden rule travels in the file");
  }

  // ------------------------------------------------------------------ 5. direction reads the FIGURE months
  {
    // `trend` walks the REQUESTED window and ends in a held-out month's 0. Reading it would call a
    // growing area a collapse; the section must read byMonth over the months the figures answer.
    const growing = area("CA1", { byMonth: { "2026-07": slice(400, 500), "2026-08": slice(500, 500) }, trend: [400, 500, 0] });
    const pack = buildSalesReviewPack({ ...everything("district", ["marketing-vs-trend"]), areas: [growing] });
    const section = pack.sections.find((s) => s.metric === "marketing-vs-trend");
    assert.ok(section, "marketing-vs-trend drew a section");
    const direction = section.rows[0][section.rows[0].length - 1];
    assert.match(String(direction), /▲/, `an area that grew 400 → 500 reads as rising, not as the trailing 0 — got ${direction}`);
  }

  // ------------------------------------------------------------------ 6. the comparison names its basis
  {
    // At the July floor there is no equal-length window before Jul–Aug, so the honest comparison is
    // August against July — and the section must SAY which one it made.
    const pack = buildSalesReviewPack(everything("district", ["vs-previous-window"]));
    const section = pack.sections.find((s) => s.metric === "vs-previous-window");
    assert.ok(section, "vs-previous-window drew a section");
    assert.match(section.note, /Aug 2026/, "names the month being judged");
    assert.match(section.note, /Jul 2026/, "and the month it is judged against");
    assert.match(section.note, /no earlier window of the same length/, "and why it is not a whole window");
  }

  // ------------------------------------------------------------------ 7. a rep never gets a district row
  {
    const route = stripComments(readFileSync(ROUTE, "utf8")).replace(/\s+/g, " ");
    assert.ok(
      /if \(scope\.kind !== "rep"\) \{ for \(const dm of ds\.dms\)/.test(route),
      "the route must withhold the district row from a rep — it carries his manager's WHOLE district's list and money",
    );
  }

  // ------------------------------------------------------------------ 8. unions are never totalled
  {
    const pack = buildSalesReviewPack(everything("company", ["role-activity", "coverage-frequency"]));
    const roles = pack.sections.find((s) => s.metric === "role-activity");
    assert.ok(roles, "role-activity drew a section");
    assert.ok(
      !roles.columns.some((c) => /customer/i.test(c)),
      "a per-role total of customers would count one doctor seen by a rep and his manager twice",
    );
    const reach = pack.sections.find((s) => s.metric === "coverage-frequency");
    assert.ok(reach, "coverage-frequency drew a section");
    assert.ok(!reach.rows.some((row) => /total|everyone/i.test(String(row[0]))), "customers are unions — no total row");
  }

  // ------------------------------------------------------------------ 9. the picker still refuses the impossible
  {
    for (const level of ["company", "line", "district", "rep"] as const) {
      const ids = new Set(metricsForLevel(level).map((m) => m.id));
      assert.equal(ids.has("line-comparison"), level === "company", `line comparison at ${level}`);
    }
  }
}
