import Link from "next/link";

import { KpisPeriodPicker, type KpiPickerOption } from "@/components/crm/kpis-period-picker";
import { KPI_TABS, KPI_TAB_HINT, KPI_TAB_LABEL, type KpiTab } from "@/lib/crm/kpis-tabs";
import type { KpiRepRow, KpisBoard } from "@/lib/crm/kpis-board";

/**
 * The KPIs board — Summary, Call Rate, Coverage and Frequency over one rep list.
 *
 * ## The owner's vocabulary, not the code's
 *
 * The frequency buckets are `on_plan` / `under` / `over` in the domain, and the owner's own words
 * for them are EXACT, BELOW and ABOVE. The screen uses his. A manager reading "on plan" beside
 * "under" has to work out that they are the same axis; "Exact / Below / Above" is one sentence.
 *
 * ## Fits the screen
 *
 * Every table is `w-full table-fixed` over a `<colgroup>` summing to 100%, and never
 * `PortalDesktopTable` — the owner's golden rule forbids a horizontal scroll at any width, and that
 * primitive carries a min-width floor with `overflow-x-auto`, which IS the bug rather than the fix.
 * Where a column will not fit it is MERGED into its neighbour, never shrunk, and long values wrap.
 * No value is ever truncated with an ellipsis.
 *
 * ## Mobile gets cards, desktop gets the table — inlined, NOT through the primitive
 *
 * This file has no "use client": it renders on the server. PortalResponsiveDataList does have one,
 * so handing it `getKey` / `renderCard` / `renderTable` sends three FUNCTIONS across the RSC
 * boundary. React cannot serialise a function, so the page 500s at render time with "Functions
 * cannot be passed directly to Client Components" — on every load, for everyone, not as an edge
 * case. That is not hypothetical: it is exactly what took /admin/doctor-coverage and its portal
 * twin down for about an hour on 2026-08-21. That board carried the same inline for the same
 * reason until it was deleted on 2026-09-02, five days after the owner retired its route; this
 * file is now where the pattern is written down.
 *
 * Adding "use client" here would also silence it, but it is the wrong trade: this board is a
 * read-only report with no interactivity of its own, so it would ship ~400 lines of markup logic
 * to the browser to buy nothing. The primitive is nine lines of pure markup with no client
 * behaviour at all, so inlining costs nothing and the rule is unchanged — only the spelling is.
 * The `md:hidden` card list and the `hidden md:block` table wrapper below ARE what it emits.
 *
 * tests/rsc-client-function-props.test.ts guards the boundary; tests/crm-mobile-table-cards.test.ts
 * accepts this spelling because it checks for `md:hidden`, not for the primitive by name.
 */

const PANEL = "border border-slate-200 bg-white";
const HEADING = "text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900";
const CAPTION = "text-phx-2xs text-slate-500";
const TH = "px-4 py-2.5 text-left text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";
const TD = "px-4 py-3 align-top text-sm text-slate-700";
const NUM = "px-4 py-3 align-top text-sm font-semibold tabular-nums text-slate-900";

/** A rate as the board prints it: two decimals, or an em dash when there is nothing to divide. */
function rate(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

/** A percentage, or a marker when the rep has no plan to be a percentage OF. */
function planPct(row: KpiRepRow, value: number): string {
  return row.hasMeasurablePlan ? `${value}%` : "No plan";
}

function Tile({ caption, label, value }: { caption?: string; label: string; value: string }) {
  return (
    <div className="border border-slate-200 px-4 py-3">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-black tabular-nums text-slate-900">{value}</p>
      {caption ? <p className={`mt-0.5 ${CAPTION}`}>{caption}</p> : null}
    </div>
  );
}

function tabHref(basePath: string, board: KpisBoard, tab: KpiTab): string {
  const query = new URLSearchParams();
  query.set("month", board.month);
  if (board.range.periodKey !== "month") query.set("period", board.range.periodKey);
  if (tab !== "summary") query.set("tab", tab);
  return `${basePath}?${query.toString()}`;
}

function KpiTabStrip({ active, basePath, board }: { active: KpiTab; basePath: string; board: KpisBoard }) {
  return (
    <div className="flex flex-wrap gap-0 border border-b-0 border-slate-200 bg-white">
      {KPI_TABS.map((tab) => {
        const current = tab === active;
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={
              current
                ? "border-b-2 border-orange-500 px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900"
                : "border-b-2 border-transparent px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400 transition-colors hover:text-slate-700"
            }
            href={tabHref(basePath, board, tab)}
            key={tab}
          >
            {KPI_TAB_LABEL[tab]}
          </Link>
        );
      })}
    </div>
  );
}

/** The one line every tab shows about the rep, so a card and a row always name him the same way. */
function RepName({ row }: { row: KpiRepRow }) {
  return (
    <span className="block font-semibold text-slate-900" dir="auto">
      {row.repName || "Unnamed rep"}
    </span>
  );
}

function SummaryTable({ rows }: { rows: KpiRepRow[] }) {
  return (
    <table className="hidden w-full table-fixed md:table">
      <colgroup>
        <col style={{ width: "34%" }} />
        <col style={{ width: "22%" }} />
        <col style={{ width: "22%" }} />
        <col style={{ width: "22%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <th className={TH}>Medical rep</th>
          <th className={TH}>Call rate AM / PM</th>
          <th className={TH}>Coverage</th>
          <th className={TH}>Frequency</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.agentCrmId ?? row.repName}>
            <td className={TD}>
              <RepName row={row} />
            </td>
            <td className={NUM}>
              {rate(row.amRate)} / {rate(row.pmRate)}
            </td>
            <td className={NUM}>{planPct(row, row.coveragePct)}</td>
            <td className={NUM}>{planPct(row, row.frequencyPct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CallRateTable({ board, rows }: { board: KpisBoard; rows: KpiRepRow[] }) {
  return (
    <table className="hidden w-full table-fixed md:table">
      <colgroup>
        <col style={{ width: "30%" }} />
        <col style={{ width: "14%" }} />
        <col style={{ width: "18%" }} />
        <col style={{ width: "18%" }} />
        <col style={{ width: "20%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <th className={TH}>Medical rep</th>
          <th className={TH}>Working days</th>
          <th className={TH}>AM · target {board.amTarget}</th>
          <th className={TH}>PM · target {board.pmTarget}</th>
          {/* Merged rather than given two columns — the golden rule resolves a width collision by
              merging, never by shrinking type. */}
          <th className={TH}>Campaign</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.agentCrmId ?? row.repName}>
            <td className={TD}>
              <RepName row={row} />
            </td>
            <td className={NUM}>{row.workingDays}</td>
            <td className={NUM}>
              {rate(row.amRate)}
              <span className="block text-phx-2xs font-semibold text-slate-500">{row.amVerified} verified</span>
            </td>
            <td className={NUM}>
              {rate(row.pmRate)}
              <span className="block text-phx-2xs font-semibold text-slate-500">{row.pmVerified} verified</span>
            </td>
            <td className={NUM}>
              {Math.round(row.campaignShare * 100)}%
              <span className="block text-phx-2xs font-semibold text-slate-500">
                {row.campaignCalls} calls
                {row.campaignOnlyDays > 0 ? ` · ${row.campaignOnlyDays} day(s) campaign only` : ""}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CoverageTable({ rows }: { rows: KpiRepRow[] }) {
  return (
    <table className="hidden w-full table-fixed md:table">
      <colgroup>
        <col style={{ width: "34%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "18%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <th className={TH}>Medical rep</th>
          <th className={TH}>Planned</th>
          <th className={TH}>Covered</th>
          <th className={TH}>Not reached</th>
          <th className={TH}>Coverage</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.agentCrmId ?? row.repName}>
            <td className={TD}>
              <RepName row={row} />
            </td>
            <td className={NUM}>{row.plannedDoctors}</td>
            <td className={NUM}>{row.visitedDoctors}</td>
            <td className={NUM}>{row.missedDoctors}</td>
            <td className={NUM}>{planPct(row, row.coveragePct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FrequencyTable({ rows }: { rows: KpiRepRow[] }) {
  return (
    <table className="hidden w-full table-fixed md:table">
      <colgroup>
        <col style={{ width: "30%" }} />
        <col style={{ width: "14%" }} />
        <col style={{ width: "14%" }} />
        <col style={{ width: "14%" }} />
        <col style={{ width: "14%" }} />
        <col style={{ width: "14%" }} />
      </colgroup>
      <thead className="border-y border-slate-200 bg-slate-50">
        <tr>
          <th className={TH}>Medical rep</th>
          {/* The owner's three words. `Exact` is the only pass — see kpis-board.ts. */}
          <th className={TH}>Exact</th>
          <th className={TH}>Below</th>
          <th className={TH}>Above</th>
          <th className={TH}>Not due</th>
          <th className={TH}>Frequency</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.agentCrmId ?? row.repName}>
            <td className={TD}>
              <RepName row={row} />
            </td>
            <td className={NUM}>{row.onPlanDoctors}</td>
            <td className={NUM}>{row.underDoctors}</td>
            <td className={NUM}>{row.overDoctors}</td>
            <td className={NUM}>{row.notDueDoctors}</td>
            <td className={NUM}>{planPct(row, row.frequencyPct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The mobile card. Every tab shows the same three KPIs on a card — a phone has no room for four
 * different card layouts, and a manager on a phone wants the whole picture of one rep anyway. */
function RepCard({ row }: { row: KpiRepRow }) {
  return (
    <div className="px-4 py-3">
      <RepName row={row} />
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <div>
          <dt className={CAPTION}>Call rate</dt>
          <dd className="text-sm font-black tabular-nums text-slate-900">
            {rate(row.amRate)} / {rate(row.pmRate)}
          </dd>
        </div>
        <div>
          <dt className={CAPTION}>Coverage</dt>
          <dd className="text-sm font-black tabular-nums text-slate-900">{planPct(row, row.coveragePct)}</dd>
        </div>
        <div>
          <dt className={CAPTION}>Frequency</dt>
          <dd className="text-sm font-black tabular-nums text-slate-900">{planPct(row, row.frequencyPct)}</dd>
        </div>
      </dl>
      <p className={`mt-1.5 ${CAPTION}`}>
        {row.onPlanDoctors} exact · {row.underDoctors} below · {row.overDoctors} above ·{" "}
        {row.visitedDoctors}/{row.plannedDoctors} covered
      </p>
    </div>
  );
}

export function KpisBoardView({
  basePath,
  board,
  monthOptions,
  periodOptions,
  tab,
}: {
  basePath: string;
  board: KpisBoard;
  monthOptions: readonly KpiPickerOption[];
  periodOptions: readonly KpiPickerOption[];
  tab: KpiTab;
}) {
  if (board.scopeReason) {
    return (
      <div className={PANEL}>
        <div className="px-5 py-6">
          <p className="text-sm font-semibold text-slate-700">{board.scopeReason}</p>
          <p className={`mt-1 ${CAPTION}`}>
            KPIs are scoped to the reps you manage. If you believe this is wrong, ask your administrator to check
            your seat in the organogram.
          </p>
        </div>
      </div>
    );
  }

  const { totals } = board;
  // Lowercased for "Whole month" ONLY, which is a common noun sitting mid-sentence. A week's label is
  // "Week 1 · 1–7 Sep" — a proper name carrying a month abbreviation — so lowercasing it printed
  // "week 1 · 1–7 sep", which reads as a typo now that a real date sits beside it in the footnote.
  const periodPhrase = board.range.isWholeMonth ? board.range.periodLabel.toLowerCase() : board.range.periodLabel;

  return (
    <>
      <KpiTabStrip active={tab} basePath={basePath} board={board} />
      <div className={PANEL}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className={HEADING}>{KPI_TAB_LABEL[tab]}</p>
            <p className={`mt-0.5 ${CAPTION}`}>{KPI_TAB_HINT[tab]}</p>
          </div>
          <p className={CAPTION}>
            {board.scopeLabel} · {board.monthLabel} · {board.range.periodLabel}
          </p>
        </div>

        <div className="border-t border-slate-100 px-5 py-4">
          <KpisPeriodPicker
            basePath={basePath}
            month={board.month}
            monthOptions={monthOptions}
            period={board.range.periodKey}
            periodOptions={periodOptions}
            tab={tab}
          />
        </div>

        {/* THE HOLIDAY CAVEAT. When a holiday calendar could not be read the denominator may be too
            big, which makes every call rate on this board read LOW. Saying so is not decoration:
            an unexplained dip reads as the field force under-calling. */}
        {board.holidaysComplete ? null : (
          <div className="border-t border-amber-200 bg-amber-50 px-5 py-3">
            <p className="text-phx-xs font-bold text-amber-900">
              The national holiday calendar could not be read for this period.
            </p>
            <p className="mt-0.5 text-phx-2xs text-amber-800">
              Any public holiday it did not return is still counted as a working day, so the call rates below may be
              lower than the real figure. Coverage and frequency are unaffected.
            </p>
          </div>
        )}

        {board.range.notStarted ? (
          <div className="border-t border-slate-100 px-5 py-3">
            <p className={`${CAPTION} font-semibold`}>
              This period has not started yet, so every call rate is blank rather than zero.
            </p>
          </div>
        ) : null}

        <div className="grid gap-3 border-t border-slate-100 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            caption={
              board.holidayDays > 0
                ? `${board.workingDays} working days · ${board.holidayDays} national holiday(s) removed`
                : `${board.workingDays} working days · Sat–Wed`
            }
            label="Reps in reach"
            value={String(totals.reps)}
          />
          <Tile
            caption={`Team average · targets ${board.amTarget} / ${board.pmTarget}`}
            label="Call rate AM / PM"
            value={`${rate(totals.amRate)} / ${rate(totals.pmRate)}`}
          />
          <Tile
            caption={`${totals.visitedDoctors} of ${totals.plannedDoctors} planned doctors`}
            label="Coverage"
            value={`${totals.coveragePct}%`}
          />
          <Tile
            caption={`${totals.onPlanDoctors} exact · ${totals.underDoctors} below · ${totals.overDoctors} above`}
            label="Frequency"
            value={`${totals.frequencyPct}%`}
          />
        </div>

        <div className="border-t border-slate-100">
          {board.reps.length === 0 ? (
            <div className="px-5 py-6">
              <p className="text-sm font-semibold text-slate-700">No reps in this period.</p>
              <p className={`mt-1 ${CAPTION}`}>
                Nobody in your reach logged a visit or carried a plan in {board.range.periodLabel.toLowerCase()}.
              </p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-slate-100 md:hidden">
                {board.reps.map((row, index) => (
                  <div key={String(row.agentCrmId ?? `${row.repName}-${index}`)}>
                    <RepCard row={row} />
                  </div>
                ))}
              </div>
              <div className="hidden md:block">
                {tab === "summary" ? <SummaryTable rows={board.reps} /> : null}
                {tab === "call-rate" ? <CallRateTable board={board} rows={board.reps} /> : null}
                {tab === "coverage" ? <CoverageTable rows={board.reps} /> : null}
                {tab === "frequency" ? <FrequencyTable rows={board.reps} /> : null}
              </div>
            </>
          )}
        </div>

        <div className="border-t border-slate-100 px-5 py-3">
          {/* The call-rate window's own end is PRINTED, never implied. Both halves of this board stop at
            * today in a running month — repsPlansRange caps it with `dateTo = running ? todayIso : windowEnd`
            * and coverage caps its own `asOf` at the same day — so the earlier wording ("scored for
            * September 2026 to 2026-09-02. Call rate is scored over whole month.") read as though the rate
            * had spanned September's ~21 working days when it had in fact divided by 2. The two dates are
            * equal for a whole month and differ only for a week, which is exactly what the reader needs to
            * see. A `notStarted` window is the one case where dateTo sits BEFORE dateFrom, deliberately, so
            * printing it would say "week 3 · 15–21 sep to 2026-09-14" — say it has not started instead. */}
          <p className={CAPTION}>
            Coverage and frequency are scored for {board.monthLabel} to {board.asOf}.{" "}
            {board.range.notStarted
              ? `Call rate is not scored — ${periodPhrase} has not started.`
              : `Call rate is scored over ${periodPhrase} to ${board.range.dateTo}.`}{" "}
            Exact is the only frequency pass — visiting a doctor more often than the plan asked for is a deviation,
            not a win.
          </p>
        </div>
      </div>
    </>
  );
}
