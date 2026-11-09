import type { LineTopAchieversGroup } from "@/lib/employee-portal/service";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/** Achievement-percentage → text color, matching the Medical Reps Performance page. */
function achievementColor(pct: number): string {
  if (pct >= 100) return "text-emerald-700";
  if (pct >= 90) return "text-emerald-600";
  if (pct >= 70) return "text-amber-600";
  return "text-red-600";
}

/**
 * "Top Achievers · Per Line" — the top medical reps by sales achievement for
 * each line in that line's latest PUBLISHED monthly closing, with the month printed on the line. Server
 * component (static), framed in the portal's premium design language. Renders
 * nothing when there is no achievement data.
 */
export function LineTopAchieversCard({
  groups,
  title = "Top Achievers · Per Line",
}: {
  groups: LineTopAchieversGroup[];
  title?: string;
}) {
  if (groups.length === 0) return null;

  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`} role="region" aria-label="Top medical rep achievers per line">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-300">{title}</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>
      <div className="divide-y divide-slate-200">
        {groups.map((group) => (
          <div key={group.lineName} className="px-4 py-3 sm:px-5">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p className="whitespace-nowrap text-phx-xs font-bold uppercase tracking-wider text-orange-600">
                {group.lineName}
              </p>
              <p className="whitespace-nowrap text-phx-xs font-semibold text-slate-500">
                {group.periodLabel} closing
              </p>
            </div>
            <ol className="divide-y divide-slate-100">
              {group.achievers.map((achiever, index) => (
                <li key={achiever.hrId} className="flex items-center gap-3 py-2">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center text-xs font-black ${
                      index === 0 ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-bold leading-snug text-slate-900">{achiever.name}</p>
                    <p className="break-words text-phx-xs leading-snug text-slate-400">{achiever.areaName ?? "—"}</p>
                  </div>
                  <span className={`whitespace-nowrap text-base font-black tabular-nums ${achievementColor(achiever.achievementPercent)}`}>
                    {achiever.achievementPercent.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
