import type { LineTopAchieversGroup } from "@/lib/employee-portal/service";

/** Achievement-percentage → text color, matching the Medical Reps Performance page. */
function achievementColor(pct: number): string {
  if (pct >= 100) return "text-emerald-700";
  if (pct >= 90) return "text-emerald-600";
  if (pct >= 70) return "text-amber-600";
  return "text-red-600";
}

/**
 * "Top Achievers · Per Line" — the top medical reps by sales achievement for
 * each line, snapshotted from the Medical Reps Performance data. Server
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
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Top medical rep achievers per line">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">{title}</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>
      <div className="divide-y divide-slate-200">
        {groups.map((group) => (
          <div key={group.lineName} className="px-4 py-3 sm:px-5">
            <p className="mb-2 whitespace-nowrap text-[11px] font-bold uppercase tracking-wider text-orange-600">
              {group.lineName}
            </p>
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
                    <p className="whitespace-nowrap text-sm font-bold text-slate-900">{achiever.name}</p>
                    <p className="whitespace-nowrap text-[11px] text-slate-400">{achiever.areaName ?? "—"}</p>
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
