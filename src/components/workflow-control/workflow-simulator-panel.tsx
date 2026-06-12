"use client";

import { useState } from "react";
import { AlertTriangle, Play } from "lucide-react";

import type { WorkflowSubflow } from "@/lib/workflow-control/definitions";
import { simulateWorkflow, type WorkflowSimulationResult } from "@/lib/workflow-control/simulator";

const inputClass =
  "w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#0F172A] outline-none focus:border-[#F97316]";
const labelClass = "text-[11px] font-black uppercase tracking-[0.10em] text-[#64748B]";

/**
 * Read-only workflow simulator with domain + subflow selection. Runs entirely
 * client-side over the static definitions — it never creates a request or writes
 * to the database.
 */
export function WorkflowSimulatorPanel({
  domainKey,
  domainName,
  subflows,
  subflowKey,
  onSubflowChange,
}: {
  domainKey: string;
  domainName: string;
  subflows: readonly WorkflowSubflow[];
  subflowKey: string;
  onSubflowChange: (key: string) => void;
}) {
  const [employeeHrId, setEmployeeHrId] = useState("");
  const [requestType, setRequestType] = useState("");
  const [amount, setAmount] = useState("");
  const [managerHrId, setManagerHrId] = useState("");
  const [lineDept, setLineDept] = useState("");
  const [hrAvailable, setHrAvailable] = useState(true);
  const [result, setResult] = useState<WorkflowSimulationResult | null>(null);

  function run() {
    const parsedAmount = amount.trim() ? Number(amount) : undefined;
    setResult(
      simulateWorkflow({
        domainKey,
        subflowKey,
        employeeHrId: employeeHrId.trim() || undefined,
        requestType: requestType.trim() || undefined,
        amount: Number.isFinite(parsedAmount) ? parsedAmount : undefined,
        managerHrId: managerHrId.trim() || undefined,
        department: lineDept.trim() || undefined,
        hrManagerAvailable: hrAvailable,
      }),
    );
  }

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-sm">
      <p className="text-sm font-black text-[#0F172A]">Simulate: {domainName}</p>
      <p className="mt-0.5 text-xs text-[#64748B]">Read-only — no request is created and nothing is written.</p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={labelClass}>Subflow</span>
          <select
            className={inputClass}
            value={subflowKey}
            onChange={(e) => {
              onSubflowChange(e.target.value);
              setResult(null);
            }}
          >
            {subflows.map((subflow) => (
              <option key={subflow.key} value={subflow.key}>
                {subflow.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelClass}>Employee HR_ID</span>
          <input className={inputClass} value={employeeHrId} onChange={(e) => setEmployeeHrId(e.target.value)} placeholder="e.g. B-52" />
        </label>
        <label className="block">
          <span className={labelClass}>Direct manager HR_ID</span>
          <input className={inputClass} value={managerHrId} onChange={(e) => setManagerHrId(e.target.value)} placeholder="blank = test missing manager" />
        </label>
        <label className="block">
          <span className={labelClass}>Request type (optional)</span>
          <input className={inputClass} value={requestType} onChange={(e) => setRequestType(e.target.value)} placeholder="e.g. Annual" />
        </label>
        <label className="block">
          <span className={labelClass}>Amount (expense/outstation)</span>
          <input className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="optional" inputMode="decimal" />
        </label>
        <label className="block">
          <span className={labelClass}>Line / department (optional)</span>
          <input className={inputClass} value={lineDept} onChange={(e) => setLineDept(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 pt-5">
          <input type="checkbox" checked={hrAvailable} onChange={(e) => setHrAvailable(e.target.checked)} />
          <span className="text-xs font-semibold text-[#334155]">HR Manager recipient exists</span>
        </label>
      </div>

      <button
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#F97316] px-4 py-2 text-sm font-black text-white transition hover:bg-[#EA580C]"
        onClick={run}
        type="button"
      >
        <Play className="h-4 w-4" />
        Run simulation
      </button>

      {result ? (
        <div className="mt-4 border-t border-[#E2E8F0] pt-4">
          <p className="mb-3 text-[12px] text-[#475569]">
            <span className="font-black uppercase tracking-[0.10em] text-[#94A3B8]">Simulating</span>{" "}
            <span className="font-bold text-[#0F172A]">{result.domainName}</span>
            {" → "}
            <span className="font-bold text-[#0F172A]">{result.subflowName}</span>
          </p>

          {result.warnings.length ? (
            <div className="mb-3 rounded-lg border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2">
              <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.10em] text-[#C2410C]">
                <AlertTriangle className="h-3.5 w-3.5" /> Warnings
              </p>
              <ul className="mt-1 space-y-0.5">
                {result.warnings.map((w) => (
                  <li key={w} className="text-[12px] leading-5 text-[#9A3412]">{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.routePath.length ? (
            <p className="mb-3 text-[12px] text-[#475569]">
              <span className="font-black uppercase tracking-[0.10em] text-[#94A3B8]">Route path</span>{" "}
              {result.routePath.join(" → ")}
            </p>
          ) : null}

          <ol className="space-y-2">
            {result.steps.map((step) => (
              <li key={step.id} className="rounded-lg bg-[#F8FAFC] px-3 py-2">
                <p className="text-[13px] font-bold text-[#0F172A]">
                  Step {step.index + 1}: {step.name}{" "}
                  <span className="font-semibold text-[#64748B]">→ routes to {step.routesTo}</span>
                </p>
                <p className="text-[12px] text-[#475569]">Status produced: {step.statusProduced}</p>
                {step.actionRequiredRecipients.length ? (
                  <p className="text-[12px] text-[#B91C1C]">Action required: {step.actionRequiredRecipients.join(", ")}</p>
                ) : null}
                {step.fyiRecipients.length ? (
                  <p className="text-[12px] text-[#475569]">FYI: {step.fyiRecipients.join(", ")}</p>
                ) : null}
                {step.notificationRecipients.length ? (
                  <p className="text-[12px] text-[#475569]">In-app: {step.notificationRecipients.join(", ")}</p>
                ) : null}
                {step.emailRecipients.length ? (
                  <p className="text-[12px] text-[#475569]">Emails: {step.emailRecipients.join(", ")}</p>
                ) : null}
                {step.notificationGap ? (
                  <p className="text-[12px] font-semibold text-[#B91C1C]">Notification gap: not implemented yet</p>
                ) : null}
              </li>
            ))}
          </ol>

          <p className="mt-3 text-[13px] font-black text-[#0F172A]">
            Final status: <span className="text-[#C2410C]">{result.finalStatus}</span>
          </p>

          {result.sideEffects.length ? (
            <div className="mt-3">
              <p className="text-[10px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Side effects</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {result.sideEffects.map((effect) => (
                  <li key={effect} className="text-[12px] leading-5 text-[#475569]">{effect}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
