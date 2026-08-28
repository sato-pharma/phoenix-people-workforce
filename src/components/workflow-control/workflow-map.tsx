"use client";

import { ArrowDown, BellOff } from "lucide-react";

import type { WorkflowControlStep } from "@/lib/workflow-control/definitions";

function FieldList({ label, values, tone = "default" }: { label: string; values: string[]; tone?: "default" | "action" | "muted" }) {
  if (!values.length) return null;
  const labelColor = tone === "action" ? "text-[#B91C1C]" : tone === "muted" ? "text-phx-ink-faint" : "text-phx-accent";
  return (
    <div className="min-w-0">
      <p className={`text-[10px] font-black uppercase tracking-[0.12em] ${labelColor}`}>{label}</p>
      <ul className="mt-0.5 space-y-0.5">
        {values.map((value) => (
          <li key={value} className="text-[12px] leading-5 text-phx-ink-2">
            {value}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Read-only boxes-and-arrows map of a subflow. Each node surfaces the step
 * actor/role, status produced, in-app + email recipients (action-required vs
 * FYI), fallback/escalation, side effects, and any notification gap / known gap.
 *
 * `compact` renders a slim node (name, status, actor/role, one-line recipients)
 * — used for the Draft Editor's live preview so the same component/logic is reused.
 */
export function WorkflowMap({ steps, compact = false }: { steps: readonly WorkflowControlStep[]; compact?: boolean }) {
  if (!steps.length) {
    return <p className="text-sm text-phx-ink-soft">No steps mapped for this subflow.</p>;
  }
  return (
    <div className="flex flex-col items-stretch gap-0">
      {steps.map((step, index) => (
        <div key={step.id} className="flex flex-col items-center">
          <div className={compact ? "w-full rounded-lg border border-phx-line bg-white p-2.5" : "w-full rounded-xl border border-phx-line bg-white p-4 shadow-sm"}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-black uppercase tracking-[0.12em] text-phx-ink-faint">Step {index + 1}</p>
                <p className={compact ? "mt-0.5 text-[13px] font-bold text-phx-ink" : "mt-0.5 text-sm font-black text-phx-ink"}>{step.name}</p>
              </div>
              <span className="shrink-0 rounded-full bg-phx-paper px-2.5 py-1 text-[11px] font-bold text-phx-ink-2">
                → {step.statusProduced}
              </span>
            </div>

            {step.notificationGap ? (
              <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-[#FEF2F2] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.10em] text-[#B91C1C]">
                <BellOff className="h-3 w-3" /> Notification gap: not implemented yet
              </div>
            ) : null}

            {compact ? (
              <div className="mt-1.5 space-y-0.5">
                <p className="text-[12px] text-phx-ink-2">{step.actor} · <span className="text-phx-ink-faint">{step.role}</span></p>
                {step.notificationRecipients.length ? <p className="text-[11px] text-phx-ink-2">In-app: {step.notificationRecipients.join(", ")}</p> : null}
                {step.emailRecipients.length ? <p className="text-[11px] text-phx-ink-2">Email: {step.emailRecipients.join(", ")}</p> : null}
              </div>
            ) : (
              <>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-phx-accent">Actor / Role</p>
                    <p className="mt-0.5 text-[12px] font-semibold leading-5 text-phx-ink">{step.actor}</p>
                    <p className="text-[12px] leading-5 text-phx-ink-soft">{step.role}</p>
                  </div>
                  <FieldList label="In-app" values={step.notificationRecipients} />
                  <FieldList label="Action required" values={step.actionRequiredRecipients ?? []} tone="action" />
                  <FieldList label="FYI" values={step.fyiRecipients ?? []} tone="muted" />
                  <FieldList label="Email" values={step.emailRecipients} />
                  {step.fallbackEscalation ? (
                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-phx-accent">Fallback / escalation</p>
                      <p className="mt-0.5 text-[12px] leading-5 text-phx-ink-2">{step.fallbackEscalation}</p>
                    </div>
                  ) : null}
                </div>

                {step.sideEffects ? (
                  <div className="mt-3 rounded-lg bg-phx-paper px-3 py-2">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-phx-ink-faint">Side effects</p>
                    <p className="mt-0.5 text-[12px] leading-5 text-phx-ink-2">{step.sideEffects}</p>
                  </div>
                ) : null}

                {step.knownGap ? (
                  <div className="mt-2 rounded-lg border border-[#FEE2E2] bg-[#FEF2F2] px-3 py-2">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#B91C1C]">Known gap</p>
                    <p className="mt-0.5 text-[12px] leading-5 text-[#991B1B]">{step.knownGap}</p>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {index < steps.length - 1 ? (
            <ArrowDown className={compact ? "my-1 h-4 w-4 text-phx-line-strong" : "my-1.5 h-5 w-5 text-phx-line-strong"} aria-hidden="true" />
          ) : null}
        </div>
      ))}
    </div>
  );
}
