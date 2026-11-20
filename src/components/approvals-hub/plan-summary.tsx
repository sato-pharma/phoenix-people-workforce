import type { PlanComposition, PlanPeriodStatus } from "@/lib/approvals-hub/service";
import { LANDING_INK, LandingEmpty, LandingPanel } from "@/components/employee-portal/landing-kit";

// At-a-glance make-up of a plan, so an approver sees its shape before reading day-by-day.
// Pure render (no client hooks) — usable directly inside the server-rendered detail page.

// Each kind keeps its colour as a small square swatch beside its figure — never a tinted chip.
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
    <LandingPanel
      title="Plan at a glance"
      right={
        <span className="text-phx-xs font-bold uppercase tracking-[0.1em] tabular-nums text-slate-500">
          {composition.total} activit{composition.total === 1 ? "y" : "ies"} · {composition.plannedDays} day
          {composition.plannedDays === 1 ? "" : "s"}
        </span>
      }
    >
      {chips.length === 0 && !showCoverage ? (
        <LandingEmpty>No activities planned.</LandingEmpty>
      ) : (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-3 sm:px-4">
          {chips.length === 0 ? <span className="text-sm text-slate-500">No activities planned.</span> : null}
          {chips.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-700">
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 ${c.dot}`} />
              <span className={`tabular-nums ${LANDING_INK}`}>{composition[c.key]}</span> {c.label}
            </span>
          ))}
          {showCoverage ? (
            <span className="text-phx-xs font-bold uppercase tracking-[0.1em] tabular-nums text-amber-700">
              {composition.emptyDays} of {composition.totalDays} days empty
            </span>
          ) : null}
        </div>
      )}
    </LandingPanel>
  );
}

// The period in coloured small capitals, never a tinted box: sky still to come, navy under way,
// slate gone by.
const PERIOD_BADGE: Record<PlanPeriodStatus, { label: string; cls: string }> = {
  upcoming: { label: "Upcoming period", cls: "text-sky-700" },
  current: { label: "In progress", cls: LANDING_INK },
  past: { label: "Past period", cls: "text-slate-500" },
};

export function PlanPeriodBadge({ status }: { status: PlanPeriodStatus }) {
  const b = PERIOD_BADGE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-phx-xs font-bold uppercase tracking-[0.1em] ${b.cls}`}>
      {status === "current" ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 bg-[#08111f]" /> : null}
      {b.label}
    </span>
  );
}
