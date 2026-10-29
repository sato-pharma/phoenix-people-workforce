// One person's day in the private calendar: the approved plan beside what was recorded, one row per planned half-day,
// with a ✓ or ✗ (owner, 2026-10-29: "put in a table, put each point beside the point"). The rows come from
// buildDayPlanActual (lib/private-calendar/plan-actual.ts); this file only draws them.
//
// A table while its own box is wide enough for three columns, a stack of plain cards below that — never a horizontal
// scroll. Square edges, plain ink: the ✓ is green text, the ✗ red text, and "Not on the plan" slate, never a fill.

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { DAY_PLAN_ACTUAL_NOT_ON_PLAN, type DayPlanActualRow } from "@/lib/private-calendar/plan-actual";
import { cn } from "@/lib/utils";

const TH_CLASS =
  "border-b border-slate-200 border-t-2 border-t-slate-900 bg-slate-50 px-3 py-2.5 align-bottom text-left text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";

const MARK_CLASS: Record<DayPlanActualRow["match"], string> = {
  match: "text-emerald-700",
  miss: "text-rose-700",
  unplanned: "text-slate-500",
};

function markText(row: DayPlanActualRow): string {
  if (row.match === "match") return "✓ As planned";
  if (row.match === "miss") return `✗ ${row.note ?? "Not as planned"}`;
  return DAY_PLAN_ACTUAL_NOT_ON_PLAN;
}

function HalfText({ half }: { half: DayPlanActualRow["half"] }) {
  return <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{half}</p>;
}

function PlanCell({ row }: { row: DayPlanActualRow }) {
  const plan = row.plan;
  if (!plan) return <p className="text-sm font-semibold text-slate-400">—</p>;
  const withLine = plan.withName && !plan.label.toLowerCase().includes(plan.withName.toLowerCase()) ? `With ${plan.withName}` : null;
  return (
    <div className="grid min-w-0 gap-0.5">
      <p className="break-words text-sm font-bold text-slate-900">{plan.label}</p>
      {withLine ? <p className="break-words text-sm font-semibold text-slate-700">{withLine}</p> : null}
      {plan.place ? <p className="break-words text-xs font-semibold text-slate-500">{plan.place}</p> : null}
      {plan.signedOffBy ? <p className="break-words text-xs font-medium text-slate-500">Signed off by {plan.signedOffBy}</p> : null}
    </div>
  );
}

function ActualCell({ row }: { row: DayPlanActualRow }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      {row.actual.map((line) => (
        <p className="break-words text-sm font-semibold text-slate-800" key={line}>{line}</p>
      ))}
      <p className={cn("break-words text-xs font-black", MARK_CLASS[row.match])}>{markText(row)}</p>
    </div>
  );
}

export function DayPlanActualTable({ rows }: { rows: readonly DayPlanActualRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="@container grid min-w-0 gap-2" data-testid="private-calendar-plan-actual">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">Plan | Actual</p>

      <div className="hidden min-w-0 @min-[560px]:block">
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <colgroup>
            <col style={{ width: "16%" }} />
            <col style={{ width: "42%" }} />
            <col style={{ width: "42%" }} />
          </colgroup>
          <thead>
            <tr>
              <th className={TH_CLASS}>Half</th>
              <th className={TH_CLASS}>Plan</th>
              <th className={TH_CLASS}>Actual</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr className={cn("align-top", index % 2 === 0 ? "bg-white" : "bg-slate-50/60")} key={row.key}>
                <td className="border-b border-slate-100 px-3 py-3 align-top"><HalfText half={row.half} /></td>
                <td className="border-b border-slate-100 px-3 py-3 align-top"><PlanCell row={row} /></td>
                <td className="border-b border-slate-100 px-3 py-3 align-top"><ActualCell row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid min-w-0 gap-2 @min-[560px]:hidden">
        {rows.map((row) => (
          <article className={`grid min-w-0 gap-2 border border-slate-200 bg-white px-3 py-3 ${adminSoftDepthClassName}`} key={row.key}>
            <HalfText half={row.half} />
            <div className="grid min-w-0 gap-1">
              <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Plan</p>
              <PlanCell row={row} />
            </div>
            <div className="grid min-w-0 gap-1 border-t border-slate-100 pt-2">
              <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Actual</p>
              <ActualCell row={row} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
