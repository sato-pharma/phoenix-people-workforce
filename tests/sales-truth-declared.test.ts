import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { reconciliationChecks } from "../src/lib/reconciliation/checks/index.ts";
import { runReconciliationCheckList } from "../src/lib/reconciliation/runner.ts";
import type { ReconciliationCheck } from "../src/lib/reconciliation/types.ts";
import {
  salesTruthMonthOutcome,
  SALES_TRUTH_LANE,
  salesTruthOwnMonths,
  salesTruthReconciliationChecks,
} from "../src/lib/reconciliation/checks/sales-truth.ts";
import {
  DECLARED_AREA_DIFFERENCES,
  DECLARED_LINE_TOTALS,
  SURFACE_VS_TARGET,
  VS_TARGET_HISTORY_START,
  classifySalesTruthReport,
} from "../src/lib/sales/sales-truth-declared.ts";
import type { SalesTruthFinding, SalesTruthReport } from "../src/lib/sales/sales-truth-reconciliation.ts";

// THE SALES TRUTH CHECK RUNS EVERY NIGHT, AND ONLY THE DECLARED DIFFERENCES ARE QUIET.
//
// Owner, 14 Nov 2026: "schedule the sales truth check with the known differences declared". The
// nightly reconciliation run now carries one check per month (src/lib/reconciliation/checks/
// sales-truth.ts). Three kinds of difference were explained on the day and are declared in
// src/lib/sales/sales-truth-declared.ts: no Sales vs Target before 2026, pre-July area moves whose line
// total agrees (and March 2026 CNS's 520.10 EGP line total), and September 2026's four Assuit rows.
// What this pins is that each declaration is as NARROW as its fact — one cent more, one other area,
// one other surface, and the check pages again.

const SOS = "Source of Sales";

function finding(partial: Partial<SalesTruthFinding> & Pick<SalesTruthFinding, "lineCode" | "areaCode" | "diff">): SalesTruthFinding {
  const closingValue = partial.closingValue ?? 10_000;
  return {
    surface: partial.surface ?? SURFACE_VS_TARGET,
    lineName: partial.lineName ?? partial.lineCode,
    areaName: partial.areaName ?? partial.areaCode,
    regionName: partial.regionName ?? "",
    closingValue,
    surfaceValue: partial.surfaceValue ?? closingValue + partial.diff,
    kind: partial.kind ?? "value-mismatch",
    ...partial,
  };
}

function report(period: string, findings: SalesTruthFinding[], unreadableLines: string[] = []): SalesTruthReport {
  const surfaces = [SURFACE_VS_TARGET, SOS].map((surface) => {
    const own = findings.filter((entry) => entry.surface === surface);
    return {
      surface,
      ok: own.length === 0,
      findings: own,
      totalAbsDiff: own.reduce((sum, entry) => sum + Math.abs(entry.diff), 0),
      netDiff: own.reduce((sum, entry) => sum + entry.diff, 0),
      closingTotal: 0,
      surfaceTotal: 0,
    };
  });
  return { period, ok: findings.length === 0 && unreadableLines.length === 0, surfaces, unreadableLines, generatedAt: "2026-11-14T02:00:00.000Z" };
}

const september = () => [
  finding({ lineCode: "cns", areaCode: "UE3", diff: 779.23 }),
  finding({ lineCode: "cns", areaCode: "UE4", diff: -779.23 }),
  finding({ lineCode: "anti_infective", areaCode: "UE3", diff: 222.3 }),
  finding({ lineCode: "anti_infective", areaCode: "UE4", diff: -222.3 }),
];

export async function runSalesTruthDeclaredTests(): Promise<void> {
  // September 2026 — exactly the four Assuit rows are quiet.
  {
    const classified = classifySalesTruthReport(report("2026-09", september()));
    assert.equal(classified.ok, true, "September's four published Assuit rows are the owner's 26 Oct decision and never page");
    assert.equal(classified.surfaces[0].declared.length, 4);

    const moved = september();
    moved[0] = finding({ lineCode: "cns", areaCode: "UE3", diff: 780.23 });
    assert.equal(classifySalesTruthReport(report("2026-09", moved)).ok, false, "one more pound on Assuit 1 is NOT the declared split");

    const extra = [...september(), finding({ lineCode: "cns", areaCode: "UE5", diff: 50 })];
    const extraClassified = classifySalesTruthReport(report("2026-09", extra));
    assert.equal(extraClassified.ok, false, "any other September area still pages");
    assert.deepEqual(extraClassified.surfaces[0].unexplained.map((entry) => entry.areaCode), ["UE5"]);

    assert.equal(
      classifySalesTruthReport(report("2026-10", september())).ok,
      false,
      "the Assuit declaration is September's alone — the same rows in October page",
    );
    assert.equal(
      classifySalesTruthReport(report("2026-09", september().map((entry) => ({ ...entry, surface: SOS })))).ok,
      false,
      "Source of Sales has no declared differences at all",
    );
  }

  // Before 2026 — only a MISSING area is expected.
  {
    const missing = finding({ lineCode: "pedia", areaCode: "CA1", diff: -2500, surfaceValue: 0, kind: "missing-on-surface" });
    assert.equal(classifySalesTruthReport(report("2025-08", [missing])).ok, true, "Sales vs Target holds nothing before January 2026");
    const printed = finding({ lineCode: "pedia", areaCode: "CA1", diff: 40 });
    assert.equal(classifySalesTruthReport(report("2025-08", [printed])).ok, false, "a value Sales vs Target DOES print for 2025 is still a finding");
  }

  // January to June 2026 — area moves are noise while the line total agrees.
  {
    const shuffle = [
      finding({ lineCode: "pedia", areaCode: "CA1", diff: 300 }),
      finding({ lineCode: "pedia", areaCode: "CA2", diff: -300 }),
    ];
    assert.equal(classifySalesTruthReport(report("2026-02", shuffle)).ok, true, "pre-July area moves with the line total intact are declared");
    assert.equal(
      classifySalesTruthReport(report("2026-07", shuffle)).ok,
      false,
      "from July areas are unified, so the same move pages",
    );
    const leaking = [...shuffle, finding({ lineCode: "pedia", areaCode: "CA3", diff: -10 })];
    assert.equal(classifySalesTruthReport(report("2026-02", leaking)).ok, false, "a pre-July line whose TOTAL moved still pages");

    const march = [
      finding({ lineCode: "cns", areaCode: "CA1", diff: 400 }),
      finding({ lineCode: "cns", areaCode: "CA2", diff: -920.1 }),
    ];
    assert.equal(classifySalesTruthReport(report("2026-03", march)).ok, true, "March 2026 CNS is declared 520.10 EGP short on the line");
    const marchMore = [...march, finding({ lineCode: "cns", areaCode: "CA3", diff: -2 })];
    assert.equal(classifySalesTruthReport(report("2026-03", marchMore)).ok, false, "two pounds beyond the declared March line total pages");

    // April and May 2026 CNS on 14 Nov 2026: 25 areas moved and their rounded differences summed to 0.02.
    const rounded = [
      finding({ lineCode: "cns", areaCode: "AW", diff: -1420.01 }),
      finding({ lineCode: "cns", areaCode: "AE", diff: 1327.08 }),
      finding({ lineCode: "cns", areaCode: "AC", diff: 92.95 }),
    ];
    assert.equal(classifySalesTruthReport(report("2026-05", rounded)).ok, true, "piastres of rounding across many areas are not a line total that moved");
    assert.equal(classifySalesTruthReport(report("2026-04", march)).ok, false, "the March line total is March's alone");
  }

  // An unreadable line is never a pass.
  assert.equal(classifySalesTruthReport(report("2026-09", september(), ["Pedia"])).ok, false, "a line the closing could not read is not compared, so the month cannot hold");

  // The declarations themselves stay as narrow as the facts on 14 Nov 2026.
  assert.equal(DECLARED_AREA_DIFFERENCES.length, 4, "September's four Assuit rows and nothing else are declared by area");
  assert.ok(DECLARED_AREA_DIFFERENCES.every((entry) => entry.period === "2026-09" && ["UE3", "UE4"].includes(entry.areaCode)));
  assert.deepEqual(
    DECLARED_LINE_TOTALS.map((entry) => [entry.period, entry.lineCode, entry.netDiff]),
    [["2026-03", "cns", -520.1]],
    "one declared line total — March 2026 CNS",
  );
  assert.match(
    readFileSync("src/lib/sales/vs-target.ts", "utf8"),
    new RegExp(`export const SALES_HISTORY_FLOOR = "${VS_TARGET_HISTORY_START}";`),
    "the 'nothing before 2026' declaration follows Sales vs Target's own history floor",
  );

  // The nightly outcome — declared rows are carried in words and never filed as findings.
  {
    const quiet = salesTruthMonthOutcome(classifySalesTruthReport(report("2026-09", september())));
    assert.equal(quiet.holds, true);
    assert.equal(quiet.findings?.length, 0, "a declared difference never becomes a System Audit finding");
    assert.match(quiet.detail, /4 known differences carried, as declared: September 2026 keeps its published Assuit 1 \/ Assuit 2 store split/);

    const loud = salesTruthMonthOutcome(
      classifySalesTruthReport(report("2026-09", [...september(), finding({ lineCode: "cns", areaCode: "UE5", areaName: "Sohag 1", lineName: "CNS", diff: 50 })])),
    );
    assert.equal(loud.holds, false, "an unexplained area pages");
    assert.equal(loud.findings?.length, 1);
    assert.equal(loud.findings?.[0].relatedId, "2026-09|Sales vs Target|cns|UE5");
    assert.equal(loud.findings?.[0].moduleHref, "/sales/truth-check?period=2026-09");
    assert.match(loud.detail, /1 area disagree with Monthly Closing and nobody has explained it: Sales vs Target CNS · Sohag 1/);
    assert.doesNotMatch(loud.detail, /…|\.\.\./, "never cut with an ellipsis");
  }

  // One check per month, from January 2026 to the Cairo month, plus the sweep of every other month.
  {
    const november = salesTruthOwnMonths(new Date("2026-11-14T02:00:00Z"));
    assert.equal(november[0], "2026-01");
    assert.equal(november.at(-1), "2026-11");
    assert.equal(november.length, 11);
    assert.equal(
      salesTruthOwnMonths(new Date("2026-11-30T22:30:00Z")).at(-1),
      "2026-12",
      "00:30 on 1 December in Cairo is December, although UTC still says November",
    );
    assert.equal(salesTruthOwnMonths(new Date("2027-01-02T10:00:00Z")).at(-1), "2027-01", "the months roll over the year");

    const ids = salesTruthReconciliationChecks.map((check) => check.id);
    assert.ok(ids.includes("sales-truth-2026-09"), "September has its own check");
    assert.equal(ids.at(-1), "sales-truth-other-months", "every closing month without its own check is still swept");
    assert.ok(salesTruthReconciliationChecks.every((check) => check.expectation === "holds" && !check.openDefect), "every sales truth check pages when it breaks");
    assert.ok(salesTruthReconciliationChecks.every((check) => check.lane === SALES_TRUTH_LANE), "every sales truth check shares the one lane");

    const all = reconciliationChecks.map((check) => check.id);
    assert.equal(new Set(all).size, all.length, "the registry holds each check once");
    assert.deepEqual(all.slice(-ids.length), ids, "the sales truth checks run last, after every payroll check");
  }

  // A lane runs its checks one at a time, and only once every other check has finished: on 14 Nov 2026
  // the months, run beside the others, pushed the two in-app notification checks past their 60 s.
  {
    let active = 0;
    const singleDone: number[] = [];
    let laneStart = Number.POSITIVE_INFINITY;
    let clockTick = 0;
    let most = 0;
    const order: string[] = [];
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const make = (id: string, lane?: string): ReconciliationCheck => ({
      id,
      title: id,
      domain: "crm-sales",
      severity: "high",
      expectation: "holds",
      lane,
      async run() {
        order.push(`start ${id}`);
        if (lane) {
          laneStart = Math.min(laneStart, clockTick++);
          active += 1;
          most = Math.max(most, active);
        }
        await tick();
        if (lane) active -= 1;
        else singleDone.push(clockTick++);
        return { left: { source: "a", value: "1" }, right: { source: "b", value: "1" }, holds: true, detail: "agrees" };
      },
    });
    const checks = [make("one"), make("two"), make("m1", "heavy"), make("m2", "heavy"), make("m3", "heavy"), make("three")];
    const ran = await runReconciliationCheckList(checks, { concurrency: 3 });
    assert.equal(most, 1, "two checks of one lane never run at the same time");
    assert.deepEqual(ran.results.map((result) => result.id), ["one", "two", "m1", "m2", "m3", "three"], "results come back in registry order");
    assert.deepEqual(
      order.slice(-3),
      ["start m1", "start m2", "start m3"],
      "the lane starts only after every other check — it never loads closings beside one",
    );
    assert.ok(singleDone.every((done) => done < laneStart), "no check without a lane is still running when the lane starts");
    assert.ok(ran.results.every((result) => result.status === "holds"));
  }
}
