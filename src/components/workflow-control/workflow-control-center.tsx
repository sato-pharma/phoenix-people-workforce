"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Info, Lock, Map as MapIcon, Settings2, ShieldCheck } from "lucide-react";

import { listWorkflowDefinitions, type WorkflowControlDefinition, type WorkflowControlRisk, type WorkflowControlStatus } from "@/lib/workflow-control/definitions";
import { cn } from "@/lib/utils";

import { WorkflowMap } from "./workflow-map";
import { WorkflowSimulatorPanel } from "./workflow-simulator-panel";

const RISK_BADGE: Record<WorkflowControlRisk, string> = {
  Low: "bg-[#ECFDF5] text-[#047857]",
  Medium: "bg-[#FFF7ED] text-[#C2410C]",
  High: "bg-[#FEF2F2] text-[#B91C1C]",
};

const STATUS_BADGE: Record<WorkflowControlStatus, string> = {
  Active: "bg-[#ECFDF5] text-[#047857]",
  Draft: "bg-[#FFF7ED] text-[#C2410C]",
  "Read-only map": "bg-[#F1F5F9] text-[#475569]",
};

type Tab = "center" | "registry";

export function WorkflowControlCenter({
  canEdit,
  registrySlot,
}: {
  /** Phase 1: always false (editing disabled). Drives the locked Edit panel. */
  canEdit: boolean;
  /** The existing Workflow Registry Manager, shown under the Advanced tab. */
  registrySlot: ReactNode;
}) {
  const definitions = useMemo(() => listWorkflowDefinitions(), []);
  const [tab, setTab] = useState<Tab>("center");
  const [selectedKey, setSelectedKey] = useState<string>(definitions[0]?.key ?? "");
  const [editPanelOpen, setEditPanelOpen] = useState(false);

  const selected: WorkflowControlDefinition | undefined =
    definitions.find((d) => d.key === selectedKey) ?? definitions[0];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-black text-[#0F172A]">Workflow Control Center</h1>
        <p className="text-sm text-[#64748B]">
          Visual map and read-only simulator for every Phoenix approval workflow.
        </p>
      </div>

      {/* Governance warning */}
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-[#FED7AA] bg-[#FFF7ED] px-4 py-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#C2410C]" />
        <p className="text-[13px] leading-5 text-[#9A3412]">
          <span className="font-black">Phase 1 is a read-only workflow map and simulator.</span> It does not change
          production workflow behavior, approval logic, notifications, or data.
        </p>
      </div>

      {/* Tabs */}
      <div className="mt-5 flex items-center gap-2 border-b border-[#E2E8F0]">
        <button
          className={cn(
            "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-bold transition",
            tab === "center" ? "border-[#F97316] text-[#0F172A]" : "border-transparent text-[#64748B] hover:text-[#0F172A]",
          )}
          onClick={() => setTab("center")}
          type="button"
        >
          <MapIcon className="h-4 w-4" /> Map &amp; Simulator
        </button>
        <button
          className={cn(
            "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-bold transition",
            tab === "registry" ? "border-[#F97316] text-[#0F172A]" : "border-transparent text-[#64748B] hover:text-[#0F172A]",
          )}
          onClick={() => setTab("registry")}
          type="button"
        >
          <Settings2 className="h-4 w-4" /> Registry (advanced)
        </button>
      </div>

      {tab === "registry" ? (
        <div className="mt-4">{registrySlot}</div>
      ) : (
        <div className="mt-4">
          {/* Workflow library */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {definitions.map((definition) => {
              const active = definition.key === selected?.key;
              return (
                <button
                  key={definition.key}
                  className={cn(
                    "rounded-xl border p-4 text-left transition",
                    active ? "border-[#F97316] bg-[#FFF7ED]" : "border-[#E2E8F0] bg-white hover:border-[#CBD5E1]",
                  )}
                  onClick={() => setSelectedKey(definition.key)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-black text-[#0F172A]">{definition.name}</p>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]", RISK_BADGE[definition.riskLevel])}>
                      {definition.riskLevel}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] leading-5 text-[#64748B]">{definition.summary}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className={cn("rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]", STATUS_BADGE[definition.status])}>
                      {definition.status}
                    </span>
                    <span className="rounded bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-bold text-[#475569]">
                      {definition.steps.length} steps
                    </span>
                    <span className="rounded bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-bold text-[#475569]">
                      {definition.modulesAffected.length} modules
                    </span>
                    <span className="rounded bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-bold text-[#475569]">
                      {definition.notificationsInvolved.length} notif · {definition.emailsInvolved.length} email
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {selected ? (
            <div className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-black text-[#0F172A]">{selected.name}</h2>
                  <p className="text-xs text-[#64748B]">
                    {selected.governedByRegistry
                      ? `Governed by workflow registry${selected.registryModuleKey ? ` · ${selected.registryModuleKey}` : ""}`
                      : "Not governed by the workflow registry"}
                  </p>
                </div>
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm font-bold text-[#64748B] transition hover:bg-[#F8FAFC]"
                  onClick={() => setEditPanelOpen((v) => !v)}
                  type="button"
                >
                  <Lock className="h-4 w-4" /> Edit Workflow
                </button>
              </div>

              {editPanelOpen ? (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#64748B]" />
                  <p className="text-[13px] leading-5 text-[#475569]">
                    {canEdit
                      ? "Editing is enabled for your role."
                      : "Workflow editing will be enabled in Phase 2 with versioning, draft, publish, and rollback. This Phase 1 view is read-only."}
                  </p>
                </div>
              ) : null}

              {selected.gaps.length ? (
                <div className="mt-3 rounded-xl border border-[#FEE2E2] bg-[#FEF2F2] px-4 py-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.10em] text-[#B91C1C]">
                    Known gaps (read-only — not changed in Phase 1)
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {selected.gaps.map((gap) => (
                      <li key={gap} className="text-[12px] leading-5 text-[#991B1B]">{gap}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-[11px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Workflow map</p>
                  <WorkflowMap definition={selected} />
                </div>
                <div>
                  <p className="mb-2 text-[11px] font-black uppercase tracking-[0.10em] text-[#94A3B8]">Simulator</p>
                  <WorkflowSimulatorPanel workflowKey={selected.key} workflowName={selected.name} />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
