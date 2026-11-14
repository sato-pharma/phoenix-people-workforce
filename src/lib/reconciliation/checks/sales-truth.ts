import { formatCount, formatList, formatMoney } from "@/lib/reconciliation/compare";
import type { ReconciliationCheck, ReconciliationFinding, ReconciliationOutcome } from "@/lib/reconciliation/types";
import { currentCairoDateParts } from "@/lib/i18n/format";
import {
  classifySalesTruthReport,
  type ClassifiedSalesTruthReport,
} from "@/lib/sales/sales-truth-declared";
import type { SalesTruthFinding } from "@/lib/sales/sales-truth-reconciliation";
import {
  listSalesTruthMonths,
  loadSalesTruthReportForMonth,
} from "@/lib/sales/sales-truth-report";

// ─────────────────────────────────────────────────────────────────────────────
// THE SALES TRUTH CHECK, EVERY NIGHT (owner, 14 Nov 2026: "schedule the sales truth check with the
// known differences declared").
//
// Monthly Closing is the only sales truth. sales-truth-report.ts measures Sales vs Target and Source of
// Sales against it, area by area, in money. Until this file it ran only when someone opened
// /sales/truth-check or ran scripts/check-sales-truth.ts. Now the nightly reconciliation run carries it,
// so a difference reaches the owner through the one System Audit message he already reads — no new
// recipient, no new scheduler entry.
//
// ONE CHECK PER MONTH, because one month costs three closing loads per line (10-14 s measured from
// the laptop on 14 Nov 2026) and the runner abandons a check after 60 s. They share one lane, so they
// never load closings side by side, and the lane runs only after every other check has finished. Twelve months in one check
// would never finish. A month's check keeps its id for ever (`sales-truth-2026-09`), so a difference is
// filed against the month it is about, night after night.
//
// The months are January 2026 to the Cairo month this server started in. Every OTHER month that has a
// closing — 2025-08 today, or a new month while a server started last month is still running — is
// swept by `sales-truth-other-months`, so no closing month is ever left out.
//
// The differences in sales-truth-declared.ts are reported in the detail and never page anyone;
// anything else does. Widening a declaration to quiet a red check is not a fix.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One lane, so the months run one after another, after every other check has finished (types.ts, `lane`;
 * owner, 14 Nov 2026). On the first night, run beside them, they pushed the two in-app notification
 * checks past their 60 s. Three months at once took 25-60 s each from the laptop, October past the
 * 60 s limit; one at a time they take 10-14 s.
 */
export const SALES_TRUTH_LANE = "sales-truth";

/** The first month with its own check: Sales vs Target's engine starts here. */
export const SALES_TRUTH_FIRST_OWN_MONTH = "2026-01";

const PAGE = "/sales/truth-check";
const FINDING_LIST_CAP = 10;

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** January 2026 through the given Cairo month, oldest first. */
export function salesTruthOwnMonths(now: Date = new Date()): string[] {
  const { year, month } = currentCairoDateParts(now);
  const last = monthKey(year, month);
  const months: string[] = [];
  let [y, m] = SALES_TRUTH_FIRST_OWN_MONTH.split("-").map(Number);
  while (monthKey(y, m) <= last) {
    months.push(monthKey(y, m));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

function describeFinding(finding: SalesTruthFinding): string {
  const where = `${finding.lineName} · ${finding.areaName}`;
  const sign = finding.diff > 0 ? "+" : "";
  if (finding.kind === "missing-on-surface") {
    return `${finding.surface} is missing ${where} (closing ${formatMoney(finding.closingValue)})`;
  }
  if (finding.kind === "absent-from-closing") {
    return `${finding.surface} shows ${where} at ${formatMoney(finding.surfaceValue)}, which the closing never booked`;
  }
  return `${finding.surface} ${where}: ${formatMoney(finding.surfaceValue)} against the closing's ${formatMoney(finding.closingValue)} (${sign}${formatMoney(finding.diff)})`;
}

function findingsOf(classified: ClassifiedSalesTruthReport): ReconciliationFinding[] {
  return classified.surfaces.flatMap((surface) =>
    surface.unexplained.map((finding) => ({
      hrId: null,
      relatedTable: "monthly closing",
      relatedId: `${classified.period}|${finding.surface}|${finding.lineCode}|${finding.areaCode}`,
      detail: `${classified.period}: ${describeFinding(finding)}.`,
      moduleHref: `${PAGE}?period=${classified.period}`,
    })),
  );
}

/**
 * The outcome for one month, from its classified report. Pure, so the test can hand it a report.
 */
export function salesTruthMonthOutcome(classified: ClassifiedSalesTruthReport): ReconciliationOutcome {
  const unexplained = classified.surfaces.flatMap((surface) => surface.unexplained);
  const declared = classified.surfaces.flatMap((surface) => surface.declared);
  const reasons = [...new Set(declared.map((finding) => finding.reason))];

  const parts: string[] = [];
  if (classified.unreadableLines.length > 0) {
    parts.push(
      `The closing could not be read for ${classified.unreadableLines.join(", ")}, so ${classified.unreadableLines.length === 1 ? "that line was" : "those lines were"} not compared.`,
    );
  }
  if (unexplained.length > 0) {
    parts.push(
      `${formatCount(unexplained.length, "area")} disagree with Monthly Closing and nobody has explained ${unexplained.length === 1 ? "it" : "them"}: ${formatList(unexplained.map(describeFinding), FINDING_LIST_CAP)}.`,
    );
  }
  if (declared.length > 0) {
    parts.push(`${formatCount(declared.length, "known difference")} carried, as declared: ${reasons.join("; ")}.`);
  }
  if (parts.length === 0) parts.push("Every area on every surface matches Monthly Closing.");

  const surfaceValue = classified.surfaces
    .map((surface) => `${surface.surface}: ${formatCount(surface.unexplained.length, "unexplained area")}, ${formatCount(surface.declared.length, "declared")}`)
    .join(" · ");

  return {
    left: {
      source: `Monthly Closing for ${classified.period} (loadMonthlyClosingPartsWithStoreSplit, every line)`,
      value: classified.unreadableLines.length > 0 ? `unreadable for ${classified.unreadableLines.join(", ")}` : "read for every line",
    },
    right: {
      source: "Sales vs Target and Source of Sales, area by area (sales-truth-report.ts)",
      value: surfaceValue || "no surface compared",
    },
    holds: classified.ok,
    detail: parts.join(" "),
    findings: findingsOf(classified),
  };
}

function monthCheck(period: string): ReconciliationCheck {
  return {
    id: `sales-truth-${period}`,
    title: `${period}: Sales vs Target and Source of Sales match Monthly Closing in every area`,
    domain: "crm-sales",
    severity: "high",
    expectation: "holds",
    lane: SALES_TRUTH_LANE,
    async run(): Promise<ReconciliationOutcome> {
      const report = await loadSalesTruthReportForMonth(period);
      if (!report) {
        return {
          left: { source: `Monthly Closing for ${period}`, value: "no closing for this month yet" },
          right: { source: "Sales vs Target and Source of Sales", value: "not compared" },
          holds: true,
          detail: `${period} has no closing yet, so there is nothing to compare.`,
        };
      }
      return salesTruthMonthOutcome(classifySalesTruthReport(report));
    },
  };
}

/** Every closing month without a check of its own, one after another. */
const otherMonthsCheck = (ownMonths: readonly string[]): ReconciliationCheck => ({
  id: "sales-truth-other-months",
  title: "Every other closing month: Sales vs Target and Source of Sales match Monthly Closing in every area",
  domain: "crm-sales",
  severity: "high",
  expectation: "holds",
  lane: SALES_TRUTH_LANE,
  async run(): Promise<ReconciliationOutcome> {
    const own = new Set(ownMonths);
    const months = (await listSalesTruthMonths()).filter((period) => !own.has(period)).sort();
    if (months.length === 0) {
      return {
        left: { source: "Monthly Closing months", value: "none outside the monthly checks" },
        right: { source: "Sales vs Target and Source of Sales", value: "not compared" },
        holds: true,
        detail: "Every closing month has a check of its own.",
      };
    }
    const outcomes: Array<{ period: string; outcome: ReconciliationOutcome }> = [];
    for (const period of months) {
      const report = await loadSalesTruthReportForMonth(period);
      if (report) outcomes.push({ period, outcome: salesTruthMonthOutcome(classifySalesTruthReport(report)) });
    }
    return {
      left: { source: "Monthly Closing", value: `months ${months.join(", ")}` },
      right: {
        source: "Sales vs Target and Source of Sales, area by area (sales-truth-report.ts)",
        value: outcomes.map(({ period, outcome }) => `${period}: ${outcome.holds ? "agrees" : "DIFFERS"}`).join(" · "),
      },
      holds: outcomes.every(({ outcome }) => outcome.holds),
      detail: outcomes.map(({ period, outcome }) => `${period} — ${outcome.detail}`).join(" "),
      findings: outcomes.flatMap(({ outcome }) => outcome.findings ?? []),
    };
  },
});

const ownMonths = salesTruthOwnMonths();

/**
 * Newest month first, so that if a night's run ever reaches its overall time budget it is the oldest,
 * long-settled months that wait for tomorrow. The lane runs once every other check is done (runner.ts).
 */
export const salesTruthReconciliationChecks: ReconciliationCheck[] = [
  ...[...ownMonths].reverse().map(monthCheck),
  otherMonthsCheck(ownMonths),
];
