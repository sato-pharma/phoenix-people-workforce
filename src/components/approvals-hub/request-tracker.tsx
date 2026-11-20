import type { ApprovalTimelineStep } from "@/lib/approvals-hub/service";
import { SlaAgeBadge, type ApprovalsSlaModule } from "@/components/approvals-hub/sla-badge";
import { LANDING_INK, LandingEmpty, LandingPanel } from "@/components/employee-portal/landing-kit";

type Props = {
  steps: ApprovalTimelineStep[];
  stageLabel?: string | null;
  ageDays?: number | null;
  // When there are no per-step rows (e.g. legacy sick leave), show a single-line status instead.
  fallbackStatusLabel?: string | null;
  slaModule: ApprovalsSlaModule;
};

// The kit's language: each step a 4px rail and its state in coloured small capitals. The step
// waiting now is navy; a later step still to come is slate.
function stepTone(status: string): { rail: string; text: string; label: string } {
  const s = status.toLowerCase();
  if (/(approv|acknowledg|accept)/.test(s)) return { rail: "bg-emerald-500", text: "text-emerald-700", label: "Approved" };
  if (/(reject|declin|denied)/.test(s)) return { rail: "bg-rose-500", text: "text-rose-700", label: "Rejected" };
  if (/(return|sent_back)/.test(s)) return { rail: "bg-amber-500", text: "text-amber-700", label: "Returned" };
  if (/pending/.test(s)) return { rail: "bg-slate-300", text: "text-slate-500", label: "Pending" };
  return { rail: "bg-slate-300", text: "text-slate-500", label: status || "—" };
}

function stepTitle(step: ApprovalTimelineStep): string {
  if (step.stepKey === "submitted") return "Submitted";
  if (step.stepKey === "hr") return "HR Acknowledgement";
  if (step.approverTitle) return `${step.approverTitle} Approval`;
  if (step.stepKey === "direct_manager") return "Direct Manager";
  if (step.stepKey === "manager_of_manager") return "Manager of Manager";
  if (step.stepKey === "manager_level_3") return "Third Management Approval";
  return "Management Approval";
}

export function RequestTracker({ steps, stageLabel, ageDays, fallbackStatusLabel, slaModule }: Props) {
  const activeIndex = steps.findIndex((s) => s.status.toLowerCase() === "pending");

  return (
    <LandingPanel
      title="Approval tracker"
      right={typeof ageDays === "number" ? <SlaAgeBadge ageDays={ageDays} module={slaModule} /> : null}
    >
      {stageLabel ? (
        <p className="border-b border-slate-200 px-3 py-2 text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500 sm:px-4">
          Current stage: <span className={LANDING_INK}>{stageLabel}</span>
        </p>
      ) : null}

      {steps.length === 0 ? (
        <LandingEmpty>{fallbackStatusLabel ?? "No approval steps recorded yet."}</LandingEmpty>
      ) : (
        <ol className="divide-y divide-slate-200">
          {steps.map((step, i) => {
            const tone = stepTone(step.status);
            const isActive = i === activeIndex;
            return (
              <li key={`${step.stepKey}-${step.order}-${i}`} className="flex min-w-0 gap-3 px-3 py-2.5 sm:px-4">
                <span className={`w-1 shrink-0 self-stretch ${isActive ? "bg-[#08111f]" : tone.rail}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className={`break-words text-sm font-bold ${LANDING_INK}`}>{stepTitle(step)}</p>
                    <span className={`text-phx-xs font-black uppercase tracking-[0.1em] ${isActive ? LANDING_INK : tone.text}`}>
                      {isActive ? "Current" : tone.label}
                    </span>
                  </div>
                  <p className="break-words text-xs text-slate-600" dir="auto">
                    {step.approverName ? step.approverName : step.approverTitle ?? "Unassigned"}
                    {step.decidedAt ? ` · ${new Date(step.decidedAt).toLocaleDateString("en-GB")}` : ""}
                  </p>
                  {step.decisionComment ? (
                    <p className="mt-1 whitespace-pre-line break-words border-l-2 border-slate-300 pl-2 text-xs italic text-slate-600" dir="auto">
                      “{step.decisionComment}”
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </LandingPanel>
  );
}
