"use client";

import { useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Eye, EyeOff, Lock, Play, RotateCcw, ShieldCheck, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { WorkflowControlStep } from "@/lib/workflow-control/definitions";
import {
  buildDraftMapSteps,
  changedFieldKeys,
  defaultOrderIds,
  diffDraftSteps,
  draftHiddenStepNames,
  isOrderChanged,
  moveOrder,
  reorderSteps,
  validateWorkflowDraft,
  type WorkflowDraft,
  type WorkflowDraftValidation,
  type WorkflowStepDraftOverride,
} from "@/lib/workflow-control/draft";
import { simulateWorkflow, type WorkflowSimulationResult } from "@/lib/workflow-control/simulator";

import { WorkflowMap } from "./workflow-map";

const inputBase = "w-full rounded-lg border bg-white px-2.5 py-1.5 text-[13px] text-[#0F172A] outline-none focus:border-[#F97316]";
const label = "text-[10px] font-black uppercase tracking-[0.10em] text-[#64748B]";
const currentNote = "mt-0.5 text-[11px] text-[#94A3B8]";

/**
 * Phase 2A/2B/2C Controlled Draft Builder (CLIENT-ONLY).
 *
 * A simple, safe workflow builder: edit safe display/config fields, reorder
 * steps (Move Up/Down), hide steps from the DRAFT map, see Current-vs-Draft
 * impact, validate, and simulate the draft read-only ("Draft simulation only").
 * It does NOT persist, call any API, change runtime behavior, or publish.
 * Save/Publish are intentionally disabled (Phase 3).
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
  const [orderIds, setOrderIds] = useState<string[]>(() => defaultOrderIds(steps));
  const [validation, setValidation] = useState<WorkflowDraftValidation | null>(null);
  const [simResult, setSimResult] = useState<WorkflowSimulationResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [employeeHrId, setEmployeeHrId] = useState("");
  const [managerHrId, setManagerHrId] = useState("");

  const diff = diffDraftSteps(steps, draft);
  const changedKeys = changedFieldKeys(diff);
  const reordered = isOrderChanged(steps, orderIds);
  const hiddenNames = draftHiddenStepNames(steps, draft);
  const orderedSteps = reorderSteps(steps, orderIds);
  const draftMapSteps = buildDraftMapSteps(steps, draft, orderIds);
  const hasAnyChange = diff.changeCount > 0 || reordered || hiddenNames.length > 0;

  const isChanged = (stepId: string, field: string) => changedKeys.has(`${stepId}::${field}`);
  const fieldCls = (stepId: string, field: string) =>
    cn(inputBase, isChanged(stepId, field) ? "border-[#F97316] bg-[#FFF7ED]" : "border-[#E2E8F0]");

  function setField<K extends keyof WorkflowStepDraftOverride>(stepId: string, key: K, value: WorkflowStepDraftOverride[K]) {
    setDraft((d) => ({ ...d, [stepId]: { ...d[stepId], [key]: value } }));
    setValidation(null);
    setSimResult(null);
  }

  function move(stepId: string, direction: "up" | "down") {
    setOrderIds((ids) => moveOrder(ids, stepId, direction));
    setSimResult(null);
  }

  function resetDraft() {
    setDraft({});
    setOrderIds(defaultOrderIds(steps));
    setValidation(null);
    setSimResult(null);
  }

  function runValidate() {
    setValidation(validateWorkflowDraft(steps, draft));
  }

  function runSimulate() {
    setSimResult(
      simulateWorkflow({
        domainKey,
        subflowKey,
        overrideSteps: buildDraftMapSteps(steps, draft, orderIds),
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
            <span className="font-black">Local preview only — the runtime workflow is unchanged.</span> Nothing is saved,
            published, or run. Save/Persist and Publish/versioning come in Phase 3.
          </p>
        </div>

        {/* Draft impact summary (Current vs Draft) */}
        <div className="mx-5 mt-3 rounded-xl border border-[#E2E8F0] px-4 py-2.5">
          <p className="text-[11px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Draft impact (Current vs Draft)</p>
          {!hasAnyChange ? (
            <p className="mt-0.5 text-[12px] text-[#64748B]">No changes yet — edit a field, reorder, or hide a step to start a draft.</p>
          ) : (
            <ul className="mt-0.5 space-y-0.5 text-[12px] text-[#334155]">
              <li>
                <span className="font-black text-[#C2410C]">{diff.changeCount}</span> field change{diff.changeCount === 1 ? "" : "s"}
                {diff.changedStepNames.length ? <span className="text-[#64748B]"> · {diff.changedStepNames.join(", ")}</span> : null}
              </li>
              <li>Order changed: <span className="font-bold">{reordered ? "Yes" : "No"}</span></li>
              <li>Hidden in draft map: <span className="font-bold">{hiddenNames.length ? hiddenNames.join(", ") : "None"}</span></li>
            </ul>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
          <button className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-bold text-[#0F172A] hover:bg-[#F8FAFC]" onClick={runValidate} type="button">
            <CheckCircle2 className="h-4 w-4" /> Validate Draft
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-lg bg-[#F97316] px-3 py-2 text-sm font-black text-white hover:bg-[#EA580C]" onClick={runSimulate} type="button">
            <Play className="h-4 w-4" /> Simulate Draft
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-bold text-[#475569] hover:bg-[#F8FAFC]" onClick={() => setShowPreview((v) => !v)} type="button">
            <Eye className="h-4 w-4" /> {showPreview ? "Hide" : "Show"} Draft Map
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-bold text-[#64748B] hover:bg-[#F8FAFC] disabled:opacity-50" disabled={!hasAnyChange} onClick={resetDraft} type="button">
            <RotateCcw className="h-4 w-4" /> Reset Draft
          </button>
          <button className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm font-bold text-[#94A3B8]" disabled title="Phase 3 persistence required" type="button">
            <Lock className="h-4 w-4" /> Save Draft <span className="font-normal">(Phase 3 persistence required)</span>
          </button>
          <button className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm font-bold text-[#94A3B8]" disabled title="Phase 3 versioning + approval required" type="button">
            <Lock className="h-4 w-4" /> Publish
          </button>
        </div>
        <p className="px-5 pt-1.5 text-[11px] text-[#94A3B8]">
          Reorder/visibility/edits are <span className="font-bold">draft preview only</span>. Save Draft →{" "}
          <span className="font-bold">Phase 3 persistence required</span>. Publish → <span className="font-bold">Phase 3 versioning + approval required</span>.
        </p>

        {/* Draft map preview */}
        {showPreview ? (
          <div className="mx-5 mt-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3">
            <p className="text-[11px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Draft map preview (display only)</p>
            <div className="mt-2 max-h-[280px] overflow-auto">
              <WorkflowMap steps={draftMapSteps} compact />
            </div>
          </div>
        ) : null}

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
            <p className="mt-2 text-[10px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Blocked fields (not editable in Phase 2)</p>
            <p className="mt-0.5 text-[11px] leading-5 text-[#64748B]">{validation.blockedFields.join(" · ")}</p>
            <p className="mt-1.5 text-[11px] font-semibold text-[#B91C1C]">Publish blocked: {validation.publishBlocked}</p>
          </div>
        ) : null}

        {/* Draft simulation result */}
        {simResult ? (
          <div className="mx-5 mt-3 rounded-xl border border-[#FED7AA] bg-[#FFF7ED] p-3">
            <p className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.10em] text-[#C2410C]">
              Draft simulation only
            </p>
            <p className="mt-1.5 text-[11px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">
              {simResult.domainName} → {simResult.subflowName}
            </p>
            {simResult.routePath.length ? (
              <p className="mt-1 text-[12px] text-[#475569]"><span className="font-bold">Route path</span> {simResult.routePath.join(" → ")}</p>
            ) : null}
            <ol className="mt-1.5 space-y-1">
              {simResult.steps.map((s) => (
                <li key={s.id} className="rounded-lg bg-white px-2.5 py-1.5">
                  <p className="text-[12px] font-bold text-[#0F172A]">Step {s.index + 1}: {s.name} <span className="font-semibold text-[#64748B]">→ {s.routesTo}</span></p>
                  {s.notificationRecipients.length ? <p className="text-[11px] text-[#475569]">In-app: {s.notificationRecipients.join(", ")}</p> : null}
                  {s.emailRecipients.length ? <p className="text-[11px] text-[#475569]">Emails: {s.emailRecipients.join(", ")}</p> : null}
                  {s.notificationGap ? <p className="text-[11px] font-semibold text-[#B91C1C]">Notification gap: not implemented yet</p> : null}
                </li>
              ))}
            </ol>
            <p className="mt-1.5 text-[12px] font-black text-[#0F172A]">Final status: <span className="text-[#C2410C]">{simResult.finalStatus}</span></p>
            {simResult.sideEffects.length ? (
              <div className="mt-1">
                <p className="text-[10px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Side effects</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                  {simResult.sideEffects.map((e) => <li key={e} className="text-[11px] leading-5 text-[#475569]">{e}</li>)}
                </ul>
              </div>
            ) : null}
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
            <input className={cn(inputBase, "border-[#E2E8F0]")} value={employeeHrId} onChange={(e) => setEmployeeHrId(e.target.value)} placeholder="e.g. B-52" />
          </label>
          <label className="block">
            <span className={label}>Direct manager HR_ID</span>
            <input className={cn(inputBase, "border-[#E2E8F0]")} value={managerHrId} onChange={(e) => setManagerHrId(e.target.value)} placeholder="blank = test missing manager" />
          </label>
        </div>

        {/* Editable step list — in draft order, with move + visibility controls */}
        <div className="space-y-3 p-5">
          <p className="text-[11px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Editable steps (safe fields, local order)</p>
          {orderedSteps.map((step, oi) => {
            const o = draft[step.id] ?? {};
            const notifEnabled = o.notificationEnabled ?? step.notificationRecipients.length > 0;
            const emailEnabled = o.emailEnabled ?? step.emailRecipients.length > 0;
            const hidden = o.hidden ?? false;
            const stepChanged = diff.changedStepIds.includes(step.id);
            return (
              <div key={step.id} className={cn("rounded-xl border p-3", hidden ? "border-[#E2E8F0] bg-[#F1F5F9] opacity-80" : stepChanged ? "border-[#FED7AA] bg-[#FFFBEB]" : "border-[#E2E8F0]")}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">
                    Draft step {oi + 1} · <span className="text-[#475569]">{step.actor} / {step.role}</span> · → {step.statusProduced}
                    {stepChanged ? <span className="ml-1.5 rounded bg-[#FFF7ED] px-1.5 py-0.5 text-[9px] font-black text-[#C2410C]">CHANGED</span> : null}
                    {hidden ? <span className="ml-1.5 rounded bg-[#E2E8F0] px-1.5 py-0.5 text-[9px] font-black text-[#475569]">HIDDEN</span> : null}
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    <button aria-label="Move up" className="rounded border border-[#E2E8F0] p-1 text-[#64748B] hover:bg-[#F8FAFC] disabled:opacity-40" disabled={oi === 0} onClick={() => move(step.id, "up")} type="button">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button aria-label="Move down" className="rounded border border-[#E2E8F0] p-1 text-[#64748B] hover:bg-[#F8FAFC] disabled:opacity-40" disabled={oi === orderedSteps.length - 1} onClick={() => move(step.id, "down")} type="button">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button aria-label="Toggle visibility" className="rounded border border-[#E2E8F0] p-1 text-[#64748B] hover:bg-[#F8FAFC]" onClick={() => setField(step.id, "hidden", !hidden)} type="button">
                      {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={label}>Display name</span>
                    <input className={fieldCls(step.id, "Display name")} value={o.name ?? step.name} onChange={(e) => setField(step.id, "name", e.target.value)} />
                  </label>
                  <label className="block">
                    <span className={label}>Description</span>
                    <input className={fieldCls(step.id, "Description")} value={o.description ?? ""} onChange={(e) => setField(step.id, "description", e.target.value)} placeholder="optional" />
                  </label>
                  <label className="block">
                    <span className={label}>Action label</span>
                    <input className={fieldCls(step.id, "Action label")} value={o.actionLabel ?? ""} onChange={(e) => setField(step.id, "actionLabel", e.target.value)} placeholder="e.g. Review request" />
                  </label>
                  <label className="block">
                    <span className={label}>Reminder days</span>
                    <input className={fieldCls(step.id, "Reminder days")} value={o.reminderDays ?? ""} onChange={(e) => setField(step.id, "reminderDays", e.target.value)} placeholder="e.g. 7" inputMode="numeric" />
                  </label>
                  <label className="block">
                    <span className={label}>Action-required recipients label</span>
                    <input className={fieldCls(step.id, "Action-required recipients")} value={o.actionRequiredLabel ?? ""} onChange={(e) => setField(step.id, "actionRequiredLabel", e.target.value)} placeholder="label only" />
                    {step.actionRequiredRecipients?.length ? <p className={currentNote}>Current: {step.actionRequiredRecipients.join(", ")}</p> : null}
                  </label>
                  <label className="block">
                    <span className={label}>FYI recipients label</span>
                    <input className={fieldCls(step.id, "FYI recipients")} value={o.fyiLabel ?? ""} onChange={(e) => setField(step.id, "fyiLabel", e.target.value)} placeholder="label only" />
                    {step.fyiRecipients?.length ? <p className={currentNote}>Current: {step.fyiRecipients.join(", ")}</p> : null}
                  </label>
                  <label className="block">
                    <span className={label}>Escalation / fallback label</span>
                    <input className={fieldCls(step.id, "Escalation / fallback")} value={o.escalationLabel ?? ""} onChange={(e) => setField(step.id, "escalationLabel", e.target.value)} placeholder="label only" />
                    {step.fallbackEscalation ? <p className={currentNote}>Current: {step.fallbackEscalation}</p> : null}
                  </label>
                  <label className="block">
                    <span className={label}>Known gap note</span>
                    <input className={fieldCls(step.id, "Known gap")} value={o.knownGap ?? ""} onChange={(e) => setField(step.id, "knownGap", e.target.value)} placeholder="optional" />
                    {step.knownGap ? <p className={currentNote}>Current: {step.knownGap}</p> : null}
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
            Reorder and hide affect the <span className="font-bold">draft preview only</span> — runtime steps are never removed
            or reordered. Approval roles, runtime execution, payroll, security/RLS, access and data changes are{" "}
            <span className="font-bold">not editable</span> here.
          </p>
        </div>
      </div>
    </div>
  );
}
