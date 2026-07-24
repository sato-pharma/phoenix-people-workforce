"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LockKeyhole, RefreshCcw, Save, Settings2, SlidersHorizontal, Workflow } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  PortalDesktopTable,
  PortalRecordCard,
} from "@/components/employee-portal/portal-primitives";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  MarketingControlSetting,
  MarketingControlWorkspace,
  MarketingRequestType,
  MarketingWorkflowApprovalScope,
  MarketingWorkflowStep,
} from "@/lib/marketing-requests/types";
import { SearchableSelect } from "@/components/ui/searchable-select";


function emptyWorkspace(): MarketingControlWorkspace {
  return {
    canManageValidationRules: false,
    requestTypes: [],
    settings: [],
    workflowSteps: [],
  };
}

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.15em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function SelectField({
  children,
  onChange,
  value,
}: {
  children: ReactNode;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <SearchableSelect
      className="h-10 w-full rounded border border-slate-200 bg-white px-3 text-sm font-bold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </SearchableSelect>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={`relative h-7 w-12 rounded border transition ${
        checked ? "border-orange-500 bg-orange-500" : "border-slate-300 bg-slate-200"
      }`}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded bg-white shadow transition ${
          checked ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}

function settingNumber(setting: MarketingControlSetting | undefined, key: string, fallback: number) {
  const value = setting?.value?.[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : String(fallback);
}

function settingBoolean(setting: MarketingControlSetting | undefined, key: string, fallback: boolean) {
  const value = setting?.value?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function settingUpdatedLabel(setting: MarketingControlSetting | undefined) {
  if (!setting) return "Not configured";
  const updated = new Date(setting.updatedAt);
  if (Number.isNaN(updated.getTime())) return "Not configured";
  return updated.toLocaleString("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function SectionHeader({
  badge,
  icon,
  title,
}: {
  badge?: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded bg-orange-50 text-orange-700">
          {icon}
        </div>
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Marketing Control</p>
          <h2 className="text-xl font-black tracking-tight text-slate-950">{title}</h2>
        </div>
      </div>
      {badge ? <Badge variant="neutral">{badge}</Badge> : null}
    </div>
  );
}

type SaveState = {
  key: string;
  message: string;
};

export function MarketingControlWorkspace() {
  const [workspace, setWorkspace] = useState<MarketingControlWorkspace>(emptyWorkspace);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState | null>(null);
  const [requestTypeDrafts, setRequestTypeDrafts] = useState<Record<number, MarketingRequestType>>({});
  const [workflowDrafts, setWorkflowDrafts] = useState<Record<number, MarketingWorkflowStep>>({});
  const [roiMultiplier, setRoiMultiplier] = useState("10");
  const [financeInvoiceDays, setFinanceInvoiceDays] = useState("7");
  const [validationDrafts, setValidationDrafts] = useState<Record<string, boolean>>({});

  async function loadWorkspace() {
    setIsLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/marketing-requests/control", {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        setWorkspace(emptyWorkspace());
        setMessage(payload.message ?? "Unable to load marketing controls.");
        return;
      }
      const nextWorkspace: MarketingControlWorkspace = {
        canManageValidationRules: Boolean(payload.canManageValidationRules),
        requestTypes: payload.requestTypes ?? [],
        settings: payload.settings ?? [],
        workflowSteps: payload.workflowSteps ?? [],
      };
      setWorkspace(nextWorkspace);
      setRequestTypeDrafts(Object.fromEntries(nextWorkspace.requestTypes.map((type) => [type.id, type])));
      setWorkflowDrafts(Object.fromEntries(nextWorkspace.workflowSteps.map((step) => [step.id, step])));
      const roiSetting = nextWorkspace.settings.find((setting) => setting.key === "roi_multiplier");
      const financeSetting = nextWorkspace.settings.find((setting) => setting.key === "finance_invoice_deadline_days");
      setRoiMultiplier(settingNumber(roiSetting, "multiplier", 10));
      setFinanceInvoiceDays(settingNumber(financeSetting, "days", 7));
      setValidationDrafts(Object.fromEntries(
        nextWorkspace.settings
          .filter((setting) => setting.group === "validation")
          .map((setting) => [setting.key, settingBoolean(setting, "required", true)]),
      ));
    } catch {
      setWorkspace(emptyWorkspace());
      setMessage("Unable to load marketing controls.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const groupedSettings = useMemo(() => {
    return {
      finance: workspace.settings.filter((setting) => setting.group === "finance"),
      roi: workspace.settings.filter((setting) => setting.group === "roi"),
      validation: workspace.settings.filter((setting) => setting.group === "validation"),
    };
  }, [workspace.settings]);

  async function patchControl(body: Record<string, unknown>, successMessage: string) {
    setSaveState({ key: JSON.stringify(body), message: "Saving" });
    setMessage(null);
    try {
      const response = await fetch("/api/marketing-requests/control", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? "Unable to save marketing control.");
        return;
      }
      setMessage(successMessage);
      await loadWorkspace();
    } catch {
      setMessage("Unable to save marketing control.");
    } finally {
      setSaveState(null);
    }
  }

  const saving = Boolean(saveState);

  return (
    <div className="space-y-6">
      <Card className="rounded border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Request Types</p>
            <p className="mt-1 text-2xl font-black text-slate-950">{workspace.requestTypes.length}</p>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Workflow Steps</p>
            <p className="mt-1 text-2xl font-black text-slate-950">{workspace.workflowSteps.length}</p>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Validation Settings</p>
            <p className="mt-1 text-2xl font-black text-slate-950">
              {workspace.canManageValidationRules ? groupedSettings.validation.length : "Admin"}
            </p>
          </div>
          <button
            className="flex min-h-[78px] items-center justify-center gap-2 rounded border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
            onClick={() => void loadWorkspace()}
            type="button"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </Card>

      {message ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          {message}
        </div>
      ) : null}

      <Card className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_20px_48px_rgba(15,23,42,0.07)]">
        <SectionHeader
          badge={`${workspace.requestTypes.length} types`}
          icon={<SlidersHorizontal className="h-5 w-5" />}
          title="Request Types"
        />
        <div className="divide-y divide-slate-100 md:hidden">
          {workspace.requestTypes.map((type) => {
            const draft = requestTypeDrafts[type.id] ?? type;
            return (
              <PortalRecordCard
                accent={draft.active ? "emerald" : "slate"}
                key={`${type.id}-mobile`}
                meta={<span className="font-mono">{type.code}</span>}
                status={<Badge variant={draft.active ? "success" : "neutral"}>{draft.active ? "Active" : "Inactive"}</Badge>}
                title={draft.name}
              >
                <div className="grid gap-3">
                  <Field label="Name">
                    <Input
                      className="h-10 border-slate-200 bg-white font-bold"
                      onChange={(event) => setRequestTypeDrafts((current) => ({
                        ...current,
                        [type.id]: { ...draft, name: event.target.value },
                      }))}
                      value={draft.name}
                    />
                  </Field>
                  <Field label="Description">
                    <Input
                      className="h-10 border-slate-200 bg-white"
                      onChange={(event) => setRequestTypeDrafts((current) => ({
                        ...current,
                        [type.id]: { ...draft, description: event.target.value },
                      }))}
                      value={draft.description ?? ""}
                    />
                  </Field>
                  <Field label="Sort order">
                    <Input
                      className="h-10 border-slate-200 bg-white font-bold"
                      min={0}
                      onChange={(event) => setRequestTypeDrafts((current) => ({
                        ...current,
                        [type.id]: { ...draft, sortOrder: Number(event.target.value || 0) },
                      }))}
                      type="number"
                      value={draft.sortOrder}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                      Other description
                      <Toggle
                        checked={draft.requiresDescription}
                        label={`Require description for ${draft.name}`}
                        onChange={(checked) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, requiresDescription: checked },
                        }))}
                      />
                    </label>
                    <label className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                      Active
                      <Toggle
                        checked={draft.active}
                        label={`Active status for ${draft.name}`}
                        onChange={(checked) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, active: checked },
                        }))}
                      />
                    </label>
                  </div>
                  <Button
                    className="w-full gap-2 rounded bg-orange-600 px-3 font-black hover:bg-orange-700"
                    disabled={saving}
                    onClick={() => void patchControl({
                      entity: "request_type",
                      id: type.id,
                      patch: {
                        active: draft.active,
                        description: draft.description,
                        name: draft.name,
                        requiresDescription: draft.requiresDescription,
                        sortOrder: draft.sortOrder,
                      },
                    }, "Request type saved.")}
                  >
                    <Save className="h-4 w-4" />
                    Save
                  </Button>
                </div>
              </PortalRecordCard>
            );
          })}
        </div>
        <PortalDesktopTable minWidth="980px">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Sort</th>
                <th className="px-4 py-3">Other Description</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3">Save</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {workspace.requestTypes.map((type) => {
                const draft = requestTypeDrafts[type.id] ?? type;
                return (
                  <tr key={type.id}>
                    <td className="px-4 py-3 font-mono text-xs font-black text-slate-600">{type.code}</td>
                    <td className="px-4 py-3">
                      <Input
                        className="h-10 border-slate-200 bg-white font-bold"
                        onChange={(event) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, name: event.target.value },
                        }))}
                        value={draft.name}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        className="h-10 border-slate-200 bg-white"
                        onChange={(event) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, description: event.target.value },
                        }))}
                        value={draft.description ?? ""}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        className="h-10 w-20 border-slate-200 bg-white font-bold"
                        min={0}
                        onChange={(event) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, sortOrder: Number(event.target.value || 0) },
                        }))}
                        type="number"
                        value={draft.sortOrder}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Toggle
                        checked={draft.requiresDescription}
                        label={`Require description for ${type.name}`}
                        onChange={(checked) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, requiresDescription: checked },
                        }))}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Toggle
                        checked={draft.active}
                        label={`Active status for ${type.name}`}
                        onChange={(checked) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, active: checked },
                        }))}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        className="gap-2 rounded bg-orange-600 px-3 font-black hover:bg-orange-700"
                        disabled={saving}
                        onClick={() => void patchControl({
                          entity: "request_type",
                          id: type.id,
                          patch: {
                            active: draft.active,
                            description: draft.description,
                            name: draft.name,
                            requiresDescription: draft.requiresDescription,
                            sortOrder: draft.sortOrder,
                          },
                        }, "Request type saved.")}
                      >
                        <Save className="h-4 w-4" />
                        Save
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
        </PortalDesktopTable>
      </Card>

      <Card className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_20px_48px_rgba(15,23,42,0.07)]">
        <SectionHeader
          badge={`${workspace.workflowSteps.length} steps`}
          icon={<Workflow className="h-5 w-5" />}
          title="Approval Workflow"
        />
        <div className="divide-y divide-slate-100 md:hidden">
          {workspace.workflowSteps.map((step) => {
            const draft = workflowDrafts[step.id] ?? step;
            return (
              <PortalRecordCard
                accent={draft.active ? "orange" : "slate"}
                key={`${step.id}-mobile`}
                meta={`Sequence ${draft.sequence}`}
                status={<Badge variant={draft.active ? "success" : "neutral"}>{draft.active ? "Active" : "Inactive"}</Badge>}
                title={draft.stepName}
              >
                <div className="grid gap-3">
                  <Field label="Step">
                    <Input
                      className="h-10 border-slate-200 bg-white font-bold"
                      onChange={(event) => setWorkflowDrafts((current) => ({
                        ...current,
                        [step.id]: { ...draft, stepName: event.target.value },
                      }))}
                      value={draft.stepName}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Sequence">
                      <Input
                        className="h-10 border-slate-200 bg-white font-bold"
                        min={1}
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, sequence: Number(event.target.value || 1) },
                        }))}
                        type="number"
                        value={draft.sequence}
                      />
                    </Field>
                    <Field label="SLA Days">
                      <Input
                        className="h-10 border-slate-200 bg-white font-bold"
                        min={0}
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: {
                            ...draft,
                            defaultSlaDays: event.target.value ? Number(event.target.value) : null,
                          },
                        }))}
                        type="number"
                        value={draft.defaultSlaDays ?? ""}
                      />
                    </Field>
                  </div>
                  <Field label="Scope">
                    <SelectField
                      onChange={(value) => setWorkflowDrafts((current) => ({
                        ...current,
                        [step.id]: { ...draft, approvalScope: value as MarketingWorkflowApprovalScope },
                      }))}
                      value={draft.approvalScope}
                    >
                      <option value="direct_manager">Direct manager</option>
                      <option value="role">Role</option>
                      <option value="finance">Finance</option>
                      <option value="final">Final</option>
                    </SelectField>
                  </Field>
                  <Field label="Assigned Role">
                    <Input
                      className="h-10 border-slate-200 bg-white font-bold"
                      onChange={(event) => setWorkflowDrafts((current) => ({
                        ...current,
                        [step.id]: { ...draft, assignedRole: event.target.value },
                      }))}
                      value={draft.assignedRole}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                      Required
                      <Toggle
                        checked={draft.required}
                        label={`Required for ${draft.stepName}`}
                        onChange={(checked) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, required: checked },
                        }))}
                      />
                    </label>
                    <label className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                      Active
                      <Toggle
                        checked={draft.active}
                        label={`Active status for ${draft.stepName}`}
                        onChange={(checked) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, active: checked },
                        }))}
                      />
                    </label>
                  </div>
                  <Button
                    className="w-full gap-2 rounded bg-orange-600 px-3 font-black hover:bg-orange-700"
                    disabled={saving}
                    onClick={() => void patchControl({
                      entity: "workflow_step",
                      id: step.id,
                      patch: {
                        active: draft.active,
                        approvalScope: draft.approvalScope,
                        assignedRole: draft.assignedRole,
                        defaultSlaDays: draft.defaultSlaDays,
                        required: draft.required,
                        sequence: draft.sequence,
                        stepName: draft.stepName,
                      },
                    }, "Workflow step saved.")}
                  >
                    <Save className="h-4 w-4" />
                    Save
                  </Button>
                </div>
              </PortalRecordCard>
            );
          })}
        </div>
        <PortalDesktopTable minWidth="1120px">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Seq</th>
                <th className="px-4 py-3">Step</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">Assigned Role</th>
                <th className="px-4 py-3">SLA Days</th>
                <th className="px-4 py-3">Required</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3">Save</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {workspace.workflowSteps.map((step) => {
                const draft = workflowDrafts[step.id] ?? step;
                return (
                  <tr key={step.id}>
                    <td className="px-4 py-3">
                      <Input
                        className="h-10 w-20 border-slate-200 bg-white font-bold"
                        min={1}
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, sequence: Number(event.target.value || 1) },
                        }))}
                        type="number"
                        value={draft.sequence}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        className="h-10 border-slate-200 bg-white font-bold"
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, stepName: event.target.value },
                        }))}
                        value={draft.stepName}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <SelectField
                        onChange={(value) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, approvalScope: value as MarketingWorkflowApprovalScope },
                        }))}
                        value={draft.approvalScope}
                      >
                        <option value="direct_manager">Direct manager</option>
                        <option value="role">Role</option>
                        <option value="finance">Finance</option>
                        <option value="final">Final</option>
                      </SelectField>
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        className="h-10 border-slate-200 bg-white font-bold"
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, assignedRole: event.target.value },
                        }))}
                        value={draft.assignedRole}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        className="h-10 w-24 border-slate-200 bg-white font-bold"
                        min={0}
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: {
                            ...draft,
                            defaultSlaDays: event.target.value ? Number(event.target.value) : null,
                          },
                        }))}
                        type="number"
                        value={draft.defaultSlaDays ?? ""}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Toggle
                        checked={draft.required}
                        label={`Required for ${step.stepName}`}
                        onChange={(checked) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, required: checked },
                        }))}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Toggle
                        checked={draft.active}
                        label={`Active status for ${step.stepName}`}
                        onChange={(checked) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, active: checked },
                        }))}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        className="gap-2 rounded bg-orange-600 px-3 font-black hover:bg-orange-700"
                        disabled={saving}
                        onClick={() => void patchControl({
                          entity: "workflow_step",
                          id: step.id,
                          patch: {
                            active: draft.active,
                            approvalScope: draft.approvalScope,
                            assignedRole: draft.assignedRole,
                            defaultSlaDays: draft.defaultSlaDays,
                            required: draft.required,
                            sequence: draft.sequence,
                            stepName: draft.stepName,
                          },
                        }, "Workflow step saved.")}
                      >
                        <Save className="h-4 w-4" />
                        Save
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
        </PortalDesktopTable>
      </Card>

      <Card className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_20px_48px_rgba(15,23,42,0.07)]">
        <SectionHeader
          icon={<Settings2 className="h-5 w-5" />}
          title="ROI And Finance Rules"
        />
        <div className="grid gap-4 p-5 lg:grid-cols-2">
          <div className="rounded border border-slate-200 bg-slate-50 p-4">
            <Field label="ROI multiplier">
              <Input
                className="h-11 border-slate-200 bg-white text-base font-black"
                min={1}
                onChange={(event) => setRoiMultiplier(event.target.value)}
                type="number"
                value={roiMultiplier}
              />
            </Field>
            <p className="mt-3 text-xs font-semibold text-slate-500">
              Updated: {settingUpdatedLabel(groupedSettings.roi.find((setting) => setting.key === "roi_multiplier"))}
            </p>
            <Button
              className="mt-4 gap-2 rounded bg-orange-600 font-black hover:bg-orange-700"
              disabled={saving}
              onClick={() => void patchControl({
                entity: "setting",
                settingKey: "roi_multiplier",
                value: { multiplier: Number(roiMultiplier || 0) },
              }, "ROI rule saved.")}
            >
              <Save className="h-4 w-4" />
              Save ROI
            </Button>
          </div>

          <div className="rounded border border-slate-200 bg-slate-50 p-4">
            <Field label="Invoice deadline days">
              <Input
                className="h-11 border-slate-200 bg-white text-base font-black"
                min={1}
                onChange={(event) => setFinanceInvoiceDays(event.target.value)}
                type="number"
                value={financeInvoiceDays}
              />
            </Field>
            <p className="mt-3 text-xs font-semibold text-slate-500">
              Updated: {settingUpdatedLabel(groupedSettings.finance.find((setting) => setting.key === "finance_invoice_deadline_days"))}
            </p>
            <Button
              className="mt-4 gap-2 rounded bg-orange-600 font-black hover:bg-orange-700"
              disabled={saving}
              onClick={() => void patchControl({
                entity: "setting",
                settingKey: "finance_invoice_deadline_days",
                value: { days: Number(financeInvoiceDays || 0) },
              }, "Finance rule saved.")}
            >
              <Save className="h-4 w-4" />
              Save Finance
            </Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_20px_48px_rgba(15,23,42,0.07)]">
        <SectionHeader
          badge={workspace.canManageValidationRules ? `${groupedSettings.validation.length} rules` : "Admin only"}
          icon={<LockKeyhole className="h-5 w-5" />}
          title="Validation Settings"
        />
        {workspace.canManageValidationRules ? (
          <div className="divide-y divide-slate-100">
            {groupedSettings.validation.map((setting) => (
              <div className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto_auto]" key={setting.key}>
                <div>
                  <p className="font-black text-slate-950">{setting.label}</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">Updated: {settingUpdatedLabel(setting)}</p>
                </div>
                <Toggle
                  checked={validationDrafts[setting.key] ?? settingBoolean(setting, "required", true)}
                  label={setting.label}
                  onChange={(checked) => setValidationDrafts((current) => ({
                    ...current,
                    [setting.key]: checked,
                  }))}
                />
                <Button
                  className="gap-2 rounded bg-orange-600 px-3 font-black hover:bg-orange-700"
                  disabled={saving}
                  onClick={() => void patchControl({
                    entity: "setting",
                    settingKey: setting.key,
                    value: { required: validationDrafts[setting.key] ?? settingBoolean(setting, "required", true) },
                  }, "Validation setting saved.")}
                >
                  <Save className="h-4 w-4" />
                  Save
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-6">
            <div className="rounded border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-bold text-slate-600">
              Validation settings are available to Super Admin only.
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
