import assert from "node:assert/strict";

import {
  METRIC_GROUPS,
  PACK_LEVELS,
  REVIEW_METRICS,
  defaultSelectionFor,
  metricsForLevel,
  narrowSelection,
  needsClosingDetail,
  type PackLevel,
} from "@/lib/business-review/pack/metrics";

/**
 * The Sales Review pack's metric catalogue — one definition read by the picker, the PDF and the
 * workbook.
 *
 * The failure this file exists to prevent is a metric that exists in two of the three renderers:
 * a deck slide the Excel cannot explain, or a tick in the picker that exports nothing. Everything
 * below is a property of the catalogue itself, so it holds however the renderers are written.
 */
export function runBusinessReviewPackMetricsTests() {
  // ------------------------------------------------------------------ 1. shape
  {
    const ids = REVIEW_METRICS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, "metric ids must be unique — a duplicate silently wins twice");

    const groupIds = new Set(METRIC_GROUPS.map((g) => g.id));
    for (const metric of REVIEW_METRICS) {
      assert.ok(groupIds.has(metric.group), `${metric.id} sits in an unknown group "${metric.group}"`);
      assert.ok(metric.levels.length > 0, `${metric.id} can be answered at no level at all`);
      for (const level of metric.levels) {
        assert.ok(PACK_LEVELS.includes(level), `${metric.id} names an unknown level "${level}"`);
      }
      assert.ok(metric.hint.trim().length > 0, `${metric.id} has no hint — the picker would show a bare label`);
      assert.ok(!metric.label.includes("…"), `${metric.id} uses an ellipsis, which the house rules forbid`);
      assert.ok(!metric.hint.includes("…"), `${metric.id}'s hint uses an ellipsis`);
    }

    for (const group of METRIC_GROUPS) {
      assert.ok(
        REVIEW_METRICS.some((m) => m.group === group.id),
        `group "${group.id}" has no metrics, so the picker would render an empty heading`,
      );
    }
  }

  // ------------------------------------------------------------------ 2. every level can build a pack
  for (const level of PACK_LEVELS) {
    const available = metricsForLevel(level);
    assert.ok(available.length >= 5, `${level} can answer only ${available.length} metrics`);
    const defaults = defaultSelectionFor(level);
    assert.ok(defaults.length >= 4, `${level} opens with only ${defaults.length} metrics ticked`);
    for (const id of defaults) {
      assert.ok(
        available.some((m) => m.id === id),
        `${level} defaults to ${id}, which it cannot answer`,
      );
    }
  }

  // ------------------------------------------------------------------ 3. a rep is offered everything HIS scope answers
  //
  // 🔴 Owner, 2026-09-28: "show his all data … as he filters, the pack is exported." A rep used to be
  // offered a curated handful, and his pack came out as five sections with every field KPI missing.
  // He is now offered every metric his OWN territory can answer — and still nothing that needs a
  // district row, because the route gives a rep's pack none: his manager's whole district is not
  // his territory.
  {
    const repIds = new Set(metricsForLevel("rep").map((m) => m.id));
    for (const id of [
      "achievement", "sales-vs-target", "per-product", "month-by-month", "vs-previous-window",
      "brick-spread", "customer-concentration", "channel-split",
      "visits-split", "customers-per-month", "coverage-frequency", "double-visits",
      "marketing-committed", "outstation-claimed", "spend-per-point", "marketing-vs-trend",
      "rep-rows",
    ] as const) {
      assert.ok(repIds.has(id), `a rep's own territory answers ${id}, so he must be offered it`);
    }
    // Structurally unanswerable for one person's own territory — offering them would export nothing.
    assert.ok(!repIds.has("line-comparison"), "a rep has no lines to compare");
    assert.ok(!repIds.has("achievement-ex-vacant"), "a rep's own area is never vacant — he is standing in it");
    assert.ok(!repIds.has("per-family"), "the family rollup is a DISTRICT figure, and a rep's pack holds no district row");
    assert.ok(!repIds.has("specialty-mix"), "the list mix is read off the district row, which is withheld from a rep");
    assert.ok(!repIds.has("role-activity"), "a rep's pack holds one person, so there is no role to compare");
  }

  // ------------------------------------------------------------------ 4. line comparison is company only
  {
    for (const level of PACK_LEVELS) {
      const has = metricsForLevel(level).some((m) => m.id === "line-comparison");
      assert.equal(
        has,
        level === "company",
        `line-comparison offered at ${level} — it can only be answered across all three lines`,
      );
    }
  }

  // ------------------------------------------------------------------ 5. a link built higher up narrows
  {
    // A district manager handed a company-level link keeps what his district can answer and loses
    // what it cannot. Rendering an empty Line comparison would tell him his line has no data.
    const companyLink = defaultSelectionFor("company");
    const narrowed = narrowSelection(companyLink, "district");
    assert.ok(!narrowed.includes("line-comparison"), "the company-only metric is dropped, not rendered empty");
    assert.ok(narrowed.includes("achievement"), "and everything a district CAN answer survives");

    const order = metricsForLevel("district").map((m) => m.id);
    const positions = narrowed.map((id) => order.indexOf(id));
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      "a narrowed selection keeps catalogue order, so two people exporting the same metrics get the same deck",
    );

    assert.deepEqual(narrowSelection(["not-a-metric"], "company"), [], "an unknown id is dropped, never thrown");
  }

  // ------------------------------------------------------------------ 6. the heavy read is opt-in
  {
    assert.equal(
      needsClosingDetail(["achievement", "visits-split"]),
      false,
      "the ordinary pack must not pay for the customer-grain read",
    );
    assert.equal(needsClosingDetail(["achievement", "brick-spread"]), true);
    assert.equal(needsClosingDetail(["channel-split"]), true);
    assert.equal(needsClosingDetail([]), false);

    const heavy = REVIEW_METRICS.filter((m) => m.needsClosingDetail).map((m) => m.id);
    assert.deepEqual(
      heavy.sort(),
      ["brick-spread", "channel-split", "customer-concentration"],
      "exactly the three that cannot be answered from the review's own sales source",
    );
  }

  // ------------------------------------------------------------------ 7. everything offered is ticked
  //
  // 🔴 REVERSED by the owner, 2026-09-28. This block used to insist that "a pack of everything is not
  // a presentation" and that no level may tick every metric it has. His ruling is the opposite: a
  // fresh pack opens with everything the scope can answer, and the viewer unticks what he does not
  // want. The FILTER governs what the figures cover; the picker no longer curates.
  {
    for (const level of PACK_LEVELS as readonly PackLevel[]) {
      const available = metricsForLevel(level).map((m) => m.id);
      const defaults = defaultSelectionFor(level);
      assert.deepEqual(
        defaults,
        available,
        `${level} must open with every metric it can answer ticked — the owner asked for all of it`,
      );
    }
    for (const metric of REVIEW_METRICS) {
      assert.deepEqual(
        [...metric.defaultAt],
        [...metric.levels],
        `${metric.id} is offered at a level where it is not ticked by default`,
      );
    }
  }
}
