import assert from "node:assert/strict";

import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import type { SpotlightOrgIndex } from "../src/lib/spotlight/org.ts";
import type { OrgPerson, OrgSeat } from "../src/lib/spotlight/rank.ts";
import { hrKey } from "../src/lib/spotlight/rank.ts";
import { repSpotlightDocumentHtml } from "../src/lib/spotlight/pdf.ts";
import { repSpotlightPresets } from "../src/lib/spotlight/rep-period-presets.ts";
import {
  RepSpotlightError,
  loadRepSpotlight,
  monthsBetween,
  parseRepSpotlightRange,
} from "../src/lib/spotlight/rep-self.ts";

// Spotlight (self) — a medical rep looking only at himself.
//
// The owner's two rules (2026-09-30) are pinned here, because both fail SILENTLY if they drift:
//
//   1. ANY PERIOD, but only PUBLISHED months count. A month whose closing is not published is left
//      out, and the achievement is measured over what remains — never a live, unclosed figure.
//   2. THE SHEET IS GATED AT 90%. Below it, `eligible` is false and the pic/PDF must not render.
//
// Plus the boundary that makes it safe to expose to a rep at all: the number is HIS, computed with
// the closing's own graded-over-target rule, and nobody else's row ever reaches the result.

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REP = "B-500";
const DM = "B-700";

function seat(overrides: Partial<OrgSeat> & { seatId: string; tier: string }): OrgSeat {
  return {
    parentSeatId: null,
    lineCode: "cns",
    lineName: "CNS",
    regionCode: "GZ",
    regionName: "Giza",
    areaCode: "GZ5",
    areaName: "Giza 5",
    occupantHrId: null,
    isVacant: true,
    displayLabel: overrides.seatId,
    ...overrides,
  };
}

function person(hrId: string, fullName: string): OrgPerson {
  return { hrId, fullName, nameAr: null, jobTitle: "Medical Representative" };
}

/**
 * An org with one CNS rep seat held by REP, a second rep seat held by someone else, and the DISTRICT
 * seat above both — so a DM's own sheet can be measured as the sum of the two reps beneath him.
 */
function org(): SpotlightOrgIndex {
  const seats = new Map<string, OrgSeat>([
    ["SEAT-CNS-DM-GZ", seat({ seatId: "SEAT-CNS-DM-GZ", tier: "DM", areaCode: null, areaName: null, occupantHrId: DM, isVacant: false })],
    ["SEAT-CNS-REP-GZ5", seat({ seatId: "SEAT-CNS-REP-GZ5", tier: "REP", parentSeatId: "SEAT-CNS-DM-GZ", occupantHrId: REP, isVacant: false })],
    ["SEAT-CNS-REP-GZ6", seat({ seatId: "SEAT-CNS-REP-GZ6", tier: "REP", parentSeatId: "SEAT-CNS-DM-GZ", areaCode: "GZ6", areaName: "Giza 6", occupantHrId: "B-999", isVacant: false })],
  ]);
  const people = new Map<string, OrgPerson>([
    [hrKey(REP), person(REP, "Test Rep")],
    [hrKey("B-999"), person("B-999", "Other Rep")],
    [hrKey(DM), person(DM, "Test District Manager")],
  ]);
  return {
    seats,
    people,
    lineNames: new Map([["cns", "CNS"]]),
    regionNames: new Map([["GZ", "Giza"]]),
    areaNames: new Map([["GZ5", "Giza 5"], ["GZ6", "Giza 6"]]),
  };
}

function achievementRow(overrides: Partial<AchievementRow> & { period: string }): AchievementRow {
  return {
    lineCode: "cns",
    regionCode: "GZ",
    areaCode: "GZ5",
    areaState: null,
    isOther: false,
    repSeatId: "SEAT-CNS-REP-GZ5",
    repHrId: REP,
    dmSeatId: "SEAT-CNS-DM-GZ",
    dmHrId: "B-117",
    productCode: "P1",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: true,
    ...overrides,
  };
}

/** REP delivers `actual` against `target` in `period`; a second rep is in the same feed to prove isolation. */
function periodRows(period: string, actual: number, target: number): AchievementRow[] {
  return [
    achievementRow({ period, actualValue: actual, targetValue: target, hasTarget: target > 0 }),
    // Another rep's row, in the same period, that must NEVER reach REP's result.
    achievementRow({
      period,
      repSeatId: "SEAT-CNS-REP-GZ6",
      repHrId: "B-999",
      areaCode: "GZ6",
      actualValue: 9_999_999,
      targetValue: 1,
      hasTarget: true,
    }),
  ];
}

type Deps = Parameters<typeof loadRepSpotlight>[2];

function deps(published: string[], byPeriod: Record<string, AchievementRow[]>): Deps {
  return {
    loadOrg: async () => org(),
    loadPublished: async () => new Set(published),
    loadPeriod: async (period: string) => byPeriod[period] ?? [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

export async function runSpotlightRepSelfTests(): Promise<void> {
  // 1. The range covers exactly the months asked for, inclusive.
  assert.deepEqual(monthsBetween("2026-03", "2026-07"), ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
  assert.deepEqual(monthsBetween("2026-08", "2026-08"), ["2026-08"]);
  assert.deepEqual(monthsBetween("2025-11", "2026-01"), ["2025-11", "2025-12", "2026-01"]);

  // 2. The parser is strict — a reversed, malformed, pre-floor or over-long range is refused.
  assert.throws(() => parseRepSpotlightRange({ from: "2026-08", to: "2026-07" }), RepSpotlightError);
  assert.throws(() => parseRepSpotlightRange({ from: "2026-13", to: "2026-13" }), RepSpotlightError);
  assert.throws(() => parseRepSpotlightRange({ from: "2025-12", to: "2026-01" }), RepSpotlightError);
  assert.throws(() => parseRepSpotlightRange({ from: "2026-01", to: "2027-02" }), RepSpotlightError);
  assert.deepEqual(parseRepSpotlightRange({ from: "2026-07", to: "2026-08" }), { from: "2026-07", to: "2026-08" });

  // 3. At or above 90% over the published months, the sheet is eligible — and the percentage is the
  //    closing's own graded/target summed across months (190/200 = 95%), never the mean of 100% and 90%.
  {
    const spotlight = await loadRepSpotlight(
      REP,
      { from: "2026-07", to: "2026-08" },
      deps(["cns|2026-07", "cns|2026-08"], {
        "2026-07": periodRows("2026-07", 100, 100),
        "2026-08": periodRows("2026-08", 90, 100),
      }),
    );
    assert.equal(spotlight.eligible, true);
    assert.ok(spotlight.achievement !== null && Math.abs(spotlight.achievement - 95) < 1e-9);
    assert.equal(spotlight.reason, null);
    assert.ok(spotlight.result);
    // Isolation: only REP's row is in the result, never the 9,999,999 other rep.
    assert.equal(spotlight.result!.rows.length, 1);
    assert.equal(spotlight.result!.rows[0]!.hrId, REP);
    assert.equal(spotlight.result!.rows[0]!.actualValue, 190);
  }

  // 4. Below 90%, the sheet is refused with a reason and NO eligibility — the gate the pic/PDF trusts.
  {
    const spotlight = await loadRepSpotlight(
      REP,
      { from: "2026-08", to: "2026-08" },
      deps(["cns|2026-08"], { "2026-08": periodRows("2026-08", 80, 100) }),
    );
    assert.equal(spotlight.eligible, false);
    assert.ok(spotlight.achievement !== null && Math.abs(spotlight.achievement - 80) < 1e-9);
    assert.match(spotlight.reason ?? "", /90%/);
  }

  // 5. Unpublished months are left out, and measured over what remains. Requesting Jun–Aug with only
  //    Jul and Aug published measures over Jul+Aug and reports June as pending.
  {
    const spotlight = await loadRepSpotlight(
      REP,
      { from: "2026-06", to: "2026-08" },
      deps(["cns|2026-07", "cns|2026-08"], {
        "2026-06": periodRows("2026-06", 0, 100), // published set excludes it, so it must not count
        "2026-07": periodRows("2026-07", 100, 100),
        "2026-08": periodRows("2026-08", 95, 100),
      }),
    );
    assert.deepEqual(spotlight.publishedPeriods, ["2026-07", "2026-08"]);
    assert.ok(spotlight.pendingPeriods.includes("2026-06"));
    // 195/200 = 97.5%, June's zero excluded.
    assert.ok(spotlight.achievement !== null && Math.abs(spotlight.achievement - 97.5) < 1e-9);
    assert.equal(spotlight.eligible, true);
  }

  // 6. No published month in the range → nothing to measure, refused with the published reason.
  {
    const spotlight = await loadRepSpotlight(
      REP,
      { from: "2026-08", to: "2026-08" },
      deps([], { "2026-08": periodRows("2026-08", 100, 100) }),
    );
    assert.equal(spotlight.eligible, false);
    assert.equal(spotlight.result, null);
    assert.match(spotlight.reason ?? "", /published/i);
  }

  // 7. A published month the rep sold in but was never targeted → achievement null, not zero, refused.
  {
    const spotlight = await loadRepSpotlight(
      REP,
      { from: "2026-07", to: "2026-07" },
      deps(["cns|2026-07"], { "2026-07": [achievementRow({ period: "2026-07", actualValue: 5000, targetValue: null, hasTarget: false })] }),
    );
    assert.equal(spotlight.achievement, null);
    assert.equal(spotlight.eligible, false);
    assert.match(spotlight.reason ?? "", /target/i);
  }

  // 8. A person with no REP seat is refused outright — this view is for medical representatives.
  await assert.rejects(
    () => loadRepSpotlight("B-000", { from: "2026-07", to: "2026-07" }, deps(["cns|2026-07"], { "2026-07": periodRows("2026-07", 100, 100) })),
    RepSpotlightError,
  );

  // 9. The sheet HTML names the rep and prints his achievement — the emitted artifact, not the source.
  {
    const spotlight = await loadRepSpotlight(
      REP,
      { from: "2026-07", to: "2026-08" },
      deps(["cns|2026-07", "cns|2026-08"], {
        "2026-07": periodRows("2026-07", 100, 100),
        "2026-08": periodRows("2026-08", 90, 100),
      }),
    );
    const html = repSpotlightDocumentHtml(spotlight.result!);
    assert.match(html, /Test Rep/);
    assert.match(html, /95\.0/);
    assert.match(html, /Achievement/);
    // No peer ranking language on a rep's own sheet.
    assert.doesNotMatch(html, /ranked|out of \d/i);
  }

  // 10. A DISTRICT MANAGER is measured as his DISTRICT — the reps beneath his seat, summed, exactly
  //     as the Monthly Closing grades him. Two reps at 900/1000 and 1100/1000 make the district
  //     2000/2000 = 100%, which no single rep's own figure equals.
  {
    const districtRows = (period: string) => [
      achievementRow({ period, actualValue: 900, targetValue: 1000, hasTarget: true }),
      achievementRow({
        period,
        repSeatId: "SEAT-CNS-REP-GZ6",
        repHrId: "B-999",
        areaCode: "GZ6",
        actualValue: 1100,
        targetValue: 1000,
        hasTarget: true,
      }),
    ];
    const spotlight = await loadRepSpotlight(
      DM,
      { from: "2026-07", to: "2026-07" },
      deps(["cns|2026-07"], { "2026-07": districtRows("2026-07") }),
    );
    assert.equal(spotlight.eligible, true);
    assert.ok(spotlight.achievement !== null && Math.abs(spotlight.achievement - 100) < 1e-9);
    assert.equal(spotlight.result!.rows.length, 1);
    assert.equal(spotlight.result!.rows[0]!.hrId, DM);
    // The district's money, not one rep's.
    assert.equal(spotlight.result!.rows[0]!.actualValue, 2000);
    assert.equal(spotlight.result!.selection.subject, "dm");

    const html = repSpotlightDocumentHtml(spotlight.result!);
    assert.match(html, /Test District Manager/);
    // His own district only — never the rep names beneath him.
    assert.doesNotMatch(html, /Test Rep|Other Rep/);
  }

  // 11. The same 90% floor applies to a district manager — below it the sheet is refused.
  {
    const spotlight = await loadRepSpotlight(
      DM,
      { from: "2026-07", to: "2026-07" },
      deps(["cns|2026-07"], {
        "2026-07": [achievementRow({ period: "2026-07", actualValue: 800, targetValue: 1000, hasTarget: true })],
      }),
    );
    assert.equal(spotlight.eligible, false);
    assert.match(spotlight.reason ?? "", /90%/);
  }

  // ── 12. THE QUICK PICKS LAND ON MONTHS THAT HAVE FIGURES ─────────────────────────────────────
  // A closing is never released during the month it covers, so the newest measurable month is always
  // behind the calendar. The picks used to be anchored on the newest SELECTABLE month, which made the
  // first and most prominent one a guaranteed dead end. Production on 2026-10-03: the picker offered
  // 2026-01 … 2026-10 while only 2026-07 and 2026-08 were published — "This month" asked for October
  // and "Last 2 months" for September–October, and both came back "none of these months has a
  // published closing yet". Reproduced exactly here.
  {
    const offered = [
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05",
      "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
    ];
    const published = new Set(["2026-07", "2026-08"]);
    const presets = repSpotlightPresets(offered, "2026-08");

    assert.deepEqual(
      presets.find((preset) => preset.label === "This month")?.range,
      ["2026-08", "2026-08"],
      "\"This month\" is the newest month that HAS a published closing, not the calendar month",
    );
    assert.deepEqual(
      presets.find((preset) => preset.label === "Last 2 months")?.range,
      ["2026-07", "2026-08"],
      "\"Last 2 months\" ends at the published month too",
    );
    // THE HEADLINE: no shortcut may hand the engine a window with nothing in it to measure.
    for (const preset of presets) {
      const [from, to] = preset.range;
      const covered = offered.filter((period) => period >= from && period <= to).some((period) => published.has(period));
      assert.equal(covered, true, `the "${preset.label}" quick pick covers at least one published month`);
      assert.ok(to <= "2026-08", `the "${preset.label}" quick pick never reaches past the latest published month`);
    }
    // The longer picks still span the unpublished months BEHIND the anchor — the owner's free-form
    // range is untouched, and `pendingPeriods` names what was left out.
    assert.deepEqual(
      presets.find((preset) => preset.label === "Last semester")?.range,
      ["2026-03", "2026-08"],
      "a six-month pick still reaches back over unpublished months, which are reported as pending",
    );

    // With nothing published the picks fall back to the newest month offered, which is the only
    // honest answer — and the engine then explains that no month is measurable.
    assert.deepEqual(
      repSpotlightPresets(offered, null).find((preset) => preset.label === "This month")?.range,
      ["2026-10", "2026-10"],
      "with no published month the picks fall back to the newest month offered",
    );
    assert.deepEqual(repSpotlightPresets([], "2026-08"), [], "no months offered means no quick picks");
    // A one-month picker offers only the single pick, never a two-month range it cannot fill.
    assert.deepEqual(
      repSpotlightPresets(["2026-08"], "2026-08").map((preset) => preset.label),
      ["This month"],
      "a single available month yields exactly one quick pick",
    );
  }
}
