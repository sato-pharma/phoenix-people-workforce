import type { PlanComposition, PlanPeriodStatus } from "@/lib/approvals-hub/service";

// At-a-glance make-up of a plan, so an approver sees its shape before reading day-by-day.
// Pure render (no client hooks) — usable directly inside the server-rendered detail page.

const CHIP_DEFS: Array<{ key: keyof PlanComposition; label: string; dot: string }> = [
  { key: "field", label: "Field", dot: "bg-sky-500" },
  { key: "doubleVisit", label: "Double visit", dot: "bg-violet-500" },
  { key: "coaching", label: "Coaching", dot: "bg-fuchsia-500" },
  { key: "training", label: "Training", dot: "bg-amber-500" },
  { key: "meeting", label: "Meeting/Event", dot: "bg-teal-500" },
  { key: "admin", label: "Office/Admin", dot: "bg-slate-500" },
  { key: "other", label: "Other", dot: "bg-slate-400" },
];

export function PlanCompositionSummary({ composition }: { composition: PlanComposition }) {
  const chips = CHIP_DEFS.filter((c) => Number(composition[c.key]) > 0);
  const showCoverage = composition.totalDays > 0 && composition.emptyDays > 0;

  return (
    <section className="border border-phx-line bg-white">
      <header className="flex items-center justify-between border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Plan at a glance</h3>
        <span className="text-phx-xs font-bold text-white/70">
          {composition.total} activit{composition.total === 1 ? "y" : "ies"} · {composition.plannedDays} day
          {composition.plannedDays === 1 ? "" : "s"}
        </span>
      </header>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {chips.length === 0 ? (
          <span className="text-sm text-slate-400">No activities planned.</span>
        ) : (
          chips.map((c) => (
            <span
              key={c.key}
              className="inline-flex items-center gap-1.5 border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-700"
            >
              <span className={`h-2 w-2 rounded-full ${c.dot}`} />
              {composition[c.key]} {c.label}
            </span>
          ))
        )}
        {showCoverage ? (
          <span className="inline-flex items-center gap-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-800">
            {composition.emptyDays} of {composition.totalDays} days empty
          </span>
        ) : null}
      </div>
    </section>
  );
}

const PERIOD_BADGE: Record<PlanPeriodStatus, { label: string; cls: string }> = {
  upcoming: { label: "Upcoming period", cls: "border-sky-200 bg-sky-50 text-sky-700" },
  current: { label: "In progress", cls: "border-orange-300 bg-orange-50 text-orange-700" },
  past: { label: "Past period", cls: "border-slate-200 bg-slate-50 text-slate-600" },
};

export function PlanPeriodBadge({ status }: { status: PlanPeriodStatus }) {
  const b = PERIOD_BADGE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap border px-2 py-0.5 text-phx-xs font-bold ${b.cls}`}>
      {status === "current" ? <span className="h-1.5 w-1.5 rounded-full bg-orange-500" /> : null}
      {b.label}
    </span>
  );
}
