import type { ApprovalTimelineStep } from "@/lib/approvals-hub/service";
import { SlaAgeBadge, type ApprovalsSlaModule } from "@/components/approvals-hub/sla-badge";

type Props = {
  steps: ApprovalTimelineStep[];
  stageLabel?: string | null;
  ageDays?: number | null;
  // When there are no per-step rows (e.g. legacy sick leave), show a single-line status instead.
  fallbackStatusLabel?: string | null;
  slaModule: ApprovalsSlaModule;
};

function stepTone(status: string): { dot: string; ring: string; text: string; label: string } {
  const s = status.toLowerCase();
  if (/(approv|acknowledg|accept)/.test(s)) return { dot: "bg-emerald-500", ring: "ring-emerald-200", text: "text-emerald-700", label: "Approved" };
  if (/(reject|declin|denied)/.test(s)) return { dot: "bg-rose-500", ring: "ring-rose-200", text: "text-rose-700", label: "Rejected" };
  if (/(return|sent_back)/.test(s)) return { dot: "bg-amber-500", ring: "ring-amber-200", text: "text-amber-700", label: "Returned" };
  if (/pending/.test(s)) return { dot: "bg-orange-500", ring: "ring-orange-200", text: "text-orange-700", label: "Pending" };
  return { dot: "bg-slate-300", ring: "ring-slate-100", text: "text-slate-500", label: status || "—" };
}

function stepTitle(step: ApprovalTimelineStep): string {
  if (step.stepKey === "submitted") return "Submitted";
  if (step.stepKey === "hr") return "HR Acknowledgement";
  if (step.approverTitle) return `${step.approverTitle} Approval`;
  if (step.stepKey === "direct_manager") return "Direct Manager";
  if (step.stepKey === "manager_of_manager") return "Manager of Manager";
  return "Management Approval";
}

export function RequestTracker({ steps, stageLabel, ageDays, fallbackStatusLabel, slaModule }: Props) {
  const activeIndex = steps.findIndex((s) => s.status.toLowerCase() === "pending");

  return (
    <section className="border border-[#e4e9ec] bg-white">
      <header className="flex items-center justify-between border-b border-[#e4e9ec] bg-slate-900 px-4 py-2.5">
        <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">Approval tracker</h3>
        {typeof ageDays === "number" ? <SlaAgeBadge ageDays={ageDays} module={slaModule} /> : null}
      </header>

      <div className="px-4 py-4">
        {stageLabel ? (
          <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">
            Current stage: <span className="text-slate-900">{stageLabel}</span>
          </p>
        ) : null}

        {steps.length === 0 ? (
          <p className="text-sm text-slate-600">{fallbackStatusLabel ?? "No approval steps recorded yet."}</p>
        ) : (
          <ol className="space-y-0">
            {steps.map((step, i) => {
              const tone = stepTone(step.status);
              const isActive = i === activeIndex;
              const isLast = i === steps.length - 1;
              return (
                <li key={`${step.stepKey}-${step.order}-${i}`} className="relative flex gap-3 pb-4">
                  {!isLast ? <span className="absolute left-[7px] top-4 h-full w-px bg-slate-200" aria-hidden /> : null}
                  <span
                    className={`relative z-10 mt-1 h-3.5 w-3.5 shrink-0 rounded-full ${tone.dot} ${isActive ? `ring-4 ${tone.ring}` : ""}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="text-sm font-bold text-slate-900">{stepTitle(step)}</p>
                      <span className={`text-[11px] font-bold uppercase tracking-wide ${tone.text}`}>
                        {isActive ? "Current" : tone.label}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">
                      {step.approverName ? step.approverName : step.approverTitle ?? "Unassigned"}
                      {step.decidedAt ? ` · ${new Date(step.decidedAt).toLocaleDateString("en-GB")}` : ""}
                    </p>
                    {step.decisionComment ? (
                      <p className="mt-1 border-l-2 border-slate-200 pl-2 text-xs italic text-slate-600">
                        “{step.decisionComment}”
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
