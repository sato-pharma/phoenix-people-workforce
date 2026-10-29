import Link from "next/link";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import {
  UNATTRIBUTED_AREA,
  UNLINED,
  type SalesTruthFinding,
  type SalesTruthReport,
  describeSurfaceResult,
} from "@/lib/sales/sales-truth-reconciliation";

// ONE AREA, ONE NUMBER. The owner's verdict screen for "no report may ever disagree with another".
//
// GOLDEN RULE (owner, 2026-09-01): no screen may ever scroll horizontally, on a phone or on a
// desktop. So this board does NOT use PortalDesktopTable — that primitive hard-codes
// `overflow-x-auto` over a 980px floor, which is the scroll being forbidden. Desktop gets
// `table-fixed` with a colgroup so five columns share whatever width there is and cells WRAP;
// below `md` the same rows render as cards. Nothing is truncated and nothing is ellipsised.

const THEAD =
  "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-white/90 first:rounded-tl-lg last:rounded-tr-lg";
const TD = "px-3 py-2.5 align-top text-sm text-slate-700 break-words";

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Names, never codes. A sentinel bucket is explained in words instead. */
function areaLabel(finding: SalesTruthFinding): { name: string; sub: string } {
  if (finding.areaCode === UNATTRIBUTED_AREA) {
    return { name: "Not filed to any area", sub: "Sales carrying no area at all" };
  }
  return { name: finding.areaName, sub: finding.regionName || "" };
}

function lineLabel(finding: SalesTruthFinding): string {
  if (finding.lineCode === UNLINED) return "No line";
  if (finding.lineName !== finding.lineCode) return finding.lineName;
  // A code that never reached a name: title-case the underscore form rather than print it raw.
  return finding.lineCode
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** What the difference MEANS, in the owner's terms — not the enum name. */
function meaning(finding: SalesTruthFinding): string {
  // A row on NO line is not a mapping gap to be closed. Head Office products carry no sales line by
  // design and the closing correctly never books them — so this money must be filtered OUT of the
  // other report, never given a line. Saying "unmapped" here would invite exactly the wrong fix.
  if (finding.lineCode === UNLINED) {
    return "This is sales on no line at all, which Monthly Closing correctly never books — so any company total taken from this report will read high by this much.";
  }
  // The unattributed bucket is the row people read first, and "area" is the wrong word for it.
  if (finding.areaCode === UNATTRIBUTED_AREA) {
    return finding.diff > 0
      ? "The other report is holding this money with no area, while Monthly Closing has already spread it across the areas below."
      : "Monthly Closing is holding this money with no area, while the other report has already spread it across the areas below.";
  }
  if (finding.kind === "absent-from-closing") {
    return "This money is on the other report but Monthly Closing never booked it here.";
  }
  if (finding.kind === "missing-on-surface") {
    return "Monthly Closing books this area; the other report shows nothing for it.";
  }
  return finding.diff < 0
    ? "The other report is showing less than Monthly Closing for this area."
    : "The other report is showing more than Monthly Closing for this area.";
}

function FindingRow({ finding }: { finding: SalesTruthFinding }) {
  const area = areaLabel(finding);
  return (
    <tr className="bg-white align-top hover:bg-slate-50">
      <td className={TD}>
        <span className="font-medium text-slate-900">{lineLabel(finding)}</span>
      </td>
      <td className={TD}>
        {/* The region MERGED under the area's name rather than given a column of its own — the
            owner's own way of making a board fit without shrinking type. */}
        <span className="font-medium text-slate-900">{area.name}</span>
        {area.sub ? <span className="mt-0.5 block text-xs text-slate-500">{area.sub}</span> : null}
      </td>
      <td className={`${TD} tabular-nums`}>{money(finding.closingValue)}</td>
      <td className={`${TD} tabular-nums`}>{money(finding.surfaceValue)}</td>
      <td className={TD}>
        <span
          className={`font-semibold tabular-nums ${finding.diff < 0 ? "text-rose-700" : "text-amber-700"}`}
        >
          {finding.diff > 0 ? "+" : ""}
          {money(finding.diff)}
        </span>
        <span className="mt-0.5 block text-xs text-slate-500">{meaning(finding)}</span>
      </td>
    </tr>
  );
}

function FindingCard({ finding }: { finding: SalesTruthFinding }) {
  const area = areaLabel(finding);
  return (
    <div className="border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-slate-900 break-words">{area.name}</span>
        <span className="text-xs font-medium text-slate-500">{lineLabel(finding)}</span>
      </div>
      {area.sub ? <p className="mt-0.5 text-xs text-slate-500">{area.sub}</p> : null}
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">Monthly Closing</dt>
          <dd className="tabular-nums font-medium text-slate-900">{money(finding.closingValue)}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">{finding.surface}</dt>
          <dd className="tabular-nums font-medium text-slate-900">{money(finding.surfaceValue)}</dd>
        </div>
      </dl>
      <p
        className={`mt-3 text-sm font-semibold tabular-nums ${finding.diff < 0 ? "text-rose-700" : "text-amber-700"}`}
      >
        {finding.diff > 0 ? "+" : ""}
        {money(finding.diff)}
      </p>
      <p className="mt-1 text-xs text-slate-600">{meaning(finding)}</p>
    </div>
  );
}

export function SalesTruthCheckReport({
  report,
  periods,
}: {
  report: SalesTruthReport;
  periods: readonly string[];
}) {
  const failing = report.surfaces.filter((surface) => !surface.ok);

  return (
    <div className="space-y-6">
      <AdminPageHero
        badges={(
          <>
            {/* The month is named INSIDE the verdict, not merely beside it. A bare "everything
                agrees" on the running month reads as an all-clear for the whole year, and on the
                day this shipped the running month was clean while the published one was not. */}
            <AdminInsightChip tone={report.ok ? "emerald" : "orange"}>
              {report.period
                ? report.ok
                  ? `${report.period}: every report agrees with Monthly Closing`
                  : failing.length === 1
                    ? `${report.period}: 1 report disagrees with Monthly Closing`
                    : `${report.period}: ${failing.length} reports disagree with Monthly Closing`
                : "No published closing to check"}
            </AdminInsightChip>
          </>
        )}
        description="Monthly Closing is the source of truth. Every other sales report is measured against it, area by area, in money. Anything that disagrees is listed below, with the area named and the exact gap."
        eyebrow="Sales"
        icon={<ShieldCheck className="h-4 w-4" />}
        title="Sales Truth Check"
      />

      {periods.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Month</span>
          {periods.slice(0, 12).map((period) => (
            <Link
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                period === report.period
                  ? "bg-slate-900 text-white"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
              href={`/sales/truth-check?period=${period}`}
              key={period}
            >
              {period}
            </Link>
          ))}
          <span className="w-full text-xs text-slate-500">
            This verdict covers the selected month only. Pick another month to check it.
          </span>
        </div>
      ) : null}

      {!report.period ? (
        <AdminCallout tone="neutral">
          <span>There is no published closing month to check yet.</span>
        </AdminCallout>
      ) : null}

      {report.unreadableLines.length > 0 ? (
        <AdminCallout tone="warning">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The closing could not be read for {report.unreadableLines.join(", ")}, so{" "}
            {report.unreadableLines.length === 1 ? "that line was" : "those lines were"} left out of
            this check entirely — not counted as zero.
          </span>
        </AdminCallout>
      ) : null}

      {report.surfaces.map((surface) => (
        <Card className="overflow-hidden p-0" key={surface.surface}>
          <div className="flex items-start gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-4 sm:px-5">
            {surface.ok ? (
              <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            ) : (
              <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
            )}
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">{surface.surface}</h2>
              <p className="mt-0.5 text-sm text-slate-600">{describeSurfaceResult(surface)}</p>
              <p className="mt-1 text-xs text-slate-500 tabular-nums">
                Monthly Closing {money(surface.closingTotal)} EGP · {surface.surface}{" "}
                {money(surface.surfaceTotal)} EGP
              </p>
            </div>
          </div>

          {surface.findings.length === 0 ? null : (
            <>
              <div className="hidden md:block">
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  {/* Five columns sharing 100%: the two money columns are numeric and narrow, the
                      Difference column carries a sentence and takes the slack. Nothing here has an
                      unbreakable token wider than its column. */}
                  <colgroup>
                    <col className="w-[15%]" />
                    <col className="w-[26%]" />
                    <col className="w-[16%]" />
                    <col className="w-[16%]" />
                    <col className="w-[27%]" />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-900">
                      <th className={THEAD}>Line</th>
                      <th className={THEAD}>Area</th>
                      <th className={THEAD}>Monthly Closing</th>
                      <th className={THEAD}>{surface.surface}</th>
                      <th className={THEAD}>Difference</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {surface.findings.map((finding) => (
                      <FindingRow
                        finding={finding}
                        key={`${finding.lineCode}:${finding.areaCode}`}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-3 p-4 md:hidden">
                {surface.findings.map((finding) => (
                  <FindingCard finding={finding} key={`${finding.lineCode}:${finding.areaCode}`} />
                ))}
              </div>
            </>
          )}
        </Card>
      ))}

      <p className="text-xs text-slate-500">
        Checked {new Date(report.generatedAt).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })}{" "}
        Cairo time. Figures are sales value in EGP; units are never added across products, so this
        check compares money only.
      </p>
    </div>
  );
}
