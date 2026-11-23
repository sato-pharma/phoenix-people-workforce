// Read-only day-by-day plan calendar. Extracted verbatim from action-center-hub.tsx so the
// combined Action Center inbox AND the new Approvals Hub plan pages render the exact same
// week/month grid from one source (no divergence). Pure render (no client hooks), so it works in
// both server components (the new plan detail page) and client components (the inbox).
import type { WeeklyPlanDetail } from "@/components/action-center/types";
import { LANDING_INK, landingActionClassName } from "@/components/employee-portal/landing-kit";

// The kit's language (landing-kit.tsx): an activity's kind is a 3px rail of its colour beside a white
// card, never a tinted box — the words stay navy and slate, so a week of activities reads as one sheet.
const PLAN_ACTIVITY_RAILS: Record<string, string> = {
  Field: "bg-sky-500",
  "Double Visit": "bg-violet-500",
  Training: "bg-amber-500",
  Meeting: "bg-teal-500",
  "Meeting with Team": "bg-cyan-500",
  Event: "bg-rose-500",
  Travel: "bg-stone-500",
  Office: "bg-slate-400",
  Admin: "bg-slate-400",
  Remote: "bg-indigo-500",
  Vacation: "bg-emerald-500",
  Other: "bg-slate-400",
};
const PLAN_COACHING_RAIL = "bg-fuchsia-500";

// DATE-ONLY (a plan day's `activity_date`, a `date` column), which `new Date` parses as UTC midnight.
// UTC here is CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset.
// Not an instant — do not "fix" this one to Cairo.
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
  const rail = item.isCoaching ? PLAN_COACHING_RAIL : PLAN_ACTIVITY_RAILS[item.activityType] ?? PLAN_ACTIVITY_RAILS.Other;
  const geo = item.activityType === "Training"
    ? (item.region ? `Format: ${item.region}` : null)
    : [item.region, item.area].filter(Boolean).join(" · ") || null;
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 border border-slate-200 bg-white">
        <span aria-hidden="true" className={`w-[3px] shrink-0 self-stretch ${rail}`} />
        <div className="min-w-0 flex-1 px-2 py-1.5">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-1.5">
            <span className={`min-w-0 break-words text-phx-xs font-bold leading-tight ${LANDING_INK}`}>{item.activityLabel}</span>
            {item.timeLabel && <span className="shrink-0 text-phx-xs font-semibold tabular-nums text-slate-500">{item.timeLabel}</span>}
          </div>
          {geo && <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-600">{geo}</p>}
          {item.repName && <p className="break-words text-phx-xs text-slate-500" dir="auto">with {item.repName}</p>}
          {item.objective && <p className="mt-0.5 break-words text-phx-xs italic leading-snug text-slate-500">{item.objective}</p>}
        </div>
      </div>
      {item.activityType === "Field" && item.visitDetails.length > 0 && (
        <div className="ml-1 space-y-1 border-l-2 border-sky-300 pl-2">
          {item.visitDetails.map((vd, idx) => (
            <div key={vd.id ?? idx} className="border border-slate-200 bg-white px-2 py-1">
              <p className={`break-words text-phx-xs font-black ${LANDING_INK}`} dir="auto">{vd.doctorName}</p>
              <p className="break-words text-phx-xs font-semibold text-slate-600">
                <span className="font-black uppercase tracking-[0.08em] text-sky-700">
                  {vd.speciality}
                </span>
                {" · "}{vd.address}
              </p>
              {vd.objective && <p className="mt-0.5 break-words text-phx-xs italic text-slate-500">{vd.objective}</p>}
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
  // Container queries, not the viewport: the calendar sits in a narrow detail pane in the inbox and
  // across the full page on a plan's own page, so the columns follow the room it is actually given.
  const gridClass = detail.planKind === "weekly"
    ? "grid grid-cols-2 gap-2 @xl:grid-cols-3 @3xl:grid-cols-5"
    : "grid grid-cols-1 gap-2 @xl:grid-cols-2";

  return (
    <div className="@container">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`break-words text-sm font-black ${LANDING_INK}`}>
            {detail.planKind === "weekly" ? "Weekly plan" : "Monthly plan"} · {detail.periodKey}
          </p>
          <p className="break-words text-phx-xs text-slate-500">
            {rangeLabel} · {detail.itemCount} activit{detail.itemCount === 1 ? "y" : "ies"} ·{" "}
            {detail.stage === "manager" ? "Manager review" : "CEO approval"}
          </p>
          {(detail.employeeJobTitle || detail.managerName) && (
            <p className="mt-0.5 break-words text-phx-xs text-slate-500" dir="auto">
              {detail.employeeJobTitle ? `Submitter: ${detail.employeeJobTitle}` : null}
              {detail.employeeJobTitle && detail.managerName ? " · " : null}
              {detail.managerName ? `Manager: ${detail.managerName}` : null}
            </p>
          )}
        </div>
        <a
          href={detail.reviewHref}
          className={landingActionClassName("outline")}
        >
          Open in full planner ↗
        </a>
      </div>

      {days.length === 0 ? (
        <p className="border border-slate-200 bg-white px-3 py-4 text-phx-sm text-slate-500">
          This plan has no activities yet.
        </p>
      ) : (
        <div className={gridClass}>
          {days.map((day) => {
            const parts = planDayParts(day);
            const dayItems = byDate.get(day) ?? [];
            return (
              <div key={day} className="flex min-w-0 flex-col border border-slate-200 bg-white p-2">
                <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-1 border-b border-slate-200 pb-1">
                  <span className={`text-phx-xs font-black uppercase tracking-[0.1em] ${LANDING_INK}`}>{parts.weekday}</span>
                  <span className="text-phx-xs font-bold tabular-nums text-slate-500">{parts.dayNumber} {parts.month}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {dayItems.length === 0 ? (
                    <p className="py-2 text-center text-phx-xs text-slate-400">No activity</p>
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
