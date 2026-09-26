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

  // ------------------------------------------------------------------ 3. a rep is offered only his own
  {
    const repIds = new Set(metricsForLevel("rep").map((m) => m.id));
    assert.ok(!repIds.has("line-comparison"), "a rep has no lines to compare");
    assert.ok(!repIds.has("rep-rows"), "a rep has no reps beneath him");
    assert.ok(!repIds.has("spend-per-point"), "spend is a district figure, not a rep's own");
    assert.ok(repIds.has("achievement"), "but he does have his own achievement");
    assert.ok(repIds.has("visits-split"), "and his own visits");
    assert.ok(repIds.has("specialty-mix"), "and the make-up of his own list — the question that started this");
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

  // ------------------------------------------------------------------ 7. defaults are a presentation
  {
    // A pack of everything is not a presentation. Nothing may default to every metric it has.
    for (const level of PACK_LEVELS as readonly PackLevel[]) {
      const available = metricsForLevel(level).length;
      const defaults = defaultSelectionFor(level).length;
      assert.ok(
        defaults < available,
        `${level} ticks all ${available} metrics by default — a pack of everything is not a presentation`,
      );
    }
  }
}
