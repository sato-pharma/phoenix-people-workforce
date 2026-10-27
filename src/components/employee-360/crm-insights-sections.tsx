// Employee 360 — the Phoenix CRM sections: plan compliance and visit frequency by customer grade.
//
// The figures are shaped in `src/lib/employee-360/crm-insights.ts` from Phoenix CRM's own report
// functions; this file only draws them. Square corners, desktop tables that fit their width
// (`table-fixed` + `<colgroup>`), cards below the `sm` breakpoint, no ellipsis. A section whose read
// failed says "Could not be read" and shows no figure; a section with nothing to show is not drawn.

import { CalendarCheck, Repeat } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type {
  CrmFrequency,
  CrmInsight,
  CrmManagerPlanCompliance,
  CrmPlanCompliance,
  CrmRepPlanCompliance,
  Employee360CrmInsights,
} from "@/lib/employee-360/crm-insights";
import { formatDateValue } from "@/lib/i18n/format";

const intFmt = new Intl.NumberFormat("en-US");
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

const TH = "px-2 py-2 text-left text-phx-2xs font-black uppercase tracking-wide text-slate-500 break-words";
const TH_NUM = "px-2 py-2 text-right text-phx-2xs font-black uppercase tracking-wide text-slate-500 break-words";
const TD = "px-2 py-2.5 text-sm text-slate-800 break-words";
const TD_NUM = "px-2 py-2.5 text-right text-sm font-bold tabular-nums text-slate-900";

function day(value: string): string {
  return formatDateValue(value);
}

function monthLabel(month: string): string {
  return formatDateValue(`${month}-01`, null, { day: undefined, month: "long", year: "numeric" });
}

function percent(value: number | null): string {
  return value === null ? "Not measured yet" : `${oneDecimal.format(value)}%`;
}

function Shell({ icon: Icon, title, sub, children }: { icon: LucideIcon; title: string; sub?: string; children: ReactNode }) {
  return (
    // The same sheet as every other section of the record (employee-360-view.tsx PREMIUM_CARD): an ink
    // rule across its head, a flat glyph beside an h3 — these sit inside a numbered chapter whose title
    // is the h2.
    <section className="border border-slate-200/80 border-t-2 border-t-slate-900 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)] sm:p-6">
      <div className="mb-5 border-b border-slate-200 pb-4">
        <h3 className="flex items-center gap-2.5 text-lg font-black tracking-[-0.015em] text-slate-900 sm:text-xl">
          <Icon className="h-[1.1rem] w-[1.1rem] shrink-0 text-indigo-700" aria-hidden />
          <span className="min-w-0 break-words">{title}</span>
        </h3>
        {sub ? <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-500">{sub}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Unread() {
  return <p className="text-sm font-bold text-amber-700">Could not be read.</p>;
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-r border-slate-200 bg-white px-4 py-3.5">
      <span className="block break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <span className="mt-1.5 block break-words text-2xl font-black tabular-nums tracking-[-0.02em] text-slate-900 sm:text-[1.75rem]">{value}</span>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-xs leading-5 text-slate-500">{children}</p>;
}

/** A label and value pair inside a phone card. */
function CardField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="break-words text-phx-2xs font-black uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-bold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}

// ── Plan compliance ─────────────────────────────────────────────────────────────────────────────

function RepPlanBody({ value }: { value: CrmRepPlanCompliance }) {
  const listName = (listType: string) => `${listType} list`;
  return (
    <>
      <div className="hidden sm:block">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[16%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[16%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[20%]" />
          </colgroup>
          <thead className="border-b border-slate-200">
            <tr>
              <th className={TH}>List</th>
              <th className={TH_NUM}>Planned</th>
              <th className={TH_NUM}>Kept</th>
              <th className={TH_NUM}>Waiting on a decision</th>
              <th className={TH_NUM}>Missed</th>
              <th className={TH_NUM}>On leave</th>
              <th className={TH_NUM}>Plan kept</th>
            </tr>
          </thead>
          <tbody>
            {value.lines.map((line) => (
              <tr key={line.listType} className="border-b border-slate-100 last:border-b-0">
                <td className={TD}>{listName(line.listType)}</td>
                <td className={TD_NUM}>{intFmt.format(line.planned)}</td>
                <td className={TD_NUM}>{intFmt.format(line.kept)}</td>
                <td className={TD_NUM}>{intFmt.format(line.waiting)}</td>
                <td className={TD_NUM}>{intFmt.format(line.missed)}</td>
                <td className={TD_NUM}>{intFmt.format(line.onLeave)}</td>
                <td className={TD_NUM}>{percent(line.keptPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-3 sm:hidden">
        {value.lines.map((line) => (
          <div key={line.listType} className="border border-slate-200 p-3.5">
            <p className="text-sm font-black text-slate-900">{listName(line.listType)}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
              <CardField label="Planned" value={intFmt.format(line.planned)} />
              <CardField label="Kept" value={intFmt.format(line.kept)} />
              <CardField label="Waiting on a decision" value={intFmt.format(line.waiting)} />
              <CardField label="Missed" value={intFmt.format(line.missed)} />
              <CardField label="On leave" value={intFmt.format(line.onLeave)} />
              <CardField label="Plan kept" value={percent(line.keptPct)} />
            </dl>
          </div>
        ))}
      </div>
      {value.leaveUnread ? <Note>HR&apos;s leave could not be read, so a planned customer on a leave day may show as missed.</Note> : null}
      {value.shortened ? <Note>Only the latest months of the period are read, from {day(value.from)}.</Note> : null}
    </>
  );
}

function ManagerPlanBody({ value }: { value: CrmManagerPlanCompliance }) {
  const week = (start: string, end: string) => `${day(start)} to ${day(end)}`;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 border-l border-t border-slate-200 sm:grid-cols-4">
        <Tile label="Weeks sent" value={intFmt.format(value.totals.weeks)} />
        <Tile label="Customers due" value={intFmt.format(value.totals.closed)} />
        <Tile label="Done" value={intFmt.format(value.totals.done)} />
        <Tile label="Plan kept" value={value.totals.keptPct === null ? "Not measured yet" : `${value.totals.keptPct}%`} />
      </div>
      <div className="hidden sm:block">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[28%]" />
            <col className="w-[14%]" />
            <col className="w-[12%]" />
            <col className="w-[16%]" />
          </colgroup>
          <thead className="border-b border-slate-200">
            <tr>
              <th className={TH}>Week</th>
              <th className={TH}>Status</th>
              <th className={TH_NUM}>Customers due</th>
              <th className={TH_NUM}>Done</th>
              <th className={TH_NUM}>Plan kept</th>
            </tr>
          </thead>
          <tbody>
            {value.weeks.map((row) => (
              <tr key={row.weekStart} className="border-b border-slate-100 last:border-b-0">
                <td className={TD}>{week(row.weekStart, row.weekEnd)}</td>
                <td className={TD}>{row.statusLabel}</td>
                <td className={TD_NUM}>{intFmt.format(row.closed)}</td>
                <td className={TD_NUM}>{intFmt.format(row.done)}</td>
                <td className={TD_NUM}>{row.keptPct === null ? "Not measured yet" : `${row.keptPct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-3 sm:hidden">
        {value.weeks.map((row) => (
          <div key={row.weekStart} className="border border-slate-200 p-3.5">
            <p className="text-sm font-black text-slate-900">{week(row.weekStart, row.weekEnd)}</p>
            <p className="mt-0.5 text-xs text-slate-500">{row.statusLabel}</p>
            <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2">
              <CardField label="Due" value={intFmt.format(row.closed)} />
              <CardField label="Done" value={intFmt.format(row.done)} />
              <CardField label="Plan kept" value={row.keptPct === null ? "Not measured yet" : `${row.keptPct}%`} />
            </dl>
          </div>
        ))}
      </div>
      <Note>A planned customer counts once the day has closed. A week with none closed yet is listed but not measured.</Note>
      {value.shortened ? <Note>Only the newest sent weeks are read; older weeks of this period are not shown.</Note> : null}
    </>
  );
}

export function CrmPlanComplianceSection({ insight }: { insight: CrmInsight<CrmPlanCompliance> | null }) {
  if (!insight || insight.state === "empty") return null;
  if (insight.state === "unread") {
    return (
      <Shell icon={CalendarCheck} title="Plan compliance">
        <Unread />
      </Shell>
    );
  }
  const value = insight.value;
  const sub =
    value.kind === "rep"
      ? `The Phoenix CRM plan against the visits made, ${day(value.from)} to ${day(value.to)}. A day HR approved as leave is kept apart and never counts as missed.`
      : `The manager's weekly plans that were sent, against what was done, ${day(value.from)} to ${day(value.to)}.`;
  return (
    <Shell icon={CalendarCheck} title="Plan compliance" sub={sub}>
      {value.kind === "rep" ? <RepPlanBody value={value} /> : <ManagerPlanBody value={value} />}
    </Shell>
  );
}

// ── Visit frequency by customer grade ───────────────────────────────────────────────────────────

function FrequencyBody({ value }: { value: CrmFrequency }) {
  const target = (n: number | null) => (n === null ? "No target set" : intFmt.format(n));
  return (
    <>
      <div className="mb-4 grid grid-cols-2 border-l border-t border-slate-200 sm:grid-cols-5">
        <Tile label="Customers" value={intFmt.format(value.totals.customers)} />
        <Tile label="Under the grade" value={intFmt.format(value.totals.under)} />
        <Tile label="On the grade" value={intFmt.format(value.totals.onTarget)} />
        <Tile label="Over the grade" value={intFmt.format(value.totals.over)} />
        <Tile label="No target set" value={intFmt.format(value.totals.noTarget)} />
      </div>
      <div className="hidden sm:block">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[12%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
            <col className="w-[38%]" />
          </colgroup>
          <thead className="border-b border-slate-200">
            <tr>
              <th className={TH}>Grade</th>
              <th className={TH_NUM}>Customers</th>
              <th className={TH_NUM}>Target a month</th>
              <th className={TH_NUM}>Visits each</th>
              <th className={TH_NUM}>Under · on · over the grade</th>
            </tr>
          </thead>
          <tbody>
            {value.rows.map((row) => (
              <tr key={row.label} className="border-b border-slate-100 last:border-b-0">
                <td className={TD}>{row.label}</td>
                <td className={TD_NUM}>{intFmt.format(row.customers)}</td>
                <td className={TD_NUM}>{target(row.target)}</td>
                <td className={TD_NUM}>{oneDecimal.format(row.averageVisits)}</td>
                <td className={TD_NUM}>
                  {row.target === null
                    ? "No target set"
                    : `${intFmt.format(row.under)} · ${intFmt.format(row.onTarget)} · ${intFmt.format(row.over)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-3 sm:hidden">
        {value.rows.map((row) => (
          <div key={row.label} className="border border-slate-200 p-3.5">
            <p className="text-sm font-black text-slate-900">{row.label}</p>
            <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2">
              <CardField label="Customers" value={intFmt.format(row.customers)} />
              <CardField label="Target a month" value={target(row.target)} />
              <CardField label="Visits each" value={oneDecimal.format(row.averageVisits)} />
              {row.target === null ? null : (
                <>
                  <CardField label="Under" value={intFmt.format(row.under)} />
                  <CardField label="On" value={intFmt.format(row.onTarget)} />
                  <CardField label="Over" value={intFmt.format(row.over)} />
                </>
              )}
            </dl>
          </div>
        ))}
      </div>
      {value.awaitingValidation > 0 ? (
        <Note>
          {intFmt.format(value.awaitingValidation)} visits this month were to customers not yet validated, so they count in nothing
          yet.
        </Note>
      ) : null}
      {value.leaveUnread ? <Note>HR&apos;s leave could not be read, so a planned customer on a leave day may count against the plan.</Note> : null}
    </>
  );
}

export function CrmFrequencySection({ insight }: { insight: CrmInsight<CrmFrequency> | null }) {
  if (!insight || insight.state === "empty") return null;
  if (insight.state === "unread") {
    return (
      <Shell icon={Repeat} title="Visit frequency by grade">
        <Unread />
      </Shell>
    );
  }
  const value = insight.value;
  const scope =
    value.teamTerritories > value.territories
      ? ` across the ${intFmt.format(value.territories)} most visited of the team's ${intFmt.format(value.teamTerritories)} territories`
      : value.territories > 1
        ? ` across ${intFmt.format(value.territories)} territories of the team`
        : "";
  const sub = `Doctors on the list in ${monthLabel(value.month)}${value.inProgress ? " (month in progress)" : ""}${scope}, against the visits a month their grade asks for. Over the number is a deviation too, never a bonus.`;
  return (
    <Shell icon={Repeat} title="Visit frequency by grade" sub={sub}>
      <FrequencyBody value={value} />
    </Shell>
  );
}

/** Both sections, each drawn only when the section plan says so. */
export function Employee360CrmInsightsSections({
  insights,
  showPlanCompliance,
  showFrequency,
}: {
  insights: Employee360CrmInsights | null | undefined;
  showPlanCompliance: boolean;
  showFrequency: boolean;
}) {
  if (!insights) return null;
  return (
    <>
      {showPlanCompliance ? <CrmPlanComplianceSection insight={insights.planCompliance} /> : null}
      {showFrequency ? <CrmFrequencySection insight={insights.frequency} /> : null}
    </>
  );
}
