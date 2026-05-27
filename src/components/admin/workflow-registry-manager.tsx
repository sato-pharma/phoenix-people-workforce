"use client";

import {
  AlertCircle,
  CheckCircle2,
  PlusCircle,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
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
import type {
  WorkflowRegistryDashboard,
  WorkflowRegistryModule,
} from "@/lib/workflow-registry/service";

type WorkflowRegistryManagerProps = {
  canManage: boolean;
  initialData: WorkflowRegistryDashboard | null;
  initialError?: string | null;
};

type RegistryFormState = {
  actionsText: string;
  description: string;
  isActive: boolean;
  moduleKey: string;
  moduleName: string;
  statusesText: string;
};

const emptyStatuses = [
  { key: "draft", label: "Draft", terminal: false },
  { key: "pending", label: "Pending", terminal: false },
  { key: "approved", label: "Approved", terminal: true },
  { key: "rejected", label: "Rejected", terminal: true },
];

const emptyActions = [
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

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function moduleToForm(module: WorkflowRegistryModule): RegistryFormState {
  return {
    actionsText: prettyJson(module.actions),
    description: module.description,
    isActive: module.isActive,
    moduleKey: module.moduleKey,
    moduleName: module.moduleName,
    statusesText: prettyJson(module.statuses),
  };
}

function emptyForm(): RegistryFormState {
  return {
    actionsText: prettyJson(emptyActions),
    description: "",
    isActive: true,
    moduleKey: "",
    moduleName: "",
    statusesText: prettyJson(emptyStatuses),
  };
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function parseJsonField(value: string, label: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

async function readWorkflowRegistryResponse(response: Response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? "Workflow registry request failed.");
  }
  return payload as WorkflowRegistryDashboard;
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

  const modules = data?.modules ?? [];
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

  async function refresh() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/workflow-registry", { cache: "no-store" });
      const payload = await readWorkflowRegistryResponse(response);
      setData(payload);
      if (!selectedKey && payload.modules[0]) {
        startEdit(payload.modules[0]);
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Workflow Registry failed to load.");
    } finally {
      setIsLoading(false);
    }
  }

  async function save() {
    if (!canManage) {
      setError("Only Super Admin can change the Workflow Registry.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const body = {
        actions: parseJsonField(form.actionsText, "Actions"),
        description: form.description,
        isActive: form.isActive,
        moduleKey: form.moduleKey,
        moduleName: form.moduleName,
        statuses: parseJsonField(form.statusesText, "Statuses"),
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
      setMessage(editingKey ? "Workflow module updated." : "Workflow module created.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Workflow module could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteModule() {
    if (!editingKey || !canManage) {
      return;
    }
    const confirmed = window.confirm(`Delete workflow module "${editingKey}" from the central registry?`);
    if (!confirmed) {
      return;
    }

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
      if (next) {
        startEdit(next);
      } else {
        startNew();
      }
      setMessage("Workflow module deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Workflow module could not be deleted.");
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
              Add module
            </Button>
          </>
        )}
        badges={(
          <>
            <AdminInsightChip tone="orange">{modules.length} modules</AdminInsightChip>
            <AdminInsightChip tone="slate">{activeModules} active</AdminInsightChip>
            <AdminInsightChip>{statusCount} statuses</AdminInsightChip>
            <AdminInsightChip>{actionCount} actions</AdminInsightChip>
          </>
        )}
        description="Central runtime registry for module statuses, actions, allowed roles, side effects, notifications, audit wording, and required tests."
        eyebrow="Governance"
        icon={<Settings2 className="h-3.5 w-3.5" />}
        title="Workflow Registry"
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
          <span>This view is read-only. Only Super Admin can create, edit, or delete workflow registry records.</span>
        </AdminCallout>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <AdminTableShell
          action={null}
          description="Select a module to inspect or edit its workflow definition."
          title="Modules"
        >
          <div className="max-h-[70vh] overflow-auto p-3">
            {modules.length > 0 ? (
              <div className="space-y-2">
                {modules.map((module) => {
                  const active = selectedModule?.moduleKey === module.moduleKey;
                  return (
                    <button
                      className={`w-full rounded-lg border px-3 py-3 text-left transition ${
                        active
                          ? "border-orange-300 bg-orange-50 text-orange-950"
                          : "border-slate-200 bg-white text-slate-700 hover:border-orange-200 hover:bg-slate-50"
                      }`}
                      key={module.id}
                      onClick={() => startEdit(module)}
                      type="button"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold">{module.moduleName}</p>
                          <p className="mt-1 font-mono text-[11px] text-slate-500">{module.moduleKey}</p>
                        </div>
                        <Badge variant={module.isActive ? "success" : "neutral"}>
                          {module.isActive ? "Active" : "Off"}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <span className="rounded bg-white px-2 py-1 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
                          {module.statuses.length} statuses
                        </span>
                        <span className="rounded bg-white px-2 py-1 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
                          {module.actions.length} actions
                        </span>
                        <span className="rounded bg-white px-2 py-1 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
                          v{module.version}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="px-3 py-10 text-center text-sm text-slate-500">No workflow modules found.</p>
            )}
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
          description="Changes saved here are loaded from the database by the central registry service."
          title={editingKey ? `Editing ${editingKey}` : "New workflow module"}
        >
          <div className="grid gap-4 p-5">
            <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_160px]">
              <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                Module key
                <Input
                  className="mt-2 font-mono"
                  disabled={!canManage}
                  onChange={(event) => updateForm("moduleKey", event.target.value)}
                  placeholder="outstation_expenses"
                  value={form.moduleKey}
                />
              </label>
              <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                Module name
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
                Active
              </label>
            </div>

            <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Description
              <textarea
                className="mt-2 min-h-20 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-50"
                disabled={!canManage}
                onChange={(event) => updateForm("description", event.target.value)}
                value={form.description}
              />
            </label>

            <div className="grid gap-4 xl:grid-cols-2">
              <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                Statuses JSON
                <textarea
                  className="mt-2 min-h-[360px] w-full rounded-lg border border-slate-200 bg-slate-950 px-3 py-3 font-mono text-xs font-medium normal-case tracking-normal text-slate-100 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-100 disabled:text-slate-500"
                  disabled={!canManage}
                  onChange={(event) => updateForm("statusesText", event.target.value)}
                  spellCheck={false}
                  value={form.statusesText}
                />
              </label>
              <label className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                Actions JSON
                <textarea
                  className="mt-2 min-h-[360px] w-full rounded-lg border border-slate-200 bg-slate-950 px-3 py-3 font-mono text-xs font-medium normal-case tracking-normal text-slate-100 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-100 disabled:text-slate-500"
                  disabled={!canManage}
                  onChange={(event) => updateForm("actionsText", event.target.value)}
                  spellCheck={false}
                  value={form.actionsText}
                />
              </label>
            </div>
          </div>
        </AdminTableShell>
      </div>

      {selectedModule ? (
        <AdminTableShell
          action={<Badge variant="warning">Runtime definition</Badge>}
          description="Current normalized workflow rules for the selected module."
          title="Selected workflow"
        >
          <div className="grid gap-5 p-5 xl:grid-cols-2">
            <div>
              <h3 className="text-sm font-black text-slate-900">Statuses</h3>
              <div className="mt-3 grid gap-2">
                {selectedModule.statuses.map((status) => (
                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2" key={status.key}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-slate-700">{status.key}</span>
                      <Badge variant={status.terminal ? "neutral" : "success"}>{status.terminal ? "Terminal" : "Open"}</Badge>
                    </div>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{status.label}</p>
                    {status.description ? <p className="mt-1 text-xs text-slate-500">{status.description}</p> : null}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-900">Actions</h3>
              <div className="mt-3 grid gap-2">
                {selectedModule.actions.map((action) => (
                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2" key={action.key}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-slate-700">{action.key}</span>
                      <Badge variant="warning">{action.from.join(", ")} to {action.to}</Badge>
                    </div>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{action.label}</p>
                    <p className="mt-1 text-xs text-slate-500">Roles: {action.allowedRoles.join(", ")}</p>
                    <p className="mt-1 text-xs text-slate-500">Audit: {action.auditLog}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </AdminTableShell>
      ) : null}

      <Card className="overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 shadow-sm">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-black text-slate-900">Registry audit log</h2>
          <p className="mt-1 text-sm text-slate-500">Latest workflow registry changes.</p>
        </div>
        <div className="divide-y divide-slate-100">
          {(data?.auditLogs ?? []).length > 0 ? (
            data?.auditLogs.map((log) => (
              <div className="px-5 py-3" key={log.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">{log.summary}</p>
                  <span className="text-xs text-slate-500">{formatDate(log.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">Actor: {log.actorLoginId ?? "system"} / Module: {log.entityId ?? "-"}</p>
              </div>
            ))
          ) : (
            <p className="px-5 py-8 text-center text-sm text-slate-500">No registry audit entries yet.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
