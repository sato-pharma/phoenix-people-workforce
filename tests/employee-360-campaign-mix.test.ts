import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EMPLOYEE_360_BENCHMARKS } from "../src/lib/employee-360/benchmarks.ts";
import {
  campaignMixTrendOf,
  campaignMixVerdictOf,
  summarizeVisits,
  type MonthlyVisitPoint,
  type VisitRow,
} from "../src/lib/employee-360/service.ts";

// Employee 360, Campaign vs Regular — owner rule 2026-09-21: "100% regular is the best case
// scenario. If the campaign is declining and the regular is inclining, this is the best case."
// The section used to hold every rep to a 71:29 "healthy band" and called anything under 15%
// campaign "campaign-starved": Marian Samir, 91% regular with campaign falling from 100% to 1%
// over six months, read "Campaign-starved" in amber. And both campaign-share change indicators
// coloured a RISE in campaign green.

function point(month: string, regular: number, campaign: number): MonthlyVisitPoint {
  const total = regular + campaign;
  return { month, regular, campaign, campaignShare: total > 0 ? campaign / total : null, companyCampaignShare: null };
}

function visit(overrides: Partial<VisitRow>): VisitRow {
  return {
    visit_type: 0,
    visit_type_description: "Regular",
    visit_date: "2026-09-01",
    ampm: "PM",
    contact_crm_id: 1,
    contact_name: "Dr A",
    customer_name: null,
    double_crm_id: null,
    double_hr_id: null,
    double_name: null,
    comment: null,
    speciality: null,
    ...overrides,
  };
}

const WINDOW = { from: "2026-08-01", to: "2026-09-21", label: "Custom" };
const WINDOW_WITH_NOV = { from: "2026-08-01", to: "2026-11-07", label: "Custom" };

export async function runEmployee360CampaignMixTests() {
  // ── the verdict: the more regular, the better; no floor for campaign ──
  assert.equal(campaignMixVerdictOf(9, 100), "mostly_regular", "91% regular is good — never 'campaign-starved'");
  assert.equal(campaignMixVerdictOf(0, 100), "all_regular", "100% regular is the best case");
  assert.equal(campaignMixVerdictOf(1, 100), "mostly_regular");
  assert.equal(campaignMixVerdictOf(49, 100), "mostly_regular");
  assert.equal(campaignMixVerdictOf(50, 100), "campaign_heavy", "a campaign majority is the one thing flagged, as on the KPIs board");
  assert.equal(campaignMixVerdictOf(0, 0), "no_data");
  assert.ok(!("campaignShareLow" in EMPLOYEE_360_BENCHMARKS), "there is no campaign floor to fall under");
  assert.ok(!("regularShare" in EMPLOYEE_360_BENCHMARKS), "there is no 'healthy band' to be held to");

  // ── the trend: campaign falling while regular rises is the best direction ──
  const marian = campaignMixTrendOf([
    point("2026-02", 0, 33),
    point("2026-03", 60, 70),
    point("2026-04", 145, 39),
    point("2026-05", 207, 23),
    point("2026-06", 331, 7),
    point("2026-07", 389, 4),
  ]);
  assert.equal(marian?.direction, "improving", "Marian Samir: campaign 100% → 1%, the best direction");
  assert.equal(marian?.fromMonth, "2026-02");
  assert.equal(marian?.toMonth, "2026-07");
  assert.equal(marian?.fromCampaignShare, 1);

  assert.equal(campaignMixTrendOf([point("2026-07", 90, 10), point("2026-08", 60, 40)])?.direction, "worsening", "campaign rising, regular falling");
  assert.equal(campaignMixTrendOf([point("2026-07", 90, 10), point("2026-08", 88, 12)])?.direction, "steady", "a two-point move is steady");
  const held = campaignMixTrendOf([point("2026-07", 40, 0), point("2026-08", 55, 0)]);
  assert.equal(held?.direction, "steady");
  assert.equal(held?.toCampaignShare, 0, "held at all regular");
  assert.equal(campaignMixTrendOf([point("2026-08", 40, 5)]), null, "one month has no direction");
  assert.equal(
    campaignMixTrendOf([point("2026-06", 0, 0), point("2026-07", 50, 50), point("2026-08", 80, 20), point("2026-09", 0, 0)])?.direction,
    "improving",
    "months with no productive visit are skipped at both ends",
  );
  // A fragment of a month is not an end of the trend: Ragaa Mosaad's one-visit October read "Campaign rising" (55% → 100%).
  const ragaa = campaignMixTrendOf([point("2026-01", 45, 55), point("2026-09", 94, 6), point("2026-10", 0, 1)]);
  assert.equal(ragaa?.direction, "improving", "the trend ends at September, never at a one-visit October");
  assert.equal(ragaa?.toMonth, "2026-09");
  assert.equal(campaignMixTrendOf([point("2026-08", 3, 2), point("2026-09", 2, 7)]), null, "two fragments make no trend");

  // ── the summary line says it in words ──
  const allRegular = summarizeVisits(
    [
      ...Array.from({ length: 10 }, (_, i) => visit({ visit_date: `2026-08-${String(i + 1).padStart(2, "0")}`, contact_crm_id: i + 1 })),
      ...Array.from({ length: 10 }, (_, i) => visit({ visit_date: `2026-09-${String(i + 1).padStart(2, "0")}`, contact_crm_id: i + 1 })),
    ],
    WINDOW,
  );
  assert.equal(allRegular.campaignMix, "all_regular");
  assert.match(allRegular.visitsSummaryText, /100% regular \/ 0% unplanned — all regular, the best case\./);
  assert.match(allRegular.visitsSummaryText, /Held at all regular from Aug 2026 to Sep 2026\./);
  assert.doesNotMatch(allRegular.visitsSummaryText, /starved|neglect|balanced/i);

  const improving = summarizeVisits(
    [
      ...Array.from({ length: 5 }, (_, i) => visit({ visit_date: `2026-08-0${i + 1}`, visit_type: -8, visit_type_description: "Campaign" })),
      ...Array.from({ length: 5 }, (_, i) => visit({ visit_date: `2026-08-1${i}` })),
      ...Array.from({ length: 9 }, (_, i) => visit({ visit_date: `2026-09-0${i + 1}` })),
      visit({ visit_date: "2026-09-10", visit_type: -8, visit_type_description: "Campaign" }),
    ],
    WINDOW,
  );
  // 🔴 THE LANE IS UNPLANNED NOW (owner, 6 Nov 2026). Every Phoenix visit arrives as type 0, so a lane that read
  // −8 alone counted none of Phoenix's unplanned visits and called everyone "all regular" from 6 Nov.
  const phoenixUnplanned = summarizeVisits(
    [
      visit({ visit_date: "2026-09-15", visit_kind: "single", is_unplanned: true }),
      visit({ visit_date: "2026-09-16", visit_kind: "single", is_unplanned: false }),
    ],
    WINDOW,
  );
  assert.equal(phoenixUnplanned.campaignVisits, 1, "a Phoenix visit marked unplanned counts in the Unplanned lane");
  assert.equal(phoenixUnplanned.regularVisits, 1, "and a planned one stays regular");

  // The activity mix carries ONE row for the lane: an archive-day campaign visit (−8) joins Phoenix's unplanned
  // visits under "Unplanned visit" — Samah Ashraf's page read "Campaign 138" beside "Unplanned visit 98" on 7 Nov.
  const mixed = summarizeVisits(
    [
      visit({ visit_date: "2026-09-01", visit_type: -8, visit_type_description: "Campaign" }),
      visit({ visit_date: "2026-09-02", visit_type: -8, visit_type_description: "Campaign" }),
      visit({ visit_date: "2026-11-07", visit_kind: "single", is_unplanned: true }),
      visit({ visit_date: "2026-11-07", visit_kind: "single", is_unplanned: false }),
    ],
    WINDOW_WITH_NOV,
  );
  const mixRow = (label: string) => mixed.activityMix.find((item) => item.label === label);
  assert.equal(mixRow("Unplanned visit")?.count, 3, "two archive campaign visits and one Phoenix unplanned visit are one row");
  assert.equal(mixRow("Campaign"), undefined, "no separate Campaign row in the activity mix");
  assert.equal(mixRow("Regular")?.count, 1);

  assert.equal(improving.campaignMix, "mostly_regular");
  assert.equal(improving.campaignTrend?.direction, "improving");
  assert.match(improving.visitsSummaryText, /Unplanned fell from 50% to 10% \(Aug 2026 to Sep 2026\) while regular rose — the best direction\./);

  // ── on the page, a FALL in campaign share is the good direction, on both change indicators ──
  const view = readFileSync(new URL("../src/components/employee-360/employee-360-view.tsx", import.meta.url), "utf8");
  assert.match(
    view,
    /<DeltaChip label="Unplanned share" delta=\{comparison\.campaignShare\} kind="pct" goodUp=\{false\} \/>/,
    "period-over-period: campaign share going down is green",
  );
  assert.match(view, /label: "Unplanned share",[^}]*?goodUp: false,/, "before / after: campaign share going down is green");
  assert.doesNotMatch(view, /healthy band/, "no 'healthy band' on the page");
}
