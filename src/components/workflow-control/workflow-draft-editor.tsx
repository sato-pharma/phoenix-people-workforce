"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Lock, Play, ShieldCheck, X } from "lucide-react";

import type { WorkflowControlStep } from "@/lib/workflow-control/definitions";
import {
  applyDraftToSteps,
  validateWorkflowDraft,
  type WorkflowDraft,
  type WorkflowDraftValidation,
  type WorkflowStepDraftOverride,
} from "@/lib/workflow-control/draft";
import { simulateWorkflow, type WorkflowSimulationResult } from "@/lib/workflow-control/simulator";

const input = "w-full rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-[13px] text-[#0F172A] outline-none focus:border-[#F97316]";
const label = "text-[10px] font-black uppercase tracking-[0.10em] text-[#64748B]";
const current = "mt-0.5 text-[11px] text-[#94A3B8]";

/**
 * Phase 2A Controlled Draft Editor (CLIENT-ONLY).
 *
 * Edits SAFE display/config fields of a subflow's steps in local React state,
 * shows Current vs Draft, validates, and simulates the draft read-only. It does
 * NOT persist, call any API, change runtime behavior, or publish. Save/Publish
 * are intentionally disabled (Phase 3).
 */
export function WorkflowDraftEditor({
  domainKey,
  domainName,
  subflowKey,
  subflowName,
  steps,
  onClose,
}: {
  domainKey: string;
  domainName: string;
  subflowKey: string;
  subflowName: string;
  steps: readonly WorkflowControlStep[];
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<WorkflowDraft>({});
  const [validation, setValidation] = useState<WorkflowDraftValidation | null>(null);
  const [simResult, setSimResult] = useState<WorkflowSimulationResult | null>(null);
  const [employeeHrId, setEmployeeHrId] = useState("");
  const [managerHrId, setManagerHrId] = useState("");

  function setField<K extends keyof WorkflowStepDraftOverride>(stepId: string, key: K, value: WorkflowStepDraftOverride[K]) {
    setDraft((d) => ({ ...d, [stepId]: { ...d[stepId], [key]: value } }));
    setValidation(null);
    setSimResult(null);
  }

  function runValidate() {
    setValidation(validateWorkflowDraft(steps, draft));
  }

  function runSimulate() {
    const draftSteps = applyDraftToSteps(steps, draft);
    setSimResult(
      simulateWorkflow({
        domainKey,
        subflowKey,
        overrideSteps: draftSteps,
        employeeHrId: employeeHrId.trim() || undefined,
        managerHrId: managerHrId.trim() || undefined,
      }),
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="my-6 w-full max-w-3xl rounded-2xl border border-[#E2E8F0] bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#E2E8F0] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-black text-[#0F172A]">Draft Editor — Phase 2A</h2>
            <p className="text-xs text-[#64748B]">
              {domainName} · <span className="font-semibold">{subflowName}</span>
            </p>
          </div>
          <button aria-label="Close" className="rounded-lg p-1 text-[#64748B] hover:bg-[#F8FAFC]" onClick={onClose} type="button">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Safety banner */}
        <div className="mx-5 mt-4 flex items-start gap-2 rounded-xl border border-[#FED7AA] bg-[#FFF7ED] px-4 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#C2410C]" />
          <p className="text-[13px] leading-5 text-[#9A3412]">
            <span className="font-black">This draft does not change live workflow behavior.</span> Edits stay in your
            browser only — no data is saved and nothing runs.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
          <button className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-bold text-[#0F172A] hover:bg-[#F8FAFC]" onClick={runValidate} type="button">
            <CheckCircle2 className="h-4 w-4" /> Validate Draft
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-lg bg-[#F97316] px-3 py-2 text-sm font-black text-white hover:bg-[#EA580C]" onClick={runSimulate} type="button">
            <Play className="h-4 w-4" /> Simulate Draft
          </button>
          <button
            className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm font-bold text-[#94A3B8]"
            disabled
            title="Persistence comes in Phase 3"
            type="button"
          >
            <Lock className="h-4 w-4" /> Save Draft <span className="font-normal">(Persistence comes in Phase 3)</span>
          </button>
          <button
            className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm font-bold text-[#94A3B8]"
            disabled
            title="Publishing requires Phase 3 versioning and approval."
            type="button"
          >
            <Lock className="h-4 w-4" /> Publish
          </button>
        </div>
        <p className="px-5 pt-1.5 text-[11px] text-[#94A3B8]">Publishing requires Phase 3 versioning and approval.</p>

        {/* Validation result */}
        {validation ? (
          <div className="mx-5 mt-3 rounded-xl border border-[#E2E8F0] p-3">
            <p className={`text-[11px] font-black uppercase tracking-[0.10em] ${validation.status === "valid" ? "text-[#047857]" : "text-[#C2410C]"}`}>
              Validation: {validation.status === "valid" ? "Valid" : "Warnings"}
            </p>
            {validation.warnings.length ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {validation.warnings.map((w) => (
                  <li key={w} className="text-[12px] leading-5 text-[#9A3412]">{w}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[12px] text-[#475569]">All edited fields look fine.</p>
            )}
            <p className="mt-2 text-[10px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Blocked fields (not editable in Phase 2A)</p>
            <p className="mt-0.5 text-[11px] leading-5 text-[#64748B]">{validation.blockedFields.join(" · ")}</p>
          </div>
        ) : null}

        {/* Draft simulation result */}
        {simResult ? (
          <div className="mx-5 mt-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3">
            <p className="text-[11px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">
              Draft simulation · {simResult.domainName} → {simResult.subflowName}
            </p>
            {simResult.routePath.length ? (
              <p className="mt-1 text-[12px] text-[#475569]"><span className="font-bold">Route path</span> {simResult.routePath.join(" → ")}</p>
            ) : null}
            <p className="mt-1 text-[12px] font-black text-[#0F172A]">Final status: <span className="text-[#C2410C]">{simResult.finalStatus}</span></p>
            {simResult.warnings.length ? (
              <div className="mt-1 flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#C2410C]" />
                <p className="text-[11px] leading-5 text-[#9A3412]">{simResult.warnings.join(" · ")}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Draft simulation inputs */}
        <div className="grid grid-cols-1 gap-3 px-5 pt-3 sm:grid-cols-2">
          <label className="block">
            <span className={label}>Employee HR_ID (for draft simulation)</span>
            <input className={input} value={employeeHrId} onChange={(e) => setEmployeeHrId(e.target.value)} placeholder="e.g. B-52" />
          </label>
          <label className="block">
            <span className={label}>Direct manager HR_ID</span>
            <input className={input} value={managerHrId} onChange={(e) => setManagerHrId(e.target.value)} placeholder="blank = test missing manager" />
          </label>
        </div>

        {/* Editable step list */}
        <div className="space-y-3 p-5">
          <p className="text-[11px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Editable steps (safe fields only)</p>
          {steps.map((step, index) => {
            const o = draft[step.id] ?? {};
            const notifEnabled = o.notificationEnabled ?? step.notificationRecipients.length > 0;
            const emailEnabled = o.emailEnabled ?? step.emailRecipients.length > 0;
            return (
              <div key={step.id} className="rounded-xl border border-[#E2E8F0] p-3">
                <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">
                  Step {index + 1} · <span className="text-[#475569]">{step.actor} / {step.role}</span> · → {step.statusProduced}
                </p>

                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={label}>Display name</span>
                    <input className={input} value={o.name ?? step.name} onChange={(e) => setField(step.id, "name", e.target.value)} />
                  </label>
                  <label className="block">
                    <span className={label}>Description</span>
                    <input className={input} value={o.description ?? ""} onChange={(e) => setField(step.id, "description", e.target.value)} placeholder="optional" />
                  </label>
                  <label className="block">
                    <span className={label}>Action label</span>
                    <input className={input} value={o.actionLabel ?? ""} onChange={(e) => setField(step.id, "actionLabel", e.target.value)} placeholder="e.g. Review request" />
                  </label>
                  <label className="block">
                    <span className={label}>Reminder days</span>
                    <input className={input} value={o.reminderDays ?? ""} onChange={(e) => setField(step.id, "reminderDays", e.target.value)} placeholder="e.g. 7" inputMode="numeric" />
                  </label>
                  <label className="block">
                    <span className={label}>Action-required recipients label</span>
                    <input className={input} value={o.actionRequiredLabel ?? ""} onChange={(e) => setField(step.id, "actionRequiredLabel", e.target.value)} placeholder="label only" />
                    {step.actionRequiredRecipients?.length ? <p className={current}>Current: {step.actionRequiredRecipients.join(", ")}</p> : null}
                  </label>
                  <label className="block">
                    <span className={label}>FYI recipients label</span>
                    <input className={input} value={o.fyiLabel ?? ""} onChange={(e) => setField(step.id, "fyiLabel", e.target.value)} placeholder="label only" />
                    {step.fyiRecipients?.length ? <p className={current}>Current: {step.fyiRecipients.join(", ")}</p> : null}
                  </label>
                  <label className="block">
                    <span className={label}>Escalation / fallback label</span>
                    <input className={input} value={o.escalationLabel ?? ""} onChange={(e) => setField(step.id, "escalationLabel", e.target.value)} placeholder="label only" />
                    {step.fallbackEscalation ? <p className={current}>Current: {step.fallbackEscalation}</p> : null}
                  </label>
                  <label className="block">
                    <span className={label}>Known gap note</span>
                    <input className={input} value={o.knownGap ?? ""} onChange={(e) => setField(step.id, "knownGap", e.target.value)} placeholder="optional" />
                    {step.knownGap ? <p className={current}>Current: {step.knownGap}</p> : null}
                  </label>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={notifEnabled} onChange={(e) => setField(step.id, "notificationEnabled", e.target.checked)} />
                    <span className="text-[12px] font-semibold text-[#334155]">In-app notifications enabled</span>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={emailEnabled} onChange={(e) => setField(step.id, "emailEnabled", e.target.checked)} />
                    <span className="text-[12px] font-semibold text-[#334155]">Email enabled</span>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={o.optional ?? false} onChange={(e) => setField(step.id, "optional", e.target.checked)} />
                    <span className="text-[12px] font-semibold text-[#334155]">Mark optional (display only)</span>
                  </label>
                </div>
              </div>
            );
          })}
          <p className="text-[11px] leading-5 text-[#94A3B8]">
            Approval roles, runtime execution, payroll, security/RLS, access and data changes are <span className="font-bold">not editable</span> here — Phase 2A is display/config only.
          </p>
        </div>
      </div>
    </div>
  );
}
