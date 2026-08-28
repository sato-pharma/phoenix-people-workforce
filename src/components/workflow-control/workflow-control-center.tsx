"use client";

import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Info, Lock, Map as MapIcon, PencilLine, Settings2, ShieldCheck } from "lucide-react";

import {
  domainEmailCount,
  domainGaps,
  domainHasNotificationGap,
  domainNotificationCount,
  domainStepCount,
  listWorkflowDomains,
  type WorkflowControlDomain,
  type WorkflowControlRisk,
  type WorkflowControlStatus,
} from "@/lib/workflow-control/definitions";
import { cn } from "@/lib/utils";

import { WorkflowMap } from "./workflow-map";
import { WorkflowSimulatorPanel } from "./workflow-simulator-panel";
import { WorkflowDraftEditor } from "./workflow-draft-editor";

const RISK_BADGE: Record<WorkflowControlRisk, string> = {
  Low: "bg-[#ECFDF5] text-[#047857]",
  Medium: "bg-phx-accent-soft text-phx-accent-press",
  High: "bg-[#FEF2F2] text-[#B91C1C]",
};

const STATUS_BADGE: Record<WorkflowControlStatus, string> = {
  Active: "bg-[#ECFDF5] text-[#047857]",
  Draft: "bg-phx-accent-soft text-phx-accent-press",
  "Read-only map": "bg-phx-paper-2 text-phx-ink-2",
  "Partially implemented": "bg-[#FFFBEB] text-[#B45309]",
  "Not implemented": "bg-[#FEF2F2] text-[#B91C1C]",
};

type Tab = "center" | "registry";

export function WorkflowControlCenter({
  canEdit,
  canDraftEdit = false,
  registrySlot,
}: {
  /** Phase 1: always false (real runtime editing/publish disabled). */
  canEdit: boolean;
  /** Phase 2A: client-only Draft Editor available (Super Admin). */
  canDraftEdit?: boolean;
  /** The existing Workflow Registry Manager, shown under the Advanced tab. */
  registrySlot: ReactNode;
}) {
  const domains = useMemo(() => listWorkflowDomains(), []);
  const [tab, setTab] = useState<Tab>("center");
  const [selectedDomainKey, setSelectedDomainKey] = useState<string>(domains[0]?.key ?? "");
  const [selectedSubflowKey, setSelectedSubflowKey] = useState<string>(domains[0]?.subflows[0]?.key ?? "");
  const [editPanelOpen, setEditPanelOpen] = useState(false);
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);

  const selectedDomain: WorkflowControlDomain | undefined =
    domains.find((d) => d.key === selectedDomainKey) ?? domains[0];
  const selectedSubflow =
    selectedDomain?.subflows.find((s) => s.key === selectedSubflowKey) ?? selectedDomain?.subflows[0];

  function selectDomain(domain: WorkflowControlDomain) {
    setSelectedDomainKey(domain.key);
    setSelectedSubflowKey(domain.subflows[0]?.key ?? "");
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-black text-phx-ink">Workflow Control Center</h1>
        <p className="text-sm text-phx-ink-soft">
          A business-friendly map and read-only simulator for every Phoenix workflow domain.
        </p>
      </div>

      {/* Governance warning */}
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-[#FED7AA] bg-phx-accent-soft px-4 py-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-phx-accent-press" />
        <p className="text-[13px] leading-5 text-[#9A3412]">
          <span className="font-black">Phase 1 is a read-only workflow map and simulator.</span> It does not change
          production workflow behavior, approval logic, notifications, or data.
        </p>
      </div>

      {/* Tabs */}
      <div className="mt-5 flex items-center gap-2 border-b border-phx-line">
        <button
          className={cn(
            "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-bold transition",
            tab === "center" ? "border-phx-accent text-phx-ink" : "border-transparent text-phx-ink-soft hover:text-phx-ink",
          )}
          onClick={() => setTab("center")}
          type="button"
        >
          <MapIcon className="h-4 w-4" /> Map &amp; Simulator
        </button>
        <button
          className={cn(
            "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-bold transition",
            tab === "registry" ? "border-phx-accent text-phx-ink" : "border-transparent text-phx-ink-soft hover:text-phx-ink",
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
          {/* Domain library (few, business-friendly cards) */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {domains.map((domain) => {
              const active = domain.key === selectedDomain?.key;
              return (
                <button
                  key={domain.key}
                  className={cn(
                    "rounded-xl border p-4 text-left transition",
                    active ? "border-phx-accent bg-phx-accent-soft" : "border-phx-line bg-white hover:border-phx-line-strong",
                  )}
                  onClick={() => selectDomain(domain)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-black text-phx-ink">{domain.name}</p>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]", RISK_BADGE[domain.riskLevel])}>
                      {domain.riskLevel}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] leading-5 text-phx-ink-soft">{domain.summary}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className={cn("rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]", STATUS_BADGE[domain.status])}>
                      {domain.status}
                    </span>
                    {domain.crossCutting ? (
                      <span className="rounded bg-[#EEF2FF] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em] text-[#4338CA]">
                        Cross-cutting
                      </span>
                    ) : null}
                    {domain.beta ? (
                      <span className="rounded bg-[#FEF9C3] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em] text-[#854D0E]">
                        Beta
                      </span>
                    ) : null}
                    <span className="rounded bg-phx-paper-2 px-2 py-0.5 text-[10px] font-bold text-phx-ink-2">
                      {domain.subflows.length} subflows
                    </span>
                    <span className="rounded bg-phx-paper-2 px-2 py-0.5 text-[10px] font-bold text-phx-ink-2">
                      {domainStepCount(domain)} steps
                    </span>
                    <span className="rounded bg-phx-paper-2 px-2 py-0.5 text-[10px] font-bold text-phx-ink-2">
                      {domain.modulesAffected.length} modules
                    </span>
                    <span className="rounded bg-phx-paper-2 px-2 py-0.5 text-[10px] font-bold text-phx-ink-2">
                      {domainNotificationCount(domain)} in-app · {domainEmailCount(domain)} email
                    </span>
                    {domainHasNotificationGap(domain) ? (
                      <span className="rounded bg-[#FEF2F2] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.08em] text-[#B91C1C]">
                        Notif gap
                      </span>
                    ) : null}
                    {domainGaps(domain).length ? (
                      <span className="rounded bg-phx-accent-soft px-2 py-0.5 text-[10px] font-bold text-phx-accent-press">
                        {domainGaps(domain).length} open gap{domainGaps(domain).length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>

          {selectedDomain && selectedSubflow ? (
            <div className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-black text-phx-ink">{selectedDomain.name}</h2>
                  <p className="text-xs text-phx-ink-soft">{selectedDomain.summary}</p>
                </div>
                <button
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-bold transition",
                    canDraftEdit
                      ? "border-phx-accent bg-phx-accent-soft text-phx-accent-press hover:bg-[#FFEDD5]"
                      : "border-phx-line bg-white text-phx-ink-soft hover:bg-phx-paper",
                  )}
                  onClick={() => (canDraftEdit ? setDraftEditorOpen(true) : setEditPanelOpen((v) => !v))}
                  type="button"
                >
                  {canDraftEdit ? <PencilLine className="h-4 w-4" /> : <Lock className="h-4 w-4" />} Edit Workflow
                </button>
              </div>

              {selectedDomain.status === "Not implemented" ? (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B91C1C]" />
                  <p className="text-[13px] leading-5 text-[#B91C1C]">
                    <span className="font-black">Not implemented:</span> nothing in the system runs these steps today. This is the intended
                    design kept as a specification, not a live governed process — do not rely on it, and do not report that anything here
                    was approved.
                  </p>
                </div>
              ) : null}

              {selectedDomain.status === "Partially implemented" ? (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B45309]" />
                  <p className="text-[13px] leading-5 text-[#B45309]">
                    <span className="font-black">Partially implemented:</span> some of these steps run today and some are still only a
                    specification. Read each subflow&apos;s gaps below before relying on it — a step with a NOT BUILT gap does nothing.
                  </p>
                </div>
              ) : null}

              {selectedDomain.beta ? (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#FDE68A] bg-[#FEF9C3] px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#854D0E]" />
                  <p className="text-[13px] leading-5 text-[#854D0E]">
                    <span className="font-black">Beta:</span> this domain is still being implemented; some steps are declared but not fully wired up.
                  </p>
                </div>
              ) : null}

              {editPanelOpen ? (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-phx-line bg-phx-paper px-4 py-3">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-phx-ink-soft" />
                  {canEdit ? (
                    <p className="text-[13px] leading-5 text-phx-ink-2">Editing is enabled for your role.</p>
                  ) : (
                    <div className="min-w-0">
                      <p className="text-[13px] font-black text-phx-ink">Workflow editing is locked in Phase 1</p>
                      <p className="mt-0.5 text-[12px] leading-5 text-phx-ink-2">This view is read-only — editing is coming in Phase 2.</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] leading-5 text-phx-ink-2">
                        <li>Phase 2 will support <span className="font-bold">draft → edit → publish → rollback</span> with versioning.</li>
                        <li>Runtime workflow execution is <span className="font-bold">not changed</span> in Phase 1.</li>
                        <li>Admins <span className="font-bold">cannot accidentally change live workflow behavior</span> from this read-only view.</li>
                      </ul>
                    </div>
                  )}
                </div>
              ) : null}

              {/* Subflow selector */}
              <div className="mt-4 flex flex-wrap gap-1.5">
                {selectedDomain.subflows.map((subflow) => (
                  <button
                    key={subflow.key}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-bold transition",
                      subflow.key === selectedSubflow.key
                        ? "border-phx-accent bg-phx-accent-soft text-phx-accent-press"
                        : "border-phx-line bg-white text-phx-ink-soft hover:border-phx-line-strong",
                    )}
                    onClick={() => setSelectedSubflowKey(subflow.key)}
                    type="button"
                  >
                    {subflow.name}
                  </button>
                ))}
              </div>

              {selectedSubflow.gaps?.length ? (
                <div className="mt-3 rounded-xl border border-[#FEE2E2] bg-[#FEF2F2] px-4 py-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.10em] text-[#B91C1C]">
                    Known gaps (read-only — not changed in Phase 1)
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {selectedSubflow.gaps.map((gap) => (
                      <li key={gap} className="text-[12px] leading-5 text-[#991B1B]">{gap}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-[11px] font-black uppercase tracking-[0.10em] text-phx-ink-faint">
                    {selectedSubflow.name} — map
                  </p>
                  <WorkflowMap steps={selectedSubflow.steps} />
                </div>
                <div>
                  <p className="mb-2 text-[11px] font-black uppercase tracking-[0.10em] text-phx-ink-faint">Simulator</p>
                  <WorkflowSimulatorPanel
                    key={`sim-${selectedDomain.key}-${selectedSubflow.key}`}
                    domainKey={selectedDomain.key}
                    domainName={selectedDomain.name}
                    subflows={selectedDomain.subflows}
                    subflowKey={selectedSubflow.key}
                    onSubflowChange={setSelectedSubflowKey}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {draftEditorOpen && canDraftEdit && selectedDomain && selectedSubflow ? (
        <WorkflowDraftEditor
          domainKey={selectedDomain.key}
          domainName={selectedDomain.name}
          subflowKey={selectedSubflow.key}
          subflowName={selectedSubflow.name}
          steps={selectedSubflow.steps}
          onClose={() => setDraftEditorOpen(false)}
        />
      ) : null}
    </div>
  );
}
