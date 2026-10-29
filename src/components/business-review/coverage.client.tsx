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
import { PortalDesktopTable, PortalResponsiveDataList } from "@/components/employee-portal/portal-primitives";
import { cn } from "@/lib/utils";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

const num = (n: number) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "0");
const egp = (n: number) =>
  stableCurrencyFormatter("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(
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
    <span className={cn("rounded px-1.5 py-0.5 text-phx-2xs font-bold", STATUS_STYLE[status])}>
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
  if (flagged.length === 0 && !coverage.adjustment && !coverage.figureWindow) return null;

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      {/* Said FIRST, in one sentence, because it governs every number underneath. Sales, spend,
          visits and doctors all stop at the same month now (owner ruling 2026-09-26); before that
          they did not, and the heading named a range a third of whose figures were never in it. */}
      {coverage.figureWindow && (
        <div className="flex items-start gap-2.5">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm font-semibold text-amber-900">
            Every figure below covers {coverage.figureWindow.label}, not the whole of{" "}
            {coverage.window.label} — sales, spend and field activity all stop at the same month.
          </p>
        </div>
      )}
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
};

const TH = "px-3 py-2 text-left text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const THR = "px-3 py-2 text-right text-phx-xs font-bold uppercase tracking-wide text-muted-foreground";
const TD = "px-3 py-2 align-top text-sm";
/** One line of muted prose where a table would otherwise be empty. */
const EMPTY_LINE = "px-3 py-4 text-sm text-muted-foreground";
const TDR = "px-3 py-2 align-top text-sm text-right tabular-nums";

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <h2 className="text-sm font-bold">{title}</h2>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      {/* No scroll wrapper. Every table inside is `table-fixed` with a percentage colgroup, so it
          divides the container instead of overflowing it, and a phone gets cards rather than a
          table at all. Note that removing the class is not by itself the fix in the admin shell:
          app/globals.css gives ANY element with a direct <table> child `overflow-x: auto`, whatever
          its class list says — which is exactly why the fix has to be structural. */}
      <div className="p-1">{children}</div>
    </div>
  );
}

/**
 * The four "reached no unit" rows, as data — so the phone cards and the desktop table are two
 * renderings of one list rather than two lists that have to be kept in step by hand.
 */
function unplacedRows(unplaced: CoverageProvenance["unplaced"]): { what: string; count: string; why: string }[] {
  return [
    {
      what: "Marketing requests with no district",
      count: num(unplaced.marketingRequests) + (unplaced.marketingCommitted > 0 ? ` · ${egp(unplaced.marketingCommitted)}` : ""),
      why: "In the company total, absent from every district row below it.",
    },
    {
      what: "Outstation claims with no district",
      count: num(unplaced.outstationRows) + (unplaced.outstationClaimed > 0 ? ` · ${egp(unplaced.outstationClaimed)}` : ""),
      why: "Same: real spend, in the company total, on nobody's district line.",
    },
    {
      what: "Visit rows with no HR id",
      count: num(unplaced.visitRows),
      why: "Real fieldwork the mirror could not attribute to a person, so it reaches no area.",
    },
    {
      what: "People placed from today's org tree",
      count: num(unplaced.liveTreePlacedFacts),
      why:
        "Carried no sales in the window, so their district comes from where they sit today rather " +
        "than from that month's own attribution.",
    },
  ];
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
        <PortalResponsiveDataList
          breakpoint="lg"
          empty={<p className={EMPTY_LINE}>This window holds no sources at all.</p>}
          getKey={(s) => s.source}
          items={coverage.sources}
          renderCard={(s) => (
            <div className="space-y-1.5 px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <h3 className="min-w-0 break-words text-sm font-bold">{s.label}</h3>
                <CoverageStatusChip status={s.status} />
              </div>
              <p className="text-phx-xs text-muted-foreground">
                {num(s.rows)} rows · {s.origin}
              </p>
              <p className="break-words text-phx-xs text-muted-foreground">{s.rule}</p>
              <p className="break-words text-phx-xs text-muted-foreground">
                Months without data:{" "}
                {s.periodsWithoutData.length === 0 ? "None" : describePeriods(s.periodsWithoutData)}
              </p>
            </div>
          )}
          renderTable={() => (
            <PortalDesktopTable
              breakpoint="lg"
              cols={
                <colgroup>
                  <col className="w-[14%]" />
                  <col className="w-[10%]" />
                  <col className="w-[7%]" />
                  <col className="w-[23%]" />
                  <col className="w-[32%]" />
                  <col className="w-[14%]" />
                </colgroup>
              }
            >
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
                    <td className={cn(TD, "break-words font-semibold")}>{s.label}</td>
                    <td className={TD}>
                      <CoverageStatusChip status={s.status} />
                    </td>
                    <td className={TDR}>{num(s.rows)}</td>
                    <td className={cn(TD, "break-words text-muted-foreground")}>{s.origin}</td>
                    <td className={cn(TD, "break-words text-muted-foreground")}>{s.rule}</td>
                    <td className={cn(TD, "break-words text-muted-foreground")}>
                      {s.periodsWithoutData.length === 0 ? "None" : describePeriods(s.periodsWithoutData)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </Panel>

      <Panel title="Gradeability by line" note="achievement is covered actual ÷ target — never actual ÷ target">
        <PortalResponsiveDataList
          empty={<p className={EMPTY_LINE}>No line carried sales in this window.</p>}
          getKey={(l) => l.label}
          items={provenance.lines}
          renderCard={(l) => (
            <div className="space-y-1.5 px-4 py-3.5">
              <h3 className="text-sm font-bold">{l.label}</h3>
              <p className="text-phx-xs text-muted-foreground">
                With a target {egp(l.coveredValue)} · without {egp(l.uncoveredValue)}
              </p>
              <p className="break-words text-phx-xs text-muted-foreground">
                Graded: {l.periodsWithTarget.length === 0 ? "None" : describePeriods(l.periodsWithTarget)}
              </p>
              <p className="break-words text-phx-xs text-muted-foreground">
                Value only:{" "}
                {l.periodsWithoutTarget.length === 0 ? "None" : describePeriods(l.periodsWithoutTarget)}
              </p>
            </div>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[16%]" />
                  <col className="w-[17%]" />
                  <col className="w-[17%]" />
                  <col className="w-[25%]" />
                  <col className="w-[25%]" />
                </colgroup>
              }
            >
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
                    <td className={cn(TD, "break-words font-semibold")}>{l.label}</td>
                    <td className={TDR}>{egp(l.coveredValue)}</td>
                    <td className={cn(TDR, l.uncoveredValue > 0 && "font-semibold text-amber-700")}>
                      {egp(l.uncoveredValue)}
                    </td>
                    <td className={cn(TD, "break-words text-muted-foreground")}>
                      {l.periodsWithTarget.length === 0 ? "None" : describePeriods(l.periodsWithTarget)}
                    </td>
                    <td className={cn(TD, "break-words text-muted-foreground")}>
                      {l.periodsWithoutTarget.length === 0 ? "None" : describePeriods(l.periodsWithoutTarget)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
        <p className="px-3 pb-3 pt-1 text-xs text-muted-foreground">
          A month with sales and no target is shown by value and is not graded. No run-rate is estimated in
          its place — loading its targets is what makes it gradeable.
        </p>
      </Panel>

      <Panel title="Rows that reached no unit" note="counted here, never folded into a total">
        {anyUnplaced ? (
          <PortalResponsiveDataList
            empty={<p className={EMPTY_LINE}>Every row in this window reached a unit.</p>}
            getKey={(row) => row.what}
            items={unplacedRows(unplaced)}
            renderCard={(row) => (
              <div className="space-y-1 px-4 py-3.5">
                <h3 className="min-w-0 break-words text-sm font-bold">{row.what}</h3>
                <p className="text-phx-xs font-semibold tabular-nums">{row.count}</p>
                <p className="break-words text-phx-xs text-muted-foreground">{row.why}</p>
              </div>
            )}
            renderTable={() => (
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[32%]" />
                    <col className="w-[16%]" />
                    <col className="w-[52%]" />
                  </colgroup>
                }
              >
                <thead>
                  <tr className="border-b border-border">
                    <th className={TH}>What</th>
                    <th className={THR}>Count</th>
                    <th className={TH}>Why it matters</th>
                  </tr>
                </thead>
                <tbody>
                  {unplacedRows(unplaced).map((row) => (
                    <tr key={row.what} className="border-b border-border/60 last:border-0">
                      <td className={cn(TD, "break-words font-semibold")}>{row.what}</td>
                      <td className={TDR}>{row.count}</td>
                      <td className={cn(TD, "break-words text-muted-foreground")}>{row.why}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
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
      <dt className="text-phx-xs font-bold uppercase tracking-wide text-muted-foreground">{term}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{detail}</dd>
    </div>
  );
}
