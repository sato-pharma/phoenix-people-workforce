import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { maskSosCoverageReport } from "../src/lib/sales/closing-source-mask.ts";
import {
  buildSosCoverageReport,
  describeSosCoverageGaps,
  describeSosMergedSources,
  enumeratePeriods,
  MERGED_SOURCE_WINDOWS,
  mergedSourceWindowFor,
  SOURCE_ONBOARDINGS,
  sourceOnboardingFor,
  type SosCoverageBatch,
} from "../src/lib/sales/sos-coverage.ts";

// Nothing in the SoS pipeline noticed a month that was never uploaded. Production on 2026-07-31 had
// batches for 2026-01/02/03/04/06 — 2026-05 simply absent — and every trend line drew straight
// through the gap. Per-distributor gaps are subtler and cost more: January is missing EP-BK and
// EP-PHS entirely, so "January vs February" partly measures which files were uploaded.

const b = (period: string, distributorCode: string, totalValue: number): SosCoverageBatch => ({
  period,
  distributorCode,
  totalValue,
});

/** The same, with the name the batch carries — the banner must read names, never codes. */
const bn = (
  period: string,
  distributorCode: string,
  distributorName: string,
  totalValue: number,
): SosCoverageBatch => ({ period, distributorCode, distributorName, totalValue });

export function runSosDataCoverageTests() {
  // ── enumeratePeriods ────────────────────────────────────────────────────────
  assert.deepEqual(enumeratePeriods("2026-01", "2026-04"), ["2026-01", "2026-02", "2026-03", "2026-04"]);
  assert.deepEqual(enumeratePeriods("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"], "crosses the year boundary");
  assert.deepEqual(enumeratePeriods("2026-03", "2026-03"), ["2026-03"], "single month");
  assert.deepEqual(enumeratePeriods("2026-05", "2026-01"), [], "reversed range yields nothing rather than looping");
  assert.deepEqual(enumeratePeriods("nonsense", "2026-01"), [], "malformed input fails safe");
  assert.deepEqual(enumeratePeriods("2026-13", "2026-14"), [], "month 13 is not a month");

  // ── Nothing loaded ──────────────────────────────────────────────────────────
  {
    const report = buildSosCoverageReport([]);
    assert.equal(report.hasGaps, false, "no data is not the same as a gap");
    assert.deepEqual(report.loadedPeriods, []);
    assert.equal(describeSosCoverageGaps(report), null);
  }

  // ── A fully complete window reports no gaps ────────────────────────────────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 100), b("2026-01", "IS", 50),
      b("2026-02", "PS", 110), b("2026-02", "IS", 55),
    ]);
    assert.equal(report.hasGaps, false);
    assert.deepEqual(report.missingPeriods, []);
    assert.deepEqual(report.distributors, [], "no distributor has a gap");
    assert.equal(report.periods.every((p) => !p.incomplete), true);
    assert.equal(describeSosCoverageGaps(report), null);
  }

  // ── The real production shape: 2026-05 missing entirely ────────────────────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 100), b("2026-02", "PS", 100), b("2026-03", "PS", 100),
      b("2026-04", "PS", 100), b("2026-06", "PS", 100),
    ]);
    assert.deepEqual(report.loadedPeriods, ["2026-01", "2026-02", "2026-03", "2026-04", "2026-06"]);
    assert.deepEqual(report.missingPeriods, ["2026-05"], "a month with no batches at all must be named");
    assert.equal(report.hasGaps, true);
    assert.match(describeSosCoverageGaps(report) ?? "", /2026-05 was never uploaded/);
  }

  // ── A distributor missing from one month, with the value it implies ────────
  {
    // EP-BK present in Feb/Mar/Jun but absent from Jan — the real January case.
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 1000),
      b("2026-02", "PS", 1000), b("2026-02", "EP-BK", 200),
      b("2026-03", "PS", 1000), b("2026-03", "EP-BK", 400),
    ]);
    // This is the real January EP-BK case. The whole SoS history was backfilled over three days, so
    // "never uploaded for January" and "onboarded in February" are indistinguishable from the batch
    // table alone — and the costly one is the former (~3.5M EGP). The gap IS reported, with
    // firstSeen so a genuine onboarding stays explainable.
    const epbk = report.distributors.find((d) => d.distributorCode === "EP-BK");
    assert.ok(epbk, "a distributor absent from a loaded month must be reported");
    assert.deepEqual(epbk.missingPeriods, ["2026-01"], "January is reported even though Feb is its first month");
    assert.equal(epbk.firstSeen, "2026-02", "firstSeen lets the UI distinguish onboarding from a hole");
    assert.deepEqual(epbk.interiorMissingPeriods, [], "a leading gap is not an interior one");
    assert.equal(report.hasGaps, true);

    // Now it IS first seen in January, so the later gap is real.
    const report2 = buildSosCoverageReport([
      b("2026-01", "PS", 1000), b("2026-01", "EP-BK", 300),
      b("2026-02", "PS", 1000),
      b("2026-03", "PS", 1000), b("2026-03", "EP-BK", 500),
    ]);
    const epbk2 = report2.distributors.find((d) => d.distributorCode === "EP-BK");
    assert.ok(epbk2, "EP-BK must be reported");
    assert.deepEqual(epbk2.missingPeriods, ["2026-02"]);
    assert.deepEqual(
      epbk2.interiorMissingPeriods,
      ["2026-02"],
      "present in Jan and Mar, absent in Feb — no onboarding story can explain this one",
    );
    assert.equal(epbk2.averageValue, 400, "mean of the months it DID land in (300, 500)");
    assert.equal(epbk2.estimatedMissingValue, 400, "one missing month x the mean");

    const feb = report2.periods.find((p) => p.period === "2026-02");
    assert.ok(feb, "February must be reported");
    assert.equal(feb.incomplete, true, "a month missing a known distributor is not like-for-like");
    assert.deepEqual(
      feb.missingDistributors,
      [{ code: "EP-BK", name: "EP-BK" }],
      "code AND name — the name is what a reader sees, the code is the only thing the El Qema mask can match",
    );

    const jan = report2.periods.find((p) => p.period === "2026-01");
    assert.equal(jan?.incomplete, false, "a complete month is not flagged");
    assert.equal(jan?.distributorCount, 2);
    assert.equal(jan?.totalValue, 1300);
  }

  // ── A distributor first seen mid-window is reported, but marked as such ────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 100),
      b("2026-02", "PS", 100),
      b("2026-03", "PS", 100), b("2026-03", "NEW", 10),
    ]);
    const fresh = report.distributors.find((d) => d.distributorCode === "NEW");
    assert.ok(fresh, "reported, because 'never uploaded' and 'newly onboarded' look identical here");
    assert.deepEqual(fresh.missingPeriods, ["2026-01", "2026-02"]);
    assert.deepEqual(fresh.interiorMissingPeriods, [], "but flagged as leading, not an interior hole");
    assert.equal(fresh.firstSeen, "2026-03");
  }

  // ── Multiple batches for one distributor in a month are summed, not doubled ─
  {
    const report = buildSosCoverageReport([b("2026-01", "PS", 100), b("2026-01", "PS", 50)]);
    const jan = report.periods[0];
    assert.equal(jan.distributorCount, 1, "one distributor, however many batches");
    assert.equal(jan.totalValue, 150);
  }

  // ── Gaps are ranked by the value they hide ─────────────────────────────────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "BIG", 10_000), b("2026-01", "SMALL", 10),
      b("2026-02", "PS", 1),
      b("2026-03", "BIG", 10_000), b("2026-03", "SMALL", 10), b("2026-03", "PS", 1),
    ]);
    assert.equal(report.distributors[0].distributorCode, "BIG", "the costliest gap is reported first");
    assert.match(describeSosCoverageGaps(report) ?? "", /BIG is missing from 2026-02/);
    assert.match(describeSosCoverageGaps(report) ?? "", /not like-for-like/);
  }

  // ── Names, not codes, and the two Direct vintages are ONE source ───────────
  {
    // DIRECT until 2026-07, DirectReq from 2026-08 (owner, 2026-09-04). Without the fold this reads
    // "DIRECT is missing from 2026-09" about a channel that landed money that month, and the banner
    // would name a raw code at that.
    const report = buildSosCoverageReport([
      bn("2026-07", "DIRECT", "Direct (Company)", 500), bn("2026-07", "PS", "overseas", 1000),
      bn("2026-08", "DirectReq", "Direct Order Requests", 600), bn("2026-08", "PS", "overseas", 1000),
      bn("2026-09", "DirectReq", "Direct Order Requests", 700), bn("2026-09", "PS", "overseas", 1000),
    ]);
    assert.deepEqual(report.distributors, [], "one continuous Direct row, so no gap at the cutover");
    assert.equal(report.hasGaps, false);
    assert.equal(
      report.periods.every((p) => p.distributorCount === 2),
      true,
      "two sources a month, never three",
    );

    // And the name is what gets printed.
    const named = buildSosCoverageReport([
      bn("2026-01", "PS", "overseas", 1000),
      bn("2026-02", "PS", "overseas", 1000), bn("2026-02", "EP-BK", "EPDA-BULK", 5000),
      bn("2026-03", "PS", "overseas", 1000),
    ]);
    const bulk = named.distributors[0];
    assert.equal(bulk.name, "EPDA-BULK", "the batch's own name");
    assert.equal(bulk.distributorCode, "EP-BK", "the code stays on the row for the mask to match");
    assert.match(describeSosCoverageGaps(named) ?? "", /EPDA-BULK is missing from/);
    assert.equal(
      (describeSosCoverageGaps(named) ?? "").includes("EP-BK"),
      false,
      "standing rule: names, never raw codes",
    );
  }

  // ── A MERGED source's absence is not a hole ────────────────────────────────
  {
    // EPDA sent one combined pharmacies file for 2026-07 and 2026-08, so EP-BK has no batch of its
    // own there. Production valued that silence at ~24.16M EGP — the largest "hole" on the board —
    // while EP-PHS's own value jumped from 998K in June to 8.16M and 12.02M in exactly those months.
    assert.deepEqual(
      MERGED_SOURCE_WINDOWS.map((w) => `${w.code}->${w.into} ${w.from}..${w.until}`),
      ["EP-BK->EP-PHS 2026-07..2026-08"],
      "one window, and it ENDS at August",
    );
    assert.ok(mergedSourceWindowFor("EP-BK", "2026-07"), "July is inside the window");
    assert.equal(mergedSourceWindowFor("EP-BK", "2026-06"), null, "June is before it");
    assert.equal(mergedSourceWindowFor("EP-BK", "2026-09"), null, "September is after it");
    assert.equal(mergedSourceWindowFor("EP-PHS", "2026-07"), null, "the absorbing source is not merged away");

    const report = buildSosCoverageReport([
      bn("2026-06", "EP-BK", "EPDA-BULK", 4_000), bn("2026-06", "EP-PHS", "EPDA-Pharmacies", 1_000),
      bn("2026-07", "EP-PHS", "EPDA-Pharmacies", 8_000),
      bn("2026-08", "EP-PHS", "EPDA-Pharmacies", 12_000),
    ]);
    const bulk = report.distributors.find((d) => d.distributorCode === "EP-BK");
    assert.equal(bulk, undefined, "EPDA-BULK has no GAP at all — both its absences were carried");
    assert.equal(report.hasGaps, false, "a merge is not a hole, so the banner stays off");
    assert.deepEqual(
      report.mergedSources.map((s) => [s.name, s.into, s.periods]),
      [["EPDA-BULK", "EPDA-Pharmacies", ["2026-07", "2026-08"]]],
      "reported as a merge, by name, rather than silently dropped",
    );
    assert.match(
      describeSosMergedSources(report) ?? "",
      /EPDA-BULK has no file of its own for 2026-07, 2026-08 because EPDA-Pharmacies carried it/,
    );
    assert.deepEqual(
      report.periods.find((p) => p.period === "2026-07")?.missingDistributors,
      [],
      "July is complete — nothing is owed for it",
    );
    assert.equal(report.periods.find((p) => p.period === "2026-07")?.incomplete, false);
  }

  // ── The window ENDS: a September absence IS a hole ─────────────────────────
  {
    // Owner, 2026-10-09: from the September closing the bulk sector uploads on its own again, as
    // "ساتو قطاع جملة" under EP-BK, and the EPDA-BULK contribution allocation spreads it over
    // Pedia's areas. With no file there is nothing to spread, so September must still be reported.
    const report = buildSosCoverageReport([
      bn("2026-06", "EP-BK", "EPDA-BULK", 4_000), bn("2026-06", "EP-PHS", "EPDA-Pharmacies", 1_000),
      bn("2026-07", "EP-PHS", "EPDA-Pharmacies", 8_000),
      bn("2026-08", "EP-PHS", "EPDA-Pharmacies", 12_000),
      bn("2026-09", "EP-PHS", "EPDA-Pharmacies", 9_000),
    ]);
    const bulk = report.distributors.find((d) => d.distributorCode === "EP-BK");
    assert.ok(bulk, "September is past the merge, so the absence is real again");
    assert.deepEqual(bulk.missingPeriods, ["2026-09"], "ONLY September — July and August were carried");
    assert.deepEqual(bulk.mergedPeriods, ["2026-07", "2026-08"]);
    assert.equal(bulk.mergedInto, "EPDA-Pharmacies", "and who carried them, by name");
    assert.equal(
      bulk.estimatedMissingValue,
      4_000,
      "one month x its mean — the merged months are NOT priced into the estimate (the 24.16M defect)",
    );
    assert.deepEqual(
      report.periods.find((p) => p.period === "2026-09")?.missingDistributors,
      [{ code: "EP-BK", name: "EPDA-BULK" }],
      "September is the incomplete month, not July",
    );
  }

  // ── The guard: a window only excuses a month the absorbing file actually landed in ──
  {
    // If EPDA sent nothing at all in July, BOTH sources are missing and the month is a real hole.
    // Reading the window on trust would silence the larger of the two.
    const report = buildSosCoverageReport([
      bn("2026-06", "EP-BK", "EPDA-BULK", 4_000), bn("2026-06", "EP-PHS", "EPDA-Pharmacies", 1_000),
      bn("2026-07", "PS", "overseas", 1_000),
      bn("2026-08", "EP-BK", "EPDA-BULK", 4_000), bn("2026-08", "EP-PHS", "EPDA-Pharmacies", 1_000),
    ]);
    const bulk = report.distributors.find((d) => d.distributorCode === "EP-BK");
    assert.ok(bulk, "nothing carried EPDA-BULK in July, so July is still a hole");
    assert.deepEqual(bulk.missingPeriods, ["2026-07"]);
    assert.deepEqual(bulk.mergedPeriods, [], "no absorbing file, no merge");
    assert.deepEqual(bulk.interiorMissingPeriods, ["2026-07"], "present either side — unambiguous");
    assert.deepEqual(report.mergedSources, []);
  }

  // ── El Qema leaves no trace on the coverage banner either ──────────────────
  {
    // 🔒 Owner, 2026-09-09. The portal SoS dashboard is gated on `sales:read`, which 13 of the 19
    // roles hold. Once EPDA-BULK's merged months stop counting, El Qema is the costliest remaining
    // gap on Pedia (~10.6M EGP on production), so the banner would have named it.
    const viewer = { role: "Medical Rep" as const, scope: "line" as const };
    const superAdmin = { role: "Super Admin" as const, scope: "company" as const };
    const report = buildSosCoverageReport([
      bn("2026-01", "PS", "overseas", 1_000),
      bn("2026-02", "PS", "overseas", 1_000), bn("2026-02", "QM", "El Qema", 9_000),
      bn("2026-03", "PS", "overseas", 1_000),
    ]);
    assert.equal(report.distributors[0].name, "El Qema", "the real report keeps the truth");

    const masked = maskSosCoverageReport(report, viewer);
    assert.equal(masked.distributors[0].name, "—", "keep the money, drop the name");
    assert.equal(masked.distributors[0].distributorCode, "—");
    assert.equal(
      masked.distributors[0].estimatedMissingValue,
      report.distributors[0].estimatedMissingValue,
      "every number is untouched — this is a mask, not an erase",
    );
    assert.deepEqual(
      masked.periods.find((p) => p.period === "2026-01")?.missingDistributors,
      [{ code: "—", name: "—" }],
      "the per-month list carries the identity too, and is masked with it",
    );
    const sentence = describeSosCoverageGaps(masked) ?? "";
    assert.equal(sentence.includes("El Qema"), false, "no trace in the banner sentence");
    assert.equal(sentence.includes("QM"), false, "nor the code");
    assert.match(sentence, /— is missing from 2026-01, 2026-03/);
    assert.equal(
      maskSosCoverageReport(report, superAdmin),
      report,
      "Super Admin gets the same object back, untouched",
    );
    assert.match(describeSosCoverageGaps(report) ?? "", /El Qema is missing from/, "he still sees it");
  }

  // ── The mask is WIRED, ahead of the sentence that would carry the name ─────
  {
    // The banner is free text inside `insights` — it cannot be masked after it is written, and
    // `maskPortalSosDashboard` never saw it. Pin the call site, not just the function.
    const dashboard = readFileSync(
      path.resolve(import.meta.dirname, "../src/lib/sales/sos-dashboard.ts"),
      "utf8",
    );
    assert.ok(
      dashboard.includes("coverage: coverage ? maskSosCoverageReport(coverage, accessContext) : coverage"),
      "buildInsights must receive the MASKED coverage report",
    );
    assert.ok(
      dashboard.includes('.select("period,distributor_code,distributor_name,total_value")'),
      "the batch NAME must be in the select itself, or the banner falls back to raw codes",
    );
  }

  // ── A source that did not EXIST yet has no gap to close ────────────────────
  {
    // El Qema was onboarded in September 2026 for its August book: master row created 2026-09-06,
    // first batch 2026-09-07, and no row of any status outside 2026-08 and 2026-09. The seven
    // earlier months were priced at roughly 10.54M EGP of "missing" sales nobody can ever upload —
    // the third-largest hole on the board, and it also inflated the "N other distributors have
    // gaps too" count behind it.
    assert.deepEqual(
      SOURCE_ONBOARDINGS.map((o) => `${o.code} ${o.from}`),
      ["QM 2026-08", "EZB 2026-10"],
      "the declaration this repo ships — a new one belongs here, never inferred from first appearance",
    );
    assert.equal(sourceOnboardingFor("qm")?.from, "2026-08", "codes are compared folded");
    assert.equal(sourceOnboardingFor("ezb")?.from, "2026-10", "El Ezaby's first book is October 2026");
    assert.equal(sourceOnboardingFor("EP-PHS"), null, "nothing else is declared");

    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
    const report = buildSosCoverageReport([
      ...months.map((p) => bn(p, "PS", "overseas", 1_000)),
      bn("2026-08", "PS", "overseas", 1_000), bn("2026-08", "QM", "El Qema", 1_888_898),
      bn("2026-09", "PS", "overseas", 1_000), bn("2026-09", "QM", "El Qema", 1_122_930),
    ]);
    assert.equal(
      report.distributors.find((d) => d.name === "El Qema"),
      undefined,
      "a source with no month before it existed has NO gap, so it leaves the ranked list entirely",
    );
    assert.equal(report.hasGaps, false, "and the window is clean — nothing is missing at all");
    assert.equal(describeSosCoverageGaps(report), null, "so there is no banner to dismiss");
    for (const period of months) {
      assert.deepEqual(
        report.periods.find((p) => p.period === period)?.missingDistributors,
        [],
        `${period} must not name a source that did not exist yet`,
      );
      assert.equal(report.periods.find((p) => p.period === period)?.incomplete, false);
    }
  }

  // ── The excluded months are REPORTED beside a real gap, not silently dropped ─
  {
    // Same onboarding, but September's file never came — that absence IS a hole.
    const report = buildSosCoverageReport([
      ...["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]
        .map((p) => bn(p, "PS", "overseas", 1_000)),
      bn("2026-08", "QM", "El Qema", 2_000_000),
    ]);
    const qm = report.distributors.find((d) => d.name === "El Qema");
    assert.ok(qm, "a real gap after onboarding is still reported");
    assert.deepEqual(qm.missingPeriods, ["2026-09"], "only the month it genuinely owes");
    assert.equal(qm.onboardedAt, "2026-08");
    assert.deepEqual(
      qm.preOnboardingPeriods,
      ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"],
      "the excluded months are visible, so the quiet stretch is explainable",
    );
    assert.equal(qm.estimatedMissingValue, 2_000_000, "one owed month x the mean, not eight");
    assert.deepEqual(
      report.periods.find((p) => p.period === "2026-09")?.missingDistributors,
      [{ code: "QM", name: "El Qema" }],
      "September names it; the seven months before do not",
    );
  }

  // ── The DATA outvotes a stale declaration ──────────────────────────────────
  {
    // An upload before the declared first month means the line in this file is wrong, and the safe
    // reading is the strict one — expect it everywhere, so a real hole cannot hide behind it. This
    // is also what keeps the El Qema mask test above exercising a genuine gap.
    const report = buildSosCoverageReport([
      bn("2026-01", "PS", "overseas", 1_000), bn("2026-01", "QM", "El Qema", 500),
      bn("2026-02", "PS", "overseas", 1_000),
      bn("2026-03", "PS", "overseas", 1_000), bn("2026-03", "QM", "El Qema", 700),
    ]);
    const qm = report.distributors.find((d) => d.name === "El Qema");
    assert.ok(qm, "the declaration is withdrawn, so the gap is reported");
    assert.deepEqual(qm.missingPeriods, ["2026-02"]);
    assert.deepEqual(qm.interiorMissingPeriods, ["2026-02"], "and it is an interior hole");
    assert.equal(qm.onboardedAt, null, "the withdrawal is visible, not silent");
    assert.deepEqual(qm.preOnboardingPeriods, []);
  }

  // ── Malformed rows are ignored rather than corrupting the report ───────────
  {
    const report = buildSosCoverageReport([
      b("2026-01", "PS", 100),
      { period: "", distributorCode: "PS", totalValue: 5 },
      { period: "2026-02", distributorCode: "   ", totalValue: 5 },
      { period: "2026-1", distributorCode: "PS", totalValue: 5 },
    ]);
    assert.deepEqual(report.loadedPeriods, ["2026-01"], "only well-formed periods count");
  }
}
