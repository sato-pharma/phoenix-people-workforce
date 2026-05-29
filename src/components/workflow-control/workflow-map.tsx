"use client";

import { ArrowDown } from "lucide-react";

import type { WorkflowControlStep } from "@/lib/workflow-control/definitions";

function FieldList({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#F97316]">{label}</p>
      <ul className="mt-0.5 space-y-0.5">
        {values.map((value) => (
          <li key={value} className="text-[12px] leading-5 text-[#334155]">
            {value}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Read-only boxes-and-arrows map of a subflow. Each node surfaces the step
 * actor/role, the status it produces, notification + email recipients,
 * fallback/escalation and module side effects.
 */
export function WorkflowMap({ steps }: { steps: readonly WorkflowControlStep[] }) {
  if (!steps.length) {
    return <p className="text-sm text-[#64748B]">No steps mapped for this subflow.</p>;
  }
  return (
    <div className="flex flex-col items-stretch gap-0">
      {steps.map((step, index) => (
        <div key={step.id} className="flex flex-col items-center">
          <div className="w-full rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Step {index + 1}</p>
                <p className="mt-0.5 text-sm font-black text-[#0F172A]">{step.name}</p>
              </div>
              <span className="shrink-0 rounded-full bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold text-[#475569]">
                → {step.statusProduced}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#F97316]">Actor / Role</p>
                <p className="mt-0.5 text-[12px] font-semibold leading-5 text-[#0F172A]">{step.actor}</p>
                <p className="text-[12px] leading-5 text-[#64748B]">{step.role}</p>
              </div>
              <FieldList label="Notifications" values={step.notificationRecipients} />
              <FieldList label="Emails" values={step.emailRecipients} />
              {step.fallbackEscalation ? (
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#F97316]">Fallback / escalation</p>
                  <p className="mt-0.5 text-[12px] leading-5 text-[#334155]">{step.fallbackEscalation}</p>
                </div>
              ) : null}
            </div>

            {step.sideEffects ? (
              <div className="mt-3 rounded-lg bg-[#F8FAFC] px-3 py-2">
                <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Side effects</p>
                <p className="mt-0.5 text-[12px] leading-5 text-[#475569]">{step.sideEffects}</p>
              </div>
            ) : null}
          </div>

          {index < steps.length - 1 ? (
            <ArrowDown className="my-1.5 h-5 w-5 text-[#CBD5E1]" aria-hidden="true" />
          ) : null}
        </div>
      ))}
    </div>
  );
}
