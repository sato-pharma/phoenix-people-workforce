"use client";

import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  PlusCircle,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { displayTitleForRole } from "@/lib/auth/hr-functions";
import type { PhoenixRole } from "@/lib/auth/permissions";
import type {
  WorkflowRegistryAction,
  WorkflowRegistryDashboard,
  WorkflowRegistryModule,
  WorkflowRegistryStatus,
} from "@/lib/workflow-registry/service";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";


type WorkflowRegistryManagerProps = {
  canManage: boolean;
  initialData: WorkflowRegistryDashboard | null;
  initialError?: string | null;
};

type RegistryFormState = {
  actions: WorkflowRegistryAction[];
  description: string;
  isActive: boolean;
  moduleKey: string;
  moduleName: string;
  statuses: WorkflowRegistryStatus[];
};

const phoenixRoleOptions: PhoenixRole[] = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Finance Manager",
  // HR Advisory left when the owner retired the HR Business Partner seat on 2026-10-08; the Talent Acquisition seat took its place
  // here, because recruiting and offers are hers.
  "HR Operations",
  "HR Resourcing",
  "Manager",
  "CEO",
  "Super Admin",
];

const emptyStatuses: WorkflowRegistryStatus[] = [
  { description: "", key: "draft", label: "Draft", terminal: false },
  { description: "", key: "pending", label: "Pending review", terminal: false },
  { description: "", key: "approved", label: "Approved", terminal: true },
  { description: "", key: "rejected", label: "Rejected", terminal: true },
];

const emptyActions: WorkflowRegistryAction[] = [
  {
    allowedRoles: ["Super Admin"],
    auditLog: "Workflow action completed",
    from: ["pending"],
    key: "approve",
    label: "Approve",
    notifications: [],
    requiresReason: false,
    sideEffects: [],
    tests: [],
    to: "approved",
  },
];

function cloneStatuses(statuses: WorkflowRegistryStatus[]) {
  return statuses.map((status) => ({ ...status }));
}

function cloneActions(actions: WorkflowRegistryAction[]) {
  return actions.map((action) => ({
    ...action,
    allowedRoles: [...action.allowedRoles],
    from: [...action.from],
    notifications: [...action.notifications],
    sideEffects: [...action.sideEffects],
    tests: [...action.tests],
  }));
}

function makeKey(value: string, fallback: string) {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(key) ? key : fallback;
}

function uniqueKey(base: string, existing: Set<string>) {
  let candidate = base;
  let index = 2;
  while (existing.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  return candidate;
}

function moduleToForm(module: WorkflowRegistryModule): RegistryFormState {
  return {
    actions: cloneActions(module.actions),
    description: module.description,
    isActive: module.isActive,
    moduleKey: module.moduleKey,
    moduleName: module.moduleName,
    statuses: cloneStatuses(module.statuses),
  };
}

function emptyForm(): RegistryFormState {
  return {
    actions: cloneActions(emptyActions),
    description: "",
    isActive: true,
    moduleKey: "",
    moduleName: "",
    statuses: cloneStatuses(emptyStatuses),
  };
}

function listToText(value: string[]) {
  return value.join("\n");
}

function textToList(value: string) {
  return value
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function displayStatusLabel(statuses: WorkflowRegistryStatus[], key: string) {
  if (key === "unchanged") return "No status change";
  if (key === "deleted") return "Deleted";
  return statuses.find((status) => status.key === key)?.label ?? key;
}

async function readWorkflowRegistryResponse(response: Response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? "Workflow registry request failed.");
  }
  return payload as WorkflowRegistryDashboard;
}

function FlowBox({
  label,
  tone = "open",
}: {
  label: string;
  tone?: "open" | "terminal" | "action";
}) {
  const classes = {
    action: "border-orange-200 bg-orange-50 text-orange-950",
    open: "border-slate-200 bg-white text-slate-900",
    terminal: "border-emerald-200 bg-emerald-50 text-emerald-950",
  };

  return (
    <div className={`rounded-lg border px-3 py-2 text-center text-sm font-black shadow-sm ${classes[tone]}`}>
      {label}
    </div>
  );
}

function WorkflowMap({
  actions,
  statuses,
}: {
  actions: WorkflowRegistryAction[];
  statuses: WorkflowRegistryStatus[];
}) {
  if (actions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm font-semibold text-slate-500">
        No workflow arrows yet. Add an action to draw the first step.
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {actions.map((action) => (
        <div
          className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
          key={action.key}
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap gap-2">
              {action.from.map((sourceStatus) => (
                <FlowBox
                  key={`${action.key}-${sourceStatus}`}
                  label={displayStatusLabel(statuses, sourceStatus)}
                  tone={statuses.find((status) => status.key === sourceStatus)?.terminal ? "terminal" : "open"}
                />
              ))}
            </div>
            <ArrowRight className="h-5 w-5 shrink-0 text-slate-400" />
            <FlowBox label={action.label} tone="action" />
            <ArrowRight className="h-5 w-5 shrink-0 text-slate-400" />
            <FlowBox
              label={displayStatusLabel(statuses, action.to)}
              tone={statuses.find((status) => status.key === action.to)?.terminal ? "terminal" : "open"}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function WorkflowRegistryManager({
  canManage,
  initialData,
  initialError = null,
}: WorkflowRegistryManagerProps) {
  const [data, setData] = useState<WorkflowRegistryDashboard | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState(initialData?.modules[0]?.moduleKey ?? "");
  const [editingKey, setEditingKey] = useState<string | null>(initialData?.modules[0]?.moduleKey ?? null);
  const [form, setForm] = useState<RegistryFormState>(() =>
    initialData?.modules[0] ? moduleToForm(initialData.modules[0]) : emptyForm(),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const modules = useMemo(() => data?.modules ?? [], [data]);
  const selectedModule = useMemo(
    () => modules.find((module) => module.moduleKey === selectedKey) ?? modules[0] ?? null,
    [modules, selectedKey],
  );
  const activeModules = modules.filter((module) => module.isActive).length;
  const actionCount = modules.reduce((total, module) => total + module.actions.length, 0);
  const statusCount = modules.reduce((total, module) => total + module.statuses.length, 0);

  function updateForm<K extends keyof RegistryFormState>(key: K, value: RegistryFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startNew() {
    setError(null);
    setMessage(null);
    setSelectedKey("");
    setEditingKey(null);
    setForm(emptyForm());
  }

  function startEdit(module: WorkflowRegistryModule) {
    setError(null);
    setMessage(null);
    setSelectedKey(module.moduleKey);
    setEditingKey(module.moduleKey);
    setForm(moduleToForm(module));
  }

  function updateStatus(index: number, patch: Partial<WorkflowRegistryStatus>) {
    setForm((current) => ({
      ...current,
      statuses: current.statuses.map((status, statusIndex) =>
        statusIndex === index ? { ...status, ...patch } : status,
      ),
    }));
  }

  function addStatus() {
    setForm((current) => {
      const existing = new Set(current.statuses.map((status) => status.key));
      const key = uniqueKey("new_status", existing);
      return {
        ...current,
        statuses: [
          ...current.statuses,
          { description: "", key, label: "New status", terminal: false },
        ],
      };
    });
  }

  function removeStatus(index: number) {
    setForm((current) => {
      if (current.statuses.length <= 1) return current;
      const removed = current.statuses[index];
      const statuses = current.statuses.filter((_, statusIndex) => statusIndex !== index);
      const fallback = statuses[0]?.key ?? "draft";
      return {
        ...current,
        actions: current.actions.map((action) => {
          const from = action.from.filter((key) => key !== removed.key);
          return {
            ...action,
            from: from.length > 0 ? from : [fallback],
            to: action.to === removed.key ? fallback : action.to,
          };
        }),
        statuses,
      };
    });
  }

  function updateAction(index: number, patch: Partial<WorkflowRegistryAction>) {
    setForm((current) => ({
      ...current,
      actions: current.actions.map((action, actionIndex) =>
        actionIndex === index ? { ...action, ...patch } : action,
      ),
    }));
  }

  function toggleActionSource(actionIndex: number, statusKey: string) {
    setForm((current) => ({
      ...current,
      actions: current.actions.map((action, index) => {
        if (index !== actionIndex) return action;
        const next = action.from.includes(statusKey)
          ? action.from.filter((key) => key !== statusKey)
          : [...action.from, statusKey];
        return { ...action, from: next.length > 0 ? next : action.from };
      }),
    }));
  }

  function toggleActionRole(actionIndex: number, role: PhoenixRole) {
    setForm((current) => ({
      ...current,
      actions: current.actions.map((action, index) => {
        if (index !== actionIndex) return action;
        const next = action.allowedRoles.includes(role)
          ? action.allowedRoles.filter((item) => item !== role)
          : [...action.allowedRoles, role];
        return { ...action, allowedRoles: next.length > 0 ? next : action.allowedRoles };
      }),
    }));
  }

  function addAction() {
    setForm((current) => {
      const existing = new Set(current.actions.map((action) => action.key));
      const firstStatus = current.statuses[0]?.key ?? "draft";
      return {
        ...current,
        actions: [
          ...current.actions,
          {
            allowedRoles: ["Super Admin"],
            auditLog: "Workflow action completed",
            from: [firstStatus],
            key: uniqueKey("new_action", existing),
            label: "New action",
            notifications: [],
            requiresReason: false,
            sideEffects: [],
            tests: [],
            to: firstStatus,
          },
        ],
      };
    });
  }

  function removeAction(index: number) {
    setForm((current) => ({
      ...current,
      actions: current.actions.filter((_, actionIndex) => actionIndex !== index),
    }));
  }

  async function refresh() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/workflow-registry", { cache: "no-store" });
      const payload = await readWorkflowRegistryResponse(response);
      setData(payload);
      const next = payload.modules.find((module) => module.moduleKey === selectedKey) ?? payload.modules[0] ?? null;
      if (next) startEdit(next);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Workflow Control failed to load.");
    } finally {
      setIsLoading(false);
    }
  }

  async function save() {
    if (!canManage) {
      setError("Only Super Admin can change Workflow Control.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const body = {
        actions: form.actions,
        description: form.description,
        isActive: form.isActive,
        moduleKey: form.moduleKey,
        moduleName: form.moduleName,
        statuses: form.statuses,
      };
      const endpoint = editingKey
        ? `/api/admin/workflow-registry/${encodeURIComponent(editingKey)}`
        : "/api/admin/workflow-registry";
      const response = await fetch(endpoint, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: editingKey ? "PATCH" : "POST",
      });
      const payload = await readWorkflowRegistryResponse(response);
      setData(payload);
      setSelectedKey(form.moduleKey);
      setEditingKey(form.moduleKey);
      setMessage(editingKey ? "Workflow updated." : "Workflow created.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Workflow could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteModule() {
    if (!editingKey || !canManage) return;
    const confirmed = window.confirm(`Delete workflow "${editingKey}" from Workflow Control?`);
    if (!confirmed) return;

    setIsDeleting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/workflow-registry/${encodeURIComponent(editingKey)}`, {
        method: "DELETE",
      });
      const payload = await readWorkflowRegistryResponse(response);
      setData(payload);
      const next = payload.modules[0] ?? null;
      if (next) startEdit(next);
      else startNew();
      setMessage("Workflow deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Workflow could not be deleted.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={(
          <>
            <Button className="rounded-md" disabled={isLoading} onClick={() => void refresh()} type="button" variant="secondary">
              {isLoading ? <LoadingSpinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            <Button className="rounded-md bg-orange-500 text-white hover:bg-orange-600" disabled={!canManage} onClick={startNew} type="button">
              <PlusCircle className="h-4 w-4" />
              Add workflow
            </Button>
          </>
        )}
        badges={(
          <>
            <AdminInsightChip tone="orange">{modules.length} workflows</AdminInsightChip>
            <AdminInsightChip tone="slate">{activeModules} live</AdminInsightChip>
            <AdminInsightChip>{statusCount} boxes</AdminInsightChip>
            <AdminInsightChip>{actionCount} arrows</AdminInsightChip>
          </>
        )}
        description="Visual control for statuses, arrows, roles, side effects, notifications, audit logs, and tests."
        eyebrow="Governance"
        icon={<Workflow className="h-3.5 w-3.5" />}
        title="Workflow Control"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </AdminCallout>
      ) : null}

      {message ? (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{message}</span>
        </AdminCallout>
      ) : null}

      {!canManage ? (
        <AdminCallout tone="warning">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>This view is read-only. Only Super Admin can create, edit, or delete workflows.</span>
        </AdminCallout>
      ) : null}

      <AdminTableShell
        action={null}
        description="Each tab is one workflow. Pick a tab, then edit boxes and arrows."
        title="Workflow tabs"
      >
        <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((module) => {
            const active = selectedModule?.moduleKey === module.moduleKey;
            return (
              <button
                className={`min-w-0 rounded-lg border px-3 py-2 text-left transition ${
                  active
                    ? "border-orange-300 bg-orange-50 text-orange-950"
                    : "border-slate-200 bg-white text-slate-700 hover:border-orange-200 hover:bg-slate-50"
                }`}
                key={module.id}
                onClick={() => startEdit(module)}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-black">{module.moduleName}</span>
                  <Badge variant={module.isActive ? "success" : "neutral"}>
                    {module.isActive ? "Live" : "Off"}
                  </Badge>
                </div>
              </button>
            );
          })}
          {modules.length === 0 ? (
            <p className="px-3 py-6 text-sm text-slate-500">No workflows found.</p>
          ) : null}
        </div>
      </AdminTableShell>

      <AdminTableShell
        action={(
          <div className="flex flex-wrap gap-2">
            <Button
              className="rounded-md"
              disabled={!canManage || isSaving}
              onClick={() => void save()}
              type="button"
            >
              {isSaving ? <LoadingSpinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
              Save
            </Button>
            <Button
              className="rounded-md"
              disabled={!canManage || !editingKey || isDeleting}
              onClick={() => void deleteModule()}
              type="button"
              variant="destructive"
            >
              {isDeleting ? <LoadingSpinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
              Delete
            </Button>
          </div>
        )}
        description="This is the workflow in plain language. Boxes are statuses. Arrows are actions."
        title={form.moduleName || "New workflow"}
      >
        <div className="grid gap-6 p-5">
          <WorkflowMap actions={form.actions} statuses={form.statuses} />

          <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)_160px]">
            <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              System key
              <Input
                className="mt-2 font-mono"
                disabled={!canManage}
                onChange={(event) => updateForm("moduleKey", makeKey(event.target.value, "workflow"))}
                placeholder="outstation_expenses"
                value={form.moduleKey}
              />
            </label>
            <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Workflow name
              <Input
                className="mt-2"
                disabled={!canManage}
                onChange={(event) => updateForm("moduleName", event.target.value)}
                placeholder="Outstation Expenses"
                value={form.moduleName}
              />
            </label>
            <label className="flex items-end gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
              <input
                checked={form.isActive}
                className="h-4 w-4 accent-orange-500"
                disabled={!canManage}
                onChange={(event) => updateForm("isActive", event.target.checked)}
                type="checkbox"
              />
              Live
            </label>
          </div>

          <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            What this workflow controls
            <textarea
              className={cn(phxTextareaClassName, "mt-2 min-h-20 normal-case tracking-normal")}
              disabled={!canManage}
              onChange={(event) => updateForm("description", event.target.value)}
              value={form.description}
            />
          </label>
        </div>
      </AdminTableShell>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <AdminTableShell
          action={(
            <Button className="rounded-md" disabled={!canManage} onClick={addStatus} type="button" variant="secondary">
              <PlusCircle className="h-4 w-4" />
              Add box
            </Button>
          )}
          description="Boxes are the possible states of the workflow."
          title="Status boxes"
        >
          <div className="grid gap-3 p-4">
            {form.statuses.map((status, index) => (
              <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm" key={`${status.key}-${index}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="grid flex-1 gap-3">
                    <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                      Box name
                      <Input
                        className="mt-2"
                        disabled={!canManage}
                        onChange={(event) => updateStatus(index, { label: event.target.value })}
                        value={status.label}
                      />
                    </label>
                    <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                      System key
                      <Input
                        className="mt-2 font-mono"
                        disabled={!canManage}
                        onChange={(event) => updateStatus(index, { key: makeKey(event.target.value, status.key) })}
                        value={status.key}
                      />
                    </label>
                  </div>
                  <Button
                    className="h-9 w-9 rounded-md p-0"
                    disabled={!canManage || form.statuses.length <= 1}
                    onClick={() => removeStatus(index)}
                    type="button"
                    variant="ghost"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <input
                    checked={status.terminal}
                    className="h-4 w-4 accent-orange-500"
                    disabled={!canManage}
                    onChange={(event) => updateStatus(index, { terminal: event.target.checked })}
                    type="checkbox"
                  />
                  This is an end box
                </label>
              </div>
            ))}
          </div>
        </AdminTableShell>

        <AdminTableShell
          action={(
            <Button className="rounded-md" disabled={!canManage} onClick={addAction} type="button" variant="secondary">
              <PlusCircle className="h-4 w-4" />
              Add arrow
            </Button>
          )}
          description="Arrows say who can move the workflow from one box to the next."
          title="Workflow arrows"
        >
          <div className="grid gap-4 p-4">
            {form.actions.map((action, index) => (
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" key={`${action.key}-${index}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="grid flex-1 gap-4">
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_220px]">
                      <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                        What happens
                        <Input
                          className="mt-2"
                          disabled={!canManage}
                          onChange={(event) => updateAction(index, { label: event.target.value })}
                          placeholder="Employee submits expense"
                          value={action.label}
                        />
                      </label>
                      <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                        System action key
                        <Input
                          className="mt-2 font-mono"
                          disabled={!canManage}
                          onChange={(event) => updateAction(index, { key: makeKey(event.target.value, action.key) })}
                          value={action.key}
                        />
                      </label>
                      <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                        Next box
                        <SearchableSelect
                          className="mt-2 w-full px-3"
                          disabled={!canManage}
                          onChange={(event) => updateAction(index, { to: event.target.value })}
                          value={action.to}
                        >
                          {form.statuses.map((status) => (
                            <option key={status.key} value={status.key}>{status.label}</option>
                          ))}
                          <option value="unchanged">No status change</option>
                          <option value="deleted">Deleted</option>
                        </SearchableSelect>
                      </label>
                    </div>

                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Starts from these boxes</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {form.statuses.map((status) => (
                          <label
                            className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                              action.from.includes(status.key)
                                ? "border-orange-300 bg-orange-50 text-orange-950"
                                : "border-slate-200 bg-white text-slate-600"
                            }`}
                            key={status.key}
                          >
                            <input
                              checked={action.from.includes(status.key)}
                              className="mr-2 accent-orange-500"
                              disabled={!canManage}
                              onChange={() => toggleActionSource(index, status.key)}
                              type="checkbox"
                            />
                            {status.label}
                          </label>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Who can do it</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {phoenixRoleOptions.map((role) => (
                          <label
                            className={`rounded-md border px-3 py-2 text-xs font-bold ${
                              action.allowedRoles.includes(role)
                                ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                                : "border-slate-200 bg-white text-slate-600"
                            }`}
                            key={role}
                          >
                            <input
                              checked={action.allowedRoles.includes(role)}
                              className="mr-2 accent-emerald-500"
                              disabled={!canManage}
                              onChange={() => toggleActionRole(index, role)}
                              type="checkbox"
                            />
                            {displayTitleForRole(role)}
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-3 lg:grid-cols-2">
                      <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                        Side effects
                        <textarea
                          className={cn(phxTextareaClassName, "mt-2 min-h-20 normal-case tracking-normal")}
                          disabled={!canManage}
                          onChange={(event) => updateAction(index, { sideEffects: textToList(event.target.value) })}
                          value={listToText(action.sideEffects)}
                        />
                      </label>
                      <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                        Notifications
                        <textarea
                          className={cn(phxTextareaClassName, "mt-2 min-h-20 normal-case tracking-normal")}
                          disabled={!canManage}
                          onChange={(event) => updateAction(index, { notifications: textToList(event.target.value) })}
                          value={listToText(action.notifications)}
                        />
                      </label>
                      <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                        Audit log text
                        <Input
                          className="mt-2"
                          disabled={!canManage}
                          onChange={(event) => updateAction(index, { auditLog: event.target.value })}
                          value={action.auditLog}
                        />
                      </label>
                      <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                        Required tests
                        <textarea
                          className={cn(phxTextareaClassName, "mt-2 min-h-20 normal-case tracking-normal")}
                          disabled={!canManage}
                          onChange={(event) => updateAction(index, { tests: textToList(event.target.value) })}
                          value={listToText(action.tests)}
                        />
                      </label>
                    </div>
                  </div>

                  <Button
                    className="h-9 w-9 rounded-md p-0"
                    disabled={!canManage}
                    onClick={() => removeAction(index)}
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </AdminTableShell>
      </div>

      <Card className="overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-sm">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="flex items-center gap-2 text-lg font-black text-slate-900">
            <Settings2 className="h-4 w-4 text-orange-500" />
            Change history
          </h2>
          <p className="mt-1 text-sm text-slate-500">Latest Workflow Control changes.</p>
        </div>
        <div className="divide-y divide-slate-100">
          {(data?.auditLogs ?? []).length > 0 ? (
            data?.auditLogs.map((log) => (
              <div className="px-5 py-3" key={log.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">{log.summary}</p>
                  <span className="text-xs text-slate-500">{formatDate(log.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">Actor: {log.actorLoginId ?? "system"} / Workflow: {log.entityId ?? "-"}</p>
              </div>
            ))
          ) : (
            <p className="px-5 py-8 text-center text-sm text-slate-500">No Workflow Control changes yet.</p>
          )}
        </div>
      </Card>

      <p className="text-xs font-semibold text-slate-500">
        System keys stay visible because the running application uses them. The normal-language names are what admins should use day to day.
      </p>
    </div>
  );
}
