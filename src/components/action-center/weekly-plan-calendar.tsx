// Read-only day-by-day plan calendar. Extracted verbatim from action-center-hub.tsx so the
// combined Action Center inbox AND the new Approvals Hub plan pages render the exact same
// week/month grid from one source (no divergence). Pure render (no client hooks), so it works in
// both server components (the new plan detail page) and client components (the inbox).
import type { WeeklyPlanDetail } from "@/components/action-center/types";

const PLAN_ACTIVITY_COLORS: Record<string, string> = {
  Field: "bg-sky-50 text-sky-800 border-sky-200",
  "Double Visit": "bg-violet-50 text-violet-800 border-violet-200",
  Training: "bg-amber-50 text-amber-900 border-amber-200",
  Meeting: "bg-teal-50 text-teal-800 border-teal-200",
  Event: "bg-rose-50 text-rose-800 border-rose-200",
  Travel: "bg-orange-50 text-orange-800 border-orange-200",
  Office: "bg-slate-50 text-slate-700 border-slate-200",
  Admin: "bg-slate-50 text-slate-700 border-slate-200",
  Remote: "bg-indigo-50 text-indigo-800 border-indigo-200",
  Vacation: "bg-emerald-50 text-emerald-800 border-emerald-200",
  Other: "bg-slate-50 text-slate-700 border-slate-200",
};
const PLAN_COACHING_COLOR = "bg-fuchsia-50 text-fuchsia-800 border-fuchsia-200";

function planDayParts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return {
    weekday: dt.toLocaleDateString("en", { weekday: "short", timeZone: "UTC" }),
    dayNumber: dt.toLocaleDateString("en", { day: "2-digit", timeZone: "UTC" }),
    month: dt.toLocaleDateString("en", { month: "short", timeZone: "UTC" }),
  };
}

function planDaysInPeriod(startIso: string, endIso: string): string[] {
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1);
  };
  const out: string[] = [];
  let cur = toUtc(startIso);
  const end = toUtc(endIso);
  for (let guard = 0; cur <= end && guard < 400; guard += 1) {
    const dt = new Date(cur);
    out.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`);
    cur += 86_400_000;
  }
  return out;
}

function PlanActivityCard({ item }: { item: WeeklyPlanDetail["items"][number] }) {
  const color = item.isCoaching ? PLAN_COACHING_COLOR : PLAN_ACTIVITY_COLORS[item.activityType] ?? PLAN_ACTIVITY_COLORS.Other;
  const geo = item.activityType === "Training"
    ? (item.region ? `Format: ${item.region}` : null)
    : [item.region, item.area].filter(Boolean).join(" · ") || null;
  return (
    <div className="space-y-1">
      <div className={`rounded-md border px-2 py-1.5 ${color}`}>
        <div className="flex items-start justify-between gap-1.5">
          <span className="text-[11px] font-bold leading-tight">{item.activityLabel}</span>
          {item.timeLabel && <span className="shrink-0 text-[10px] font-semibold opacity-70">{item.timeLabel}</span>}
        </div>
        {geo && <p className="mt-0.5 text-[10px] font-medium opacity-90">{geo}</p>}
        {item.repName && <p className="text-[10px] opacity-80">with {item.repName}</p>}
        {item.objective && <p className="mt-0.5 text-[10px] italic leading-snug opacity-75">{item.objective}</p>}
      </div>
      {item.activityType === "Field" && item.visitDetails.length > 0 && (
        <div className="ml-1 space-y-1 border-l-2 border-sky-300 pl-2">
          {item.visitDetails.map((vd, idx) => (
            <div key={vd.id ?? idx} className="rounded border border-sky-200 bg-sky-50 px-2 py-1">
              <p className="text-[10px] font-black text-sky-900">{vd.doctorName}</p>
              <p className="text-[10px] font-semibold text-sky-700">
                <span className="rounded-full bg-sky-200 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-sky-800">
                  {vd.speciality}
                </span>
                {" · "}{vd.address}
              </p>
              {vd.objective && <p className="mt-0.5 text-[10px] italic text-sky-600">{vd.objective}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WeeklyPlanCalendar({ detail }: { detail: WeeklyPlanDetail }) {
  const byDate = new Map<string, WeeklyPlanDetail["items"]>();
  for (const item of detail.items) {
    const bucket = byDate.get(item.activityDate);
    if (bucket) bucket.push(item);
    else byDate.set(item.activityDate, [item]);
  }

  // Weekly: show the full period as a true week grid (empty days included).
  // Monthly: agenda of only the days that actually carry activities.
  const days = detail.planKind === "weekly"
    ? planDaysInPeriod(detail.periodStartDate, detail.periodEndDate)
    : Array.from(byDate.keys()).sort((a, b) => a.localeCompare(b));

  const start = planDayParts(detail.periodStartDate);
  const end = planDayParts(detail.periodEndDate);
  const rangeLabel = `${start.weekday} ${start.month} ${start.dayNumber} – ${end.weekday} ${end.month} ${end.dayNumber}`;
  const gridClass = detail.planKind === "weekly"
    ? "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
    : "grid grid-cols-1 gap-2 sm:grid-cols-2";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-black text-slate-900">
            {detail.planKind === "weekly" ? "Weekly plan" : "Monthly plan"} · {detail.periodKey}
          </p>
          <p className="text-[11px] text-slate-500">
            {rangeLabel} · {detail.itemCount} activit{detail.itemCount === 1 ? "y" : "ies"} ·{" "}
            {detail.stage === "manager" ? "Manager review" : "CEO approval"}
          </p>
          {(detail.employeeJobTitle || detail.managerName) && (
            <p className="mt-0.5 text-[11px] text-slate-400">
              {detail.employeeJobTitle ? `Submitter: ${detail.employeeJobTitle}` : null}
              {detail.employeeJobTitle && detail.managerName ? " · " : null}
              {detail.managerName ? `Manager: ${detail.managerName}` : null}
            </p>
          )}
        </div>
        <a
          href={detail.reviewHref}
          className="shrink-0 rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 transition-colors hover:border-orange-300 hover:text-orange-600"
        >
          Open in full planner ↗
        </a>
      </div>

      {days.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white py-6 text-center text-xs text-slate-400">
          This plan has no activities yet.
        </p>
      ) : (
        <div className={gridClass}>
          {days.map((day) => {
            const parts = planDayParts(day);
            const dayItems = byDate.get(day) ?? [];
            return (
              <div key={day} className="flex flex-col rounded-lg border border-slate-200 bg-white p-2">
                <div className="mb-1.5 flex items-baseline justify-between border-b border-slate-100 pb-1">
                  <span className="text-[11px] font-black uppercase tracking-wide text-slate-700">{parts.weekday}</span>
                  <span className="text-[10px] font-bold text-slate-400">{parts.dayNumber} {parts.month}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {dayItems.length === 0 ? (
                    <p className="py-2 text-center text-[10px] text-slate-300">No activity</p>
                  ) : (
                    dayItems.map((item, idx) => <PlanActivityCard key={`${day}-${idx}`} item={item} />)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
