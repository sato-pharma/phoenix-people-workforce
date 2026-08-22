"use client";

// Business Review — the coverage surfaces.
//
// THE RULE THESE COMPONENTS EXIST FOR: a period with no data must SAY it has no data. It must
// never render as a zero, an empty table, or a 0% achievement — in a room where a manager is
// reviewing a head of department, a zero is not a rounding error, it is an accusation.
//
// Three surfaces, in increasing detail:
//
//   HardEmptyWindow   — the whole window has no sales. No tables render at all.
//   CoverageBanner    — above the tabs on every render, naming each empty or partial source.
//   CoverageTab       — the "system sheet": where every figure came from, what counts, what
//                       months are missing, and what could not be attributed to anybody.
//
// The tab is generated from the same block the figures are computed with, so it cannot drift from
// what the tables show. Nothing here is written by hand twice.

import { AlertTriangle, CircleAlert, Info } from "lucide-react";

import { describePeriods, type ReviewCoverage, type SourceCoverage } from "@/lib/business-review/coverage";
import { periodLabel } from "@/lib/business-review/period-format";
import { cn } from "@/lib/utils";

const num = (n: number) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "0");
const egp = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(
    Number.isFinite(n) ? n : 0,
  );

const STATUS_STYLE: Record<SourceCoverage["status"], string> = {
  complete: "bg-emerald-100 text-emerald-700",
  partial: "bg-amber-100 text-amber-700",
  empty: "bg-red-100 text-red-700",
};
const STATUS_LABEL: Record<SourceCoverage["status"], string> = {
  complete: "Complete",
  partial: "Partial",
  empty: "No data",
};

export function CoverageStatusChip({ status }: { status: SourceCoverage["status"] }) {
  return (
    <span className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold", STATUS_STYLE[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * The whole window holds no sales. Rendering the usual tables here would produce a page of
 * zeros and a 0% company achievement, which is the single most misleading thing this module
 * could put in front of a head of department.
 */
export function HardEmptyWindow({
  coverage,
  available,
}: {
  coverage: ReviewCoverage;
  available: string[];
}) {
  const nearest = available.length > 0 ? `${periodLabel(available[0])} – ${periodLabel(available[available.length - 1])}` : null;
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6">
      <div className="flex items-start gap-3">
        <CircleAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
        <div className="space-y-2">
          <h2 className="text-base font-bold text-red-900">
            No sales data exists for {coverage.window.label}
          </h2>
          <p className="text-sm text-red-900">
            {describePeriods(coverage.window.periods)} hold no validated closing rows, so there is nothing to
            review. This is not a zero and it is not a 0% achievement — the months are simply not there.
          </p>
          {nearest && (
            <p className="text-sm font-semibold text-red-900">
              Months that do hold data: {nearest}. Pick a window inside that range.
            </p>
          )}
          {coverage.adjustment && (
            <p className="text-sm text-red-900">The requested window was adjusted: {coverage.adjustment}.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Shown above the tabs whenever any source is empty or partial, or the requested window had to
 * be clamped. It names the source and the exact months — never a generic "some data is missing".
 */
export function CoverageBanner({ coverage }: { coverage: ReviewCoverage }) {
  const flagged = coverage.sources.filter((s) => s.status !== "complete");
  if (flagged.length === 0 && !coverage.adjustment) return null;

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      {coverage.adjustment && (
        <div className="flex items-start gap-2.5">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm font-semibold text-amber-900">
            The requested period was adjusted: {coverage.adjustment}. Showing {coverage.window.label}.
          </p>
        </div>
      )}
      {flagged.map((s) => (
        <div key={s.source} className="flex items-start gap-2.5">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-900">
            <span className="font-bold">{s.label}:</span> {s.note}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────── the system sheet ───────────────────────────────

type ProvenanceLine = {
  label: string;
  coveredValue: number;
  uncoveredValue: number;
  periodsWithTarget: string[];
  periodsWithoutTarget: string[];
};
export type CoverageProvenance = {
  engine: string;
  uploadedPeriods: string[];
  missingUploadPeriods: string[];
  unlinedValue: number;
  unlinedRows: number;
  lines: ProvenanceLine[];
  unplaced: {
    marketingRequests: number;
    marketingCommitted: number;
    outstationRows: number;
    outstationClaimed: number;
    visitRows: number;
    visitAgents: number;
    liveTreePlacedFacts: number;
  };
  visitsCollapsed: number;
  visitsFromExcludedAgents: number;
  coachingReports: number;
  coachingCoaches: number;
};

const TH = "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground";
const THR = "px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-muted-foreground";
const TD = "px-3 py-2 align-top text-sm";
const TDR = "px-3 py-2 align-top text-sm text-right tabular-nums";

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <h2 className="text-sm font-bold">{title}</h2>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <div className="overflow-x-auto p-1">{children}</div>
    </div>
  );
}

/**
 * Where every number on this page came from, what counts toward it, and what does not.
 *
 * Built from the coverage block the figures themselves were computed with. If a source changes
 * what it counts, this table changes with it — there is no second description to keep in step.
 */
export function CoverageTab({
  coverage,
  provenance,
}: {
  coverage: ReviewCoverage;
  provenance: CoverageProvenance;
}) {
  const unplaced = provenance.unplaced;
  const anyUnplaced =
    unplaced.marketingRequests + unplaced.outstationRows + unplaced.visitRows + unplaced.visitAgents > 0;

  return (
    <div className="space-y-4">
      <Panel title="Sources for this window" note={coverage.window.label}>
        <table className="w-full min-w-[900px] border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className={TH}>Metric</th>
              <th className={TH}>Status</th>
              <th className={THR}>Rows</th>
              <th className={TH}>Where it comes from</th>
              <th className={TH}>What counts</th>
              <th className={TH}>Months without data</th>
            </tr>
          </thead>
          <tbody>
            {coverage.sources.map((s) => (
              <tr key={s.source} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{s.label}</td>
                <td className={TD}>
                  <CoverageStatusChip status={s.status} />
                </td>
                <td className={TDR}>{num(s.rows)}</td>
                <td className={cn(TD, "text-muted-foreground")}>{s.origin}</td>
                <td className={cn(TD, "max-w-[26rem] text-muted-foreground")}>{s.rule}</td>
                <td className={cn(TD, "text-muted-foreground")}>
                  {s.periodsWithoutData.length === 0 ? "None" : describePeriods(s.periodsWithoutData)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Gradeability by line" note="achievement is covered actual ÷ target — never actual ÷ target">
        <table className="w-full min-w-[820px] border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className={TH}>Line</th>
              <th className={THR}>Sales with a target</th>
              <th className={THR}>Sales with no target</th>
              <th className={TH}>Months graded</th>
              <th className={TH}>Months value-only</th>
            </tr>
          </thead>
          <tbody>
            {provenance.lines.map((l) => (
              <tr key={l.label} className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>{l.label}</td>
                <td className={TDR}>{egp(l.coveredValue)}</td>
                <td className={cn(TDR, l.uncoveredValue > 0 && "font-semibold text-amber-700")}>
                  {egp(l.uncoveredValue)}
                </td>
                <td className={cn(TD, "text-muted-foreground")}>
                  {l.periodsWithTarget.length === 0 ? "None" : describePeriods(l.periodsWithTarget)}
                </td>
                <td className={cn(TD, "text-muted-foreground")}>
                  {l.periodsWithoutTarget.length === 0 ? "None" : describePeriods(l.periodsWithoutTarget)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-3 pb-3 pt-1 text-xs text-muted-foreground">
          A month with sales and no target is shown by value and is not graded. No run-rate is estimated in
          its place — loading its targets is what makes it gradeable.
        </p>
      </Panel>

      <Panel title="Rows that reached no unit" note="counted here, never folded into a total">
        {anyUnplaced ? (
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>What</th>
                <th className={THR}>Count</th>
                <th className={TH}>Why it matters</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/60">
                <td className={cn(TD, "font-semibold")}>Marketing requests with no district</td>
                <td className={TDR}>
                  {num(unplaced.marketingRequests)}
                  {unplaced.marketingCommitted > 0 ? ` · ${egp(unplaced.marketingCommitted)}` : ""}
                </td>
                <td className={cn(TD, "text-muted-foreground")}>
                  In the company total, absent from every district row below it.
                </td>
              </tr>
              <tr className="border-b border-border/60">
                <td className={cn(TD, "font-semibold")}>Outstation claims with no district</td>
                <td className={TDR}>
                  {num(unplaced.outstationRows)}
                  {unplaced.outstationClaimed > 0 ? ` · ${egp(unplaced.outstationClaimed)}` : ""}
                </td>
                <td className={cn(TD, "text-muted-foreground")}>
                  Same: real spend, in the company total, on nobody&apos;s district line.
                </td>
              </tr>
              <tr className="border-b border-border/60">
                <td className={cn(TD, "font-semibold")}>Visit rows with no HR id</td>
                <td className={TDR}>{num(unplaced.visitRows)}</td>
                <td className={cn(TD, "text-muted-foreground")}>
                  Real fieldwork the mirror could not attribute to a person, so it reaches no area.
                </td>
              </tr>
              <tr className="border-b border-border/60 last:border-0">
                <td className={cn(TD, "font-semibold")}>People placed from today&apos;s org tree</td>
                <td className={TDR}>{num(unplaced.liveTreePlacedFacts)}</td>
                <td className={cn(TD, "text-muted-foreground")}>
                  Carried no sales in the window, so their district comes from where they sit today rather
                  than from that month&apos;s own attribution.
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            Every marketing request, outstation claim and visit row in this window reached a district.
          </p>
        )}
      </Panel>

      <Panel title="How the window was assembled" note={provenance.engine}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
          <Fact
            term="Distributor uploads"
            detail={
              provenance.missingUploadPeriods.length === 0
                ? `All ${provenance.uploadedPeriods.length} months in the window have a validated upload.`
                : `Missing for ${describePeriods(provenance.missingUploadPeriods)}. Those months are held out of ` +
                  `every sales, target and achievement figure on this page. They are not empty — they hold ` +
                  `${egp(coverage.notUploaded?.value ?? 0)} of Direct orders across ` +
                  `${num(coverage.notUploaded?.rows ?? 0)} row${coverage.notUploaded?.rows === 1 ? "" : "s"}, ` +
                  `which is counted here and nowhere else.`
            }
          />
          <Fact
            term="Sales on no line"
            detail={
              provenance.unlinedRows === 0
                ? "Every sales row resolved to a line."
                : `${num(provenance.unlinedRows)} rows worth ${egp(provenance.unlinedValue)} carry no sales line, so they sit in the company total and in no line dataset.`
            }
          />
          <Fact
            term="Duplicate visit submissions"
            detail={`${num(provenance.visitsCollapsed)} re-saves of a stop already counted were collapsed. One rep, one doctor, one day, one type is one visit.`}
          />
          <Fact
            term="Resigned agents"
            detail={`${num(provenance.visitsFromExcludedAgents)} visit rows belong to agents on the resigned/excluded floor. They are INCLUDED on purpose — a rep who left in March still worked in January, and dropping them would quietly shrink a past month.`}
          />
          <Fact
            term="Coaching reports"
            detail={
              provenance.coachingReports === 0
                ? "No coaching reports were filed in this window."
                : `${num(provenance.coachingReports)} reports from ${num(provenance.coachingCoaches)} coach${provenance.coachingCoaches === 1 ? "" : "es"}.`
            }
          />
          <Fact
            term="Timezone"
            detail="Every month boundary is Africa/Cairo local time, matching the rest of Phoenix."
          />
        </dl>
      </Panel>
    </div>
  );
}

function Fact({ term, detail }: { term: string; detail: string }) {
  return (
    <div>
      <dt className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{term}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{detail}</dd>
    </div>
  );
}
