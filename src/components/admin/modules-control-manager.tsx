"use client";

import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  SlidersHorizontal,
  X,
} from "lucide-react";
import * as React from "react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  ModuleControlCatalogModule,
  ModuleControlDashboard,
  ModuleControlNavigationMode,
  ModuleControlTargetOption,
  ModuleControlTargetType,
} from "@/lib/admin/modules-control";
import type { PermissionMap, PhoenixRole } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

type Props = {
  canManage: boolean;
  initialData?: ModuleControlDashboard | null;
  initialError?: string | null;
};

const targetTypes: Array<{ label: string; value: ModuleControlTargetType }> = [
  { label: "User", value: "user" },
  { label: "Role", value: "role" },
  { label: "Position", value: "position" },
  { label: "Line", value: "line" },
];

const modes: Array<{ label: string; value: ModuleControlNavigationMode }> = [
  { label: "Admin Sidebar", value: "admin" },
  { label: "Employee Portal Sidebar", value: "employee-portal" },
];

function normalizeKey(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function targetBucket(data: ModuleControlDashboard | null, type: ModuleControlTargetType) {
  if (!data) return [];
  if (type === "user") return data.targets.users;
  if (type === "role") return data.targets.roles;
  if (type === "position") return data.targets.positions;
  return data.targets.lines;
}

function modulePermissionLabel(navModule: ModuleControlCatalogModule) {
  if (navModule.permissions.length === 0) return "No backend permission";
  return navModule.permissions.map((permission) => `${permission.resource}:${permission.action}`).join(" or ");
}

function targetDisplay(target: ModuleControlTargetOption | null, fallback: string) {
  return target?.hrId || target?.loginId || target?.name || target?.label || fallback;
}

function affectedUsers(data: ModuleControlDashboard, targetType: ModuleControlTargetType, targetKey: string) {
  const normalizedTarget = normalizeKey(targetKey);
  return data.targets.users.filter((user) => {
    if (targetType === "user") {
      return normalizeKey(user.value) === normalizedTarget ||
        normalizeKey(user.hrId) === normalizedTarget ||
        normalizeKey(user.loginId) === normalizedTarget;
    }
    if (targetType === "role") return normalizeKey(user.role) === normalizedTarget;
    if (targetType === "position") return normalizeKey(user.positionTitle) === normalizedTarget;
    return normalizeKey(user.line) === normalizedTarget;
  });
}

function clientBlockReason(input: {
  data: ModuleControlDashboard;
  matrix: PermissionMap;
  module: ModuleControlCatalogModule;
  target: ModuleControlTargetOption | null;
  targetKey: string;
  targetType: ModuleControlTargetType;
}) {
  const people = affectedUsers(input.data, input.targetType, input.targetKey);
  if (people.length === 0) {
    return `Blocked: no active access account matched ${input.targetType}:${input.targetKey}.`;
  }

  for (const person of people) {
    const role = person.role as PhoenixRole | null | undefined;
    if (!role) {
      return `Blocked: ${targetDisplay(person, input.targetKey)} has no active role.`;
    }
    const navModule = input.module;
    if (navModule.roles.length > 0 && !navModule.roles.includes(role)) {
      return `Blocked: ${targetDisplay(person, input.targetKey)} is ${role}. ${navModule.label} is limited to ${navModule.roles.join(", ")}.`;
    }
    if (navModule.navigationMode === "employee-portal" && navModule.excludedRoles.includes(role)) {
      return `Blocked: ${targetDisplay(person, input.targetKey)} is ${role}. ${navModule.label} excludes ${role}.`;
    }
    if (navModule.permissions.length > 0) {
      const allowed = navModule.permissions.some((permission) =>
        input.matrix[role]?.[permission.resource]?.includes(permission.action) ?? false,
      );
      if (!allowed) {
        return `Blocked: ${targetDisplay(person, input.targetKey)} is ${role}. ${navModule.label} requires ${modulePermissionLabel(navModule)}.`;
      }
    }
  }

  return null;
}

function selectedFromAssignments(
  data: ModuleControlDashboard | null,
  mode: ModuleControlNavigationMode,
  targetType: ModuleControlTargetType,
  targetKey: string,
) {
  if (!data) return [];
  return data.assignments
    .filter(
      (assignment) =>
        assignment.navigationMode === mode &&
        assignment.targetType === targetType &&
        normalizeKey(assignment.targetKey) === normalizeKey(targetKey) &&
        assignment.isEnabled,
    )
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((assignment) => assignment.moduleId);
}

function requestErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

async function parseResponse(response: Response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.message === "string"
      ? payload.message
      : "Modules Control request failed.";
    throw new Error(message);
  }
  return payload as ModuleControlDashboard;
}

export function ModulesControlManager({ canManage, initialData = null, initialError = null }: Props) {
  const [data, setData] = React.useState<ModuleControlDashboard | null>(initialData);
  const [error, setError] = React.useState<string | null>(initialError);
  const [message, setMessage] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<ModuleControlNavigationMode>("admin");
  const [targetType, setTargetType] = React.useState<ModuleControlTargetType>("user");
  const [targetKey, setTargetKey] = React.useState("");
  const [draftSelection, setDraftSelection] = React.useState<{ ids: string[]; key: string } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);

  const targets = React.useMemo(() => targetBucket(data, targetType), [data, targetType]);
  const effectiveTargetKey = targets.some((option) => normalizeKey(option.value) === normalizeKey(targetKey))
    ? targetKey
    : targets[0]?.value ?? "";
  const target = React.useMemo(
    () => targets.find((option) => normalizeKey(option.value) === normalizeKey(effectiveTargetKey)) ?? null,
    [effectiveTargetKey, targets],
  );

  const navModules = React.useMemo(
    () => (data?.catalog ?? []).filter((navModule) => navModule.navigationMode === mode),
    [data, mode],
  );

  const moduleMap = React.useMemo(() => new Map(navModules.map((navModule) => [navModule.moduleId, navModule])), [navModules]);

  const savedIds = React.useMemo(
    () => selectedFromAssignments(data, mode, targetType, effectiveTargetKey),
    [data, effectiveTargetKey, mode, targetType],
  );

  const defaultAllowedIds = React.useMemo(() => {
    if (!data || !effectiveTargetKey) return [];
    return navModules
      .filter((navModule) =>
        !clientBlockReason({
          data,
          matrix: data.permissions,
          module: navModule,
          target,
          targetKey: effectiveTargetKey,
          targetType,
        }),
      )
      .map((navModule) => navModule.moduleId);
  }, [data, effectiveTargetKey, navModules, target, targetType]);

  const baseSelectedIds = savedIds.length > 0 ? savedIds : defaultAllowedIds;
  const selectionKey = `${mode}:${targetType}:${effectiveTargetKey}:${baseSelectedIds.join("|")}`;
  const selectedIds = draftSelection?.key === selectionKey ? draftSelection.ids : baseSelectedIds;

  const updateSelectedIds = React.useCallback((updater: string[] | ((current: string[]) => string[])) => {
    setDraftSelection((current) => {
      const currentIds = current?.key === selectionKey ? current.ids : baseSelectedIds;
      const nextIds = typeof updater === "function" ? updater(currentIds) : updater;
      return { ids: nextIds, key: selectionKey };
    });
  }, [baseSelectedIds, selectionKey]);

  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);

  const catalogRows = React.useMemo(() => {
    if (!data) return [];
    return navModules.map((navModule) => {
      const reason = effectiveTargetKey
        ? clientBlockReason({
            data,
            matrix: data.permissions,
            module: navModule,
            target,
            targetKey: effectiveTargetKey,
            targetType,
          })
        : "Blocked: choose a target first.";
      return { navModule, reason };
    });
  }, [data, effectiveTargetKey, navModules, target, targetType]);

  const selectedModules = selectedIds
    .map((moduleId) => moduleMap.get(moduleId))
    .filter((navModule): navModule is ModuleControlCatalogModule => Boolean(navModule));

  function addModule(navModule: ModuleControlCatalogModule) {
    if (!data || !effectiveTargetKey || selectedSet.has(navModule.moduleId)) return;
    const reason = clientBlockReason({ data, matrix: data.permissions, module: navModule, target, targetKey: effectiveTargetKey, targetType });
    if (reason) {
      setMessage(reason);
      return;
    }
    updateSelectedIds((current) => [...current, navModule.moduleId]);
    setMessage(null);
  }

  function removeModule(moduleId: string) {
    updateSelectedIds((current) => current.filter((id) => id !== moduleId));
  }

  function moveModule(moduleId: string, direction: -1 | 1) {
    updateSelectedIds((current) => {
      const index = current.indexOf(moduleId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
  }

  function reorderByDrop(moduleId: string, beforeModuleId: string) {
    if (moduleId === beforeModuleId) return;
    updateSelectedIds((current) => {
      const without = current.filter((id) => id !== moduleId);
      const beforeIndex = without.indexOf(beforeModuleId);
      if (beforeIndex < 0) return current;
      const next = [...without];
      next.splice(beforeIndex, 0, moduleId);
      return next;
    });
  }

  async function refresh() {
    setSaving(true);
    try {
      const nextData = await parseResponse(await fetch("/api/admin/modules-control", { method: "GET" }));
      setData(nextData);
      setError(null);
      setMessage("Modules Control reloaded.");
    } catch (refreshError) {
      setMessage(requestErrorMessage(refreshError));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (!effectiveTargetKey || selectedIds.length === 0) return;
    const rollbackIds = savedIds.length > 0 ? savedIds : defaultAllowedIds;
    setSaving(true);
    try {
      const nextData = await parseResponse(await fetch("/api/admin/modules-control", {
        body: JSON.stringify({
          moduleIds: selectedIds,
          navigationMode: mode,
          targetKey: effectiveTargetKey,
          targetType,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }));
      setData(nextData);
      setError(null);
      setMessage("Saved to database.");
    } catch (saveError) {
      setDraftSelection({ ids: rollbackIds, key: selectionKey });
      setMessage(requestErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!effectiveTargetKey) return;
    setSaving(true);
    try {
      const nextData = await parseResponse(await fetch("/api/admin/modules-control", {
        body: JSON.stringify({
          navigationMode: mode,
          targetKey: effectiveTargetKey,
          targetType,
        }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      }));
      setData(nextData);
      setError(null);
      setMessage("Reset to default sidebar.");
    } catch (resetError) {
      setMessage(requestErrorMessage(resetError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        compact
        description="Database-backed sidebar governance for admin and employee portal navigation."
        eyebrow="Super Admin"
        icon={<SlidersHorizontal className="h-4 w-4" />}
        title="Modules Control"
        actions={
          <Button className="gap-2" disabled={saving} onClick={refresh} variant="secondary">
            <RefreshCw className={cn("h-4 w-4", saving && "animate-spin")} />
            Reload
          </Button>
        }
      />

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      ) : null}
      {message ? (
        <div
          className={cn(
            "rounded-lg border px-4 py-3 text-sm font-medium",
            message.startsWith("Blocked") || message.toLowerCase().includes("failed")
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-700",
          )}
        >
          {message}
        </div>
      ) : null}

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 lg:grid-cols-[auto_auto_minmax(260px,1fr)]">
          <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-1">
            {modes.map((option) => (
              <button
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-semibold transition",
                  mode === option.value ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-950",
                )}
                key={option.value}
                onClick={() => setMode(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <SearchableSelect
            className="min-w-[170px]"
            onValueChange={(value) => setTargetType(value as ModuleControlTargetType)}
            value={targetType}
          >
            {targetTypes.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </SearchableSelect>
          <SearchableSelect
            className="min-w-0"
            disabled={targets.length === 0}
            onValueChange={setTargetKey}
            value={effectiveTargetKey}
          >
            {targets.map((option) => (
              <option key={`${option.type}:${option.value}`} value={option.value}>{option.label}</option>
            ))}
          </SearchableSelect>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">System Modules</h2>
              <p className="text-xs text-slate-500">{catalogRows.length} modules</p>
            </div>
            <ShieldAlert className="h-5 w-5 text-amber-500" />
          </div>
          <div className="grid max-h-[620px] gap-2 overflow-y-auto p-3 md:grid-cols-2">
            {catalogRows.map(({ navModule, reason }) => {
              const blocked = Boolean(reason);
              const selected = selectedSet.has(navModule.moduleId);
              return (
                <div
                  className={cn(
                    "rounded-lg border p-3 transition",
                    blocked
                      ? "border-slate-200 bg-slate-50 text-slate-500"
                      : "border-slate-200 bg-white text-slate-900 hover:border-orange-200 hover:bg-orange-50/30",
                    selected && "border-emerald-200 bg-emerald-50/50",
                  )}
                  draggable={!blocked && !selected}
                  key={navModule.moduleId}
                  onDragStart={() => !blocked && !selected && setDraggingId(navModule.moduleId)}
                  title={reason ?? modulePermissionLabel(navModule)}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{navModule.label}</div>
                      <div className="truncate text-xs text-slate-500">{navModule.sectionLabel}</div>
                      <div className="mt-1 truncate text-[11px] text-slate-400">{modulePermissionLabel(navModule)}</div>
                    </div>
                    <button
                      aria-label={selected ? `Remove ${navModule.label}` : `Add ${navModule.label}`}
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition",
                        selected
                          ? "border-emerald-200 bg-white text-emerald-600"
                          : blocked
                            ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                            : "border-slate-200 bg-white text-slate-700 hover:border-orange-200 hover:text-orange-600",
                      )}
                      disabled={!canManage || blocked}
                      onClick={() => selected ? removeModule(navModule.moduleId) : addModule(navModule)}
                      title={reason ?? (selected ? "Remove" : "Add")}
                      type="button"
                    >
                      {selected ? <CheckCircle2 className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
                    </button>
                  </div>
                  {blocked ? <div className="mt-2 line-clamp-2 text-xs text-amber-700">{reason}</div> : null}
                </div>
              );
            })}
          </div>
        </section>

        <section
          className="rounded-lg border border-slate-200 bg-white shadow-sm"
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => {
            const navModule = draggingId ? moduleMap.get(draggingId) : null;
            if (navModule && !selectedSet.has(navModule.moduleId)) addModule(navModule);
            setDraggingId(null);
          }}
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">Saved Order</h2>
              <p className="text-xs text-slate-500">{selectedModules.length} modules</p>
            </div>
            <div className="flex items-center gap-2">
              <Button className="gap-2" disabled={!canManage || saving || !effectiveTargetKey} onClick={reset} variant="secondary">
                <RotateCcw className="h-4 w-4" />
                Reset
              </Button>
              <Button className="gap-2" disabled={!canManage || saving || !effectiveTargetKey || selectedIds.length === 0} onClick={save}>
                <Save className="h-4 w-4" />
                Save
              </Button>
            </div>
          </div>
          <div className="max-h-[620px] space-y-2 overflow-y-auto p-3">
            {selectedModules.map((navModule, index) => (
              <div
                className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition hover:border-orange-200"
                draggable
                key={navModule.moduleId}
                onDragOver={(event) => event.preventDefault()}
                onDragStart={() => setDraggingId(navModule.moduleId)}
                onDrop={() => {
                  if (draggingId) reorderByDrop(draggingId, navModule.moduleId);
                  setDraggingId(null);
                }}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-bold text-slate-600">
                    {index + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-950">{navModule.label}</div>
                    <div className="truncate text-xs text-slate-500">{navModule.sectionLabel}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      aria-label={`Move ${navModule.label} up`}
                      className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:border-orange-200 hover:text-orange-600 disabled:opacity-40"
                      disabled={index === 0}
                      onClick={() => moveModule(navModule.moduleId, -1)}
                      type="button"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      aria-label={`Move ${navModule.label} down`}
                      className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:border-orange-200 hover:text-orange-600 disabled:opacity-40"
                      disabled={index === selectedModules.length - 1}
                      onClick={() => moveModule(navModule.moduleId, 1)}
                      type="button"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <button
                      aria-label={`Remove ${navModule.label}`}
                      className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:border-rose-200 hover:text-rose-600"
                      onClick={() => removeModule(navModule.moduleId)}
                      type="button"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {selectedModules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm font-medium text-slate-500">
                No modules selected.
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
