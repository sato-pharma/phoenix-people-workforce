"use client";

import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  LockKeyhole,
  Mail,
  Pencil,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
} from "lucide-react";
import * as React from "react";

import {
  AdminCallout,
  AdminTableShell,
  AdminSectionHeader,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type {
  AccessUserRow,
  AuditLogRow,
  PhoenixLine,
} from "@/lib/admin/access-control";
import {
  getPayrollScope,
  getSalesScope,
  permissionActions,
  permissionResources,
  phoenixRoles,
  type BusinessScope,
  type PermissionAction,
  type PermissionMap,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";

type EmployeeOption = {
  hrId: string;
  line: PhoenixLine;
  managerHrId: string | null;
  name: string;
};

type DashboardData = {
  auditLogs: AuditLogRow[];
  employees: EmployeeOption[];
  lines: readonly PhoenixLine[];
  permissions: PermissionMap;
  roles: typeof phoenixRoles;
  users: AccessUserRow[];
};

type RowResult = {
  row: number;
  hrId: string;
  name: string;
  role: string;
  line: string;
  action: "created" | "updated" | "skipped" | "error";
  errors: string[];
};

type Props = {
  initialData?: DashboardData | null;
  initialError?: string | null;
};

type FormState = {
  email: string;
  hrId: string;
  isActive: boolean;
  line: PhoenixLine;
  loginId: string;
  managerHrId: string;
  name: string;
  role: PhoenixRole;
  salesScopeOverride: BusinessScope | "";
};

const emptyForm: FormState = {
  email: "",
  hrId: "",
  isActive: true,
  line: "Other",
  loginId: "",
  managerHrId: "",
  name: "",
  role: "Employee",
  salesScopeOverride: "",
};

const pageSize = 8;
const scopes: BusinessScope[] = [
  "SELF",
  "TEAM",
  "HIERARCHY",
  "LINE",
  "COMPANY",
  "NONE",
];

const panelClassName =
  "rounded-xl border border-slate-200 bg-white shadow-sm";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function getScopeSemanticClasses(scope: BusinessScope) {
  const scopeClasses = {
    SELF: {
      bg: "bg-gradient-to-r from-sky-50 to-blue-50",
      text: "text-sky-700",
      border: "border-sky-200/60",
      shadow: "shadow-sm"
    },
    TEAM: {
      bg: "bg-gradient-to-r from-teal-50 to-cyan-50",
      text: "text-teal-700",
      border: "border-teal-200/60",
      shadow: "shadow-sm"
    },
    HIERARCHY: {
      bg: "bg-gradient-to-r from-indigo-50 to-violet-50",
      text: "text-indigo-700",
      border: "border-indigo-200/60",
      shadow: "shadow-sm"
    },
    LINE: {
      bg: "bg-gradient-to-r from-amber-50 to-orange-50",
      text: "text-amber-700",
      border: "border-amber-200/60",
      shadow: "shadow-sm"
    },
    COMPANY: {
      bg: "bg-gradient-to-r from-violet-50 to-purple-50",
      text: "text-violet-700",
      border: "border-violet-200/60",
      shadow: "shadow-sm"
    },
    NONE: {
      bg: "bg-gradient-to-r from-slate-100 to-stone-50",
      text: "text-slate-600",
      border: "border-slate-200/60",
      shadow: "shadow-sm"
    }
  };
  return scopeClasses[scope] || scopeClasses.NONE;
}

export function AccessControlManager({
  initialData = null,
  initialError = null,
}: Props) {
  const [data, setData] = React.useState<DashboardData | null>(initialData);
  const [error, setError] = React.useState<string | null>(initialError);
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState("all");
  const [lineFilter, setLineFilter] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [uploadResults, setUploadResults] = React.useState<RowResult[] | null>(null);
  const [permissionSaving, setPermissionSaving] = React.useState<string | null>(null);
  const [setupLinkMessage, setSetupLinkMessage] = React.useState<string | null>(null);
  const [setupLinkSending, setSetupLinkSending] = React.useState<string | null>(null);
  const [showPermissions, setShowPermissions] = React.useState(false);
  const [showAudit, setShowAudit] = React.useState(false);

  async function updatePermission(
    role: PhoenixRole,
    resource: PermissionResource,
    action: PermissionAction,
    isAllowed: boolean,
  ) {
    setError(null);
    const key = `${role}:${resource}:${action}`;
    setPermissionSaving(key);
    try {
      const response = await fetch("/api/admin/permissions", {
        body: JSON.stringify({
          action,
          isAllowed,
          resource,
          role,
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "Permission update failed.");
      setData(payload);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Permission update failed.");
    } finally {
      setPermissionSaving(null);
    }
  }

  async function loadUsers() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "Access control failed to load.");
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Access control failed to load.");
    } finally {
      setIsLoading(false);
    }
  }

  async function saveUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setSetupLinkMessage(null);
    const loginId = form.hrId.trim() || form.loginId.trim();
    if (!loginId) {
      setError("HR_ID is required.");
      setIsSaving(false);
      return;
    }

    try {
      const response = await fetch("/api/admin/users", {
        body: JSON.stringify({
          ...form,
          loginId,
          salesScopeOverride: form.salesScopeOverride || null,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "User could not be saved.");
      setData(payload);
      setForm(emptyForm);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "User could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function uploadBulkUsers(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploadResults(null);
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await fetch("/api/admin/users/bulk", { body, method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        setUploadResults(payload.rowResults || null);
        const failedCount = payload.failed || 0;
        const createdCount = payload.created || 0;
        const updatedCount = payload.updated || 0;
        throw new Error(
          `Bulk upload completed with errors: ${createdCount} created, ${updatedCount} updated, ${failedCount} failed. ` +
            (payload.errors?.join(" ") || payload.message || "See details below."),
        );
      }
      setData(payload.dashboard);
      setUploadResults(payload.rowResults || null);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Bulk upload failed.");
    } finally {
      event.target.value = "";
    }
  }

  async function toggleUser(user: AccessUserRow) {
    setError(null);
    const response = await fetch("/api/admin/users", {
      body: JSON.stringify({ isActive: !user.isActive, loginId: user.loginId }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload?.message ?? "User status could not be updated.");
      return;
    }
    setData(payload);
  }

  async function sendSetupLink(user: AccessUserRow, deliveryMode: "copy" | "email") {
    setError(null);
    setSetupLinkMessage(null);
    setSetupLinkSending(`${user.loginId}:${deliveryMode}`);

    try {
      const response = await fetch("/api/admin/users/setup-link", {
        body: JSON.stringify({
          deliveryMode,
          loginId: user.loginId,
          purpose: user.forcePasswordReset ? "setup" : "reset",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | { deliveryMessage?: string; message?: string; setupUrl?: string }
        | null;

      if (!response.ok) {
        throw new Error(payload?.message ?? "Password link could not be sent.");
      }

      if (deliveryMode === "copy" && payload?.setupUrl) {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(payload.setupUrl);
          setSetupLinkMessage(`Password link copied to clipboard for ${user.loginId}.`);
        } else {
          setSetupLinkMessage(`Copy this password link for ${user.loginId}: ${payload.setupUrl}`);
        }
      } else {
        setSetupLinkMessage(
          payload?.setupUrl
            ? `${payload.deliveryMessage ?? "Password link generated."} Link: ${payload.setupUrl}`
            : payload?.deliveryMessage ?? "Password link sent.",
        );
      }
      await loadUsers();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Password link could not be sent.");
    } finally {
      setSetupLinkSending(null);
    }
  }

  function editUser(user: AccessUserRow) {
    setForm({
      email: user.email ?? "",
      hrId: user.hrId ?? "",
      isActive: user.isActive,
      line: user.line,
      loginId: user.loginId,
      managerHrId: user.managerHrId ?? "",
      name: user.name,
      role: user.role,
      salesScopeOverride: user.salesScopeOverride ?? "",
    });
  }

  const users = data?.users ?? [];
  const filteredUsers = users.filter((user) => {
    const haystack = [user.name, user.hrId, user.role, user.line, user.loginId, user.email]
      .join(" ")
      .toLowerCase();
    if (query && !haystack.includes(query.toLowerCase())) return false;
    if (roleFilter !== "all" && user.role !== roleFilter) return false;
    if (lineFilter !== "all" && user.line !== lineFilter) return false;
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const visibleUsers = filteredUsers.slice((page - 1) * pageSize, page * pageSize);
  const activeUsers = users.filter((user) => user.isActive).length;
  const companyPayrollUsers = users.filter((user) => user.payrollScope === "COMPANY").length;
  const salesOverrides = users.filter((user) => user.salesScopeOverride).length;
  const auditEntries = data?.auditLogs.length ?? 0;
  const hasDashboard = data !== null;
  const hasUsers = filteredUsers.length > 0;
  const lineOptions = data?.lines ?? ["CNS", "Pedia", "Anti-Infective", "Office", "Other"];

  const statCards = [
    {
      description: "Enabled identities with access to protected workflows.",
      icon: Users,
      label: "Active users",
      value: activeUsers,
    },
    {
      description: "Roles currently carrying company-wide payroll visibility.",
      icon: ShieldCheck,
      label: "Company payroll",
      value: companyPayrollUsers,
    },
    {
      description: "Manually tuned sales scopes outside the default role model.",
      icon: Sparkles,
      label: "Sales overrides",
      value: salesOverrides,
    },
    {
      description: "Recent access-control actions recorded for traceability.",
      icon: LockKeyhole,
      label: "Audit entries",
      value: auditEntries,
    },
  ] as const;

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[24px] border border-slate-200/80 bg-gradient-to-b from-stone-50 to-stone-100/50 p-6 shadow-[0_1px_3px_rgba(0,0,0,0.05)] sm:p-8">
      <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex-1">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-violet-500/20 bg-violet-500/5 px-3 py-1 backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-400 shadow-[0_0_6px_rgba(139,92,246,0.5)]" />
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-violet-200">Identity Governance</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">Users & Access</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-500">
            Manage identities, role scopes, permission overrides, and onboarding links with full audit traceability.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-700 border border-emerald-200/60">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
              <span className="font-medium">Governance Active</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1 text-sky-700 border border-sky-200/60">
              <ShieldCheck className="h-3 w-3" />
              <span className="font-medium">RLS Protected</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 shadow-sm transition-all duration-160 ease-out hover:border-slate-300 hover:bg-slate-50 hover:shadow-md hover:-translate-y-px"
              download
              href="/api/admin/users/bulk"
              rel="noopener noreferrer"
              target="_blank"
            >
              <Download className="h-3.5 w-3.5 text-slate-500" />
              Download template
            </a>
            <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 shadow-sm transition-all duration-160 ease-out hover:border-slate-300 hover:bg-slate-50 hover:shadow-md hover:-translate-y-px">
              <Upload className="h-3.5 w-3.5 text-slate-500" />
              Bulk upload
              <input accept=".xlsx,.xls" className="sr-only" onChange={uploadBulkUsers} type="file" />
            </label>
            <Button
              className="h-9 rounded-lg px-3.5 text-xs font-medium transition-all duration-160 ease-out hover:shadow-md hover:-translate-y-px active:scale-95"
              disabled={isLoading}
              onClick={loadUsers}
              variant="secondary"
            >
              {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
          <span>{error}</span>
        </AdminCallout>
      )}

      {setupLinkMessage && (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{setupLinkMessage}</span>
        </AdminCallout>
      )}

      {uploadResults && (
        <AdminTableShell
          action={
            <Button className="h-9 rounded-xl px-3 text-xs" onClick={() => setUploadResults(null)} variant="secondary">
              Dismiss
            </Button>
          }
          description={`${uploadResults.filter((r) => r.action === "created").length} created, ${uploadResults.filter((r) => r.action === "updated").length} updated, ${uploadResults.filter((r) => r.action === "skipped").length} skipped, ${uploadResults.filter((r) => r.action === "error").length} failed`}
          title="Upload validation results"
        >
          <div className="max-h-96 overflow-y-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                <tr>
                  <th className="px-4 py-3">Row</th>
                  <th className="px-4 py-3">HR_ID</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Line</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Errors</th>
                </tr>
              </thead>
              <tbody>
                {uploadResults.map((result) => (
                  <tr className="border-b border-[#E2E8F0]" key={result.row}>
                    <td className="px-4 py-2 font-mono text-xs">{result.row}</td>
                    <td className="px-4 py-2">{result.hrId}</td>
                    <td className="px-4 py-2">{result.name}</td>
                    <td className="px-4 py-2">{result.role}</td>
                    <td className="px-4 py-2">{result.line}</td>
                    <td className="px-4 py-2">
                      <Badge
                        variant={
                          result.action === "created" || result.action === "updated"
                            ? "success"
                            : result.action === "skipped"
                              ? "neutral"
                              : "danger"
                        }
                      >
                        {result.action}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-xs text-[#DC2626]">
                      {result.errors.length > 0 ? result.errors.join(", ") : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminTableShell>
      )}

      {hasDashboard ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {statCards.map((card) => {
              const Icon = card.icon;
              const getCardAccent = () => {
                if (card.label === "Active users") {
                  return {
                    bg: "bg-gradient-to-r from-orange-50 to-orange-100/50",
                    iconBg: "bg-gradient-to-br from-orange-100 to-orange-50",
                    iconText: "text-orange-600",
                    border: "border-orange-200/60",
                    glow: ""
                  };
                }
                if (card.label === "Company payroll") {
                  return {
                    bg: "bg-gradient-to-r from-sky-50 to-sky-100/50",
                    iconBg: "bg-gradient-to-br from-sky-100 to-sky-50",
                    iconText: "text-sky-600",
                    border: "border-sky-200/60",
                    glow: ""
                  };
                }
                if (card.label === "Sales overrides") {
                  return {
                    bg: "bg-gradient-to-r from-violet-50 to-violet-100/50",
                    iconBg: "bg-gradient-to-br from-violet-100 to-violet-50",
                    iconText: "text-violet-600",
                    border: "border-violet-200/60",
                    glow: ""
                  };
                }
                if (card.label === "Audit entries") {
                  return {
                    bg: "bg-gradient-to-r from-rose-50 to-rose-100/50",
                    iconBg: "bg-gradient-to-br from-rose-100 to-rose-50",
                    iconText: "text-rose-600",
                    border: "border-rose-200/60",
                    glow: ""
                  };
                }
                return {
                  bg: "bg-gradient-to-r from-slate-50 to-white",
                  iconBg: "bg-gradient-to-br from-slate-100 to-slate-50",
                  iconText: "text-slate-600",
                  border: "border-slate-200",
                  glow: ""
                };
              };
              const accent = getCardAccent();
              const isOperationalKPI = card.label === "Company payroll" || card.label === "Audit entries" || card.label === "Sales overrides";
              return (
                <div key={card.label} className={`relative overflow-hidden rounded-xl border ${accent.border} ${accent.bg} px-5 py-4 shadow-sm transition-all duration-160 ease-out hover:shadow-md hover:-translate-y-px ${accent.glow}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">{card.label}</p>
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
                        {isOperationalKPI && (
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping absolute" style={{ animationDuration: '1.5s' }} />
                        )}
                      </div>
                      <div className="mt-2 text-2xl font-semibold text-slate-900">{card.value}</div>
                    </div>
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${accent.iconBg} ${accent.iconText} shadow-sm transition-all duration-160 ease-out hover:scale-105`}>
                      <Icon className="h-4 w-4" />
                    </div>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-500">{card.description}</p>
                </div>
              );
            })}
          </div>

          <div className="grid gap-8 xl:grid-cols-[420px_minmax(0,1fr)]">
            <Card className={`${panelClassName} h-fit p-0 xl:sticky xl:top-6`}>
              <AdminSectionHeader
                action={<div className="text-xs font-semibold text-[#0F172A]">Active</div>}
                description="Create or update a user profile, then issue setup and reset links from the user table."
                title="User editor"
              />

              <form className="grid gap-5 px-5 py-5" onSubmit={saveUser}>
                <div className="space-y-4">
                  <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Identity</div>
                  <div className="grid gap-3">
                    <Input
                      className="h-9 rounded-lg border-slate-200 bg-white px-3 text-sm font-medium transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Full name"
                      value={form.name}
                    />
                    <Input
                      className="h-9 rounded-lg border-slate-200 bg-white px-3 text-sm font-medium transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      onChange={(e) => {
                        const hrId = e.target.value;
                        setForm((p) => ({
                          ...p,
                          hrId,
                          loginId: hrId,
                        }));
                      }}
                      placeholder="HR_ID"
                      value={form.hrId}
                    />
                    <Input
                      className="h-9 rounded-lg border-slate-200 bg-white px-3 text-sm font-medium transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                      placeholder="Email"
                      type="email"
                      value={form.email}
                    />
                  </div>
                </div>

                <div className="h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

                <div className="space-y-4">
                  <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Organization</div>
                  <div className="grid gap-3">
                    <select
                      className="h-9 w-full rounded-lg border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as PhoenixRole }))}
                      value={form.role}
                    >
                      {phoenixRoles.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <select
                        className="h-9 w-full rounded-lg border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                        onChange={(e) => setForm((p) => ({ ...p, line: e.target.value as PhoenixLine }))}
                        value={form.line}
                      >
                        {lineOptions.map((line) => (
                          <option key={line} value={line}>
                            {line}
                          </option>
                        ))}
                      </select>
                      <Input
                        className="h-9 rounded-lg border-slate-200 bg-white px-3 text-sm font-medium transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                        onChange={(e) => setForm((p) => ({ ...p, managerHrId: e.target.value }))}
                        placeholder="Manager HR_ID"
                        value={form.managerHrId}
                      />
                    </div>
                  </div>
                </div>

                <div className="h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

                <div className="space-y-4">
                  <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Access scope</div>
                  <div className="grid gap-3">
                    <select
                      className="h-9 w-full rounded-lg border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      onChange={(e) =>
                        setForm((p) => ({ ...p, salesScopeOverride: e.target.value as BusinessScope | "" }))
                      }
                      value={form.salesScopeOverride}
                    >
                      <option value="">Automatic sales scope</option>
                      {scopes.map((scope) => (
                        <option key={scope} value={scope}>
                          {scope}
                        </option>
                      ))}
                    </select>
                    <div className="rounded-lg border border-orange-200/80 bg-gradient-to-r from-orange-50/50 to-white p-3 text-sm text-orange-800 shadow-sm transition-all duration-160 ease-out hover:shadow-md">
                      <div className="flex items-center gap-2 font-medium">
                        <LockKeyhole className="h-4 w-4" />
                        Scope preview
                      </div>
                      <p className="mt-2 leading-5">
                        Payroll scope:{" "}
                        <span className="font-semibold">{getPayrollScope({ role: form.role })}</span>. Sales scope:{" "}
                        <span className="font-semibold">
                          {getSalesScope({
                            role: form.role,
                            salesScopeOverride: form.salesScopeOverride || null,
                          })}
                        </span>
                        .
                      </p>
                    </div>
                  </div>
                </div>

                <div className="h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

                <div className="space-y-4">
                  <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Status</div>
                  <div className="grid gap-3">
                    <div className="rounded-lg border border-slate-200 bg-stone-50 p-3 text-sm leading-5 text-slate-600 transition-all duration-160 ease-out hover:bg-stone-100">
                      New users start in password-setup mode. After saving, use the setup link action from the list to
                      complete onboarding.
                    </div>
                    <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-stone-50 px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-stone-100 transition-all duration-160 ease-out">
                      Active account
                      <input
                        checked={form.isActive}
                        className="h-4 w-4 accent-orange-500 transition-all duration-160 ease-out"
                        onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))}
                        type="checkbox"
                      />
                    </label>
                  </div>
                </div>

                <Button className="h-9 w-full gap-2 rounded-lg text-sm font-medium transition-all duration-160 ease-out hover:shadow-sm active:scale-95" disabled={isSaving} type="submit">
                  {isSaving ? <LoadingSpinner /> : <CheckCircle2 className="h-4 w-4" />}
                  Save user
                </Button>
              </form>
            </Card>

            <Card className={`${panelClassName} overflow-hidden p-0`}>
              <AdminSectionHeader
                action={
                  <div className="flex items-center gap-2">
                    <Badge variant="neutral">{filteredUsers.length} visible</Badge>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
                  </div>
                }
                description="Search, filter, edit, enable, and disable accounts without leaving the page."
                title="Users list"
              />

              <div className="border-b border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700 border border-emerald-200/60">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
                    <span className="font-medium">Governance Active</span>
                  </div>
                  <div className="flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-sky-700 border border-sky-200/60">
                    <ShieldCheck className="h-3 w-3" />
                    <span className="font-medium">RLS Protected</span>
                  </div>
                  <div className="flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-violet-700 border border-violet-200/60">
                    <LockKeyhole className="h-3 w-3" />
                    <span className="font-medium">Audit Enabled</span>
                  </div>
                </div>
              </div>

              <div className="border-b border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 p-4">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_200px_160px]">
                  <div className="relative group">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400 transition-colors duration-160 ease-out group-focus-within:text-orange-500" />
                    <Input
                      className="h-9 rounded-lg border-slate-200 bg-white pl-9 text-sm font-medium transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)] hover:border-slate-300 hover:shadow-sm placeholder:text-slate-400"
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setPage(1);
                      }}
                      placeholder="Search name, HR_ID, role, line"
                      value={query}
                    />
                  </div>
                  <select
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                    onChange={(e) => {
                      setRoleFilter(e.target.value);
                      setPage(1);
                    }}
                    value={roleFilter}
                  >
                    <option value="all">All roles</option>
                    {phoenixRoles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  <select
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                    onChange={(e) => {
                      setLineFilter(e.target.value);
                      setPage(1);
                    }}
                    value={lineFilter}
                  >
                    <option value="all">All lines</option>
                    {(data?.lines ?? []).map((line) => (
                      <option key={line} value={line}>
                        {line}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent shadow-[0_1px_0_0_rgba(0,0,0,0.02)]" />

              <div className="overflow-x-auto">
                <table className="min-w-full text-left">
                  <thead className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/95 backdrop-blur-sm text-[11px] font-bold uppercase tracking-[0.12em] text-slate-600">
                    <tr>
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Role / Line</th>
                      <th className="px-4 py-3">Access</th>
                      <th className="px-3 py-3">Password</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100/80">
                    {hasUsers ? (
                      visibleUsers.map((user) => {
                        const isHighAuthority = user.role === "Super Admin" || user.role === "CEO";
                        return (
                          <tr
                            className={`group relative transition-all duration-160 ease-out hover:bg-gradient-to-r hover:from-orange-50/50 hover:via-orange-50/30 hover:to-transparent hover:shadow-[0_0_0_1px_rgba(249,115,22,0.12)_inset,0_2px_8px_rgba(249,115,22,0.06),0_1px_4px_rgba(15,23,42,0.03)] hover:-translate-y-0.5 ${isHighAuthority ? "bg-gradient-to-r from-violet-50/30 via-violet-50/10 to-transparent" : ""}`}
                            key={user.loginId}
                          >
                          <td className="px-4 py-3 align-top">
                            <div className="flex items-start gap-2.5">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-100 to-orange-50 text-orange-700 font-semibold text-sm shadow-sm transition-all duration-160 ease-out group-hover:scale-110 group-hover:shadow-md group-hover:from-orange-200 group-hover:to-orange-100">
                                {user.name.charAt(0).toUpperCase()}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-slate-900 transition-colors duration-160 ease-out group-hover:text-orange-950">{user.name}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600">
                                  <span className="font-mono text-slate-700">{user.hrId ?? "-"}</span>
                                  <span className="text-slate-400">/</span>
                                  <span className="font-mono text-slate-700">{user.loginId}</span>
                                  {user.email && (
                                    <>
                                      <span className="text-slate-400">·</span>
                                      <span className="truncate text-slate-700">{user.email}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="flex flex-col gap-1.5">
                              <div className="flex items-center gap-1.5">
                                {(() => {
                                  const isHighAuthority = user.role === "Super Admin" || user.role === "CEO";
                                  const isMidAuthority = user.role === "Finance Manager" || user.role === "HR Specialist";
                                  if (isHighAuthority) {
                                    return (
                                      <>
                                        <span className="inline-flex items-center rounded-md bg-gradient-to-r from-violet-50 to-purple-50 px-2 py-1 text-xs font-medium text-violet-700 shadow-sm transition-all duration-160 ease-out hover:shadow-md border border-violet-200/60 relative">
                                          {user.role}
                                          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-violet-500 animate-pulse" style={{ animationDuration: '1.5s' }} />
                                        </span>
                                      </>
                                    );
                                  }
                                  if (isMidAuthority) {
                                    return (
                                      <span className="inline-flex items-center rounded-md bg-gradient-to-r from-emerald-50 to-emerald-100/50 px-2 py-1 text-xs font-medium text-emerald-700 shadow-sm transition-all duration-160 ease-out hover:shadow-md border border-emerald-200/60">
                                        {user.role}
                                      </span>
                                    );
                                  }
                                  return (
                                    <span className="inline-flex items-center rounded-md bg-gradient-to-r from-violet-50 to-purple-50 px-2 py-1 text-xs font-medium text-violet-700 shadow-sm transition-all duration-160 ease-out hover:shadow-md border border-violet-200/60">
                                      {user.role}
                                    </span>
                                  );
                                })()}
                              </div>
                              <span className="text-xs text-slate-700 font-medium">{user.line}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="flex flex-col gap-1.5">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Sales</span>
                                {(() => {
                                  const classes = getScopeSemanticClasses(user.salesScope);
                                  return (
                                    <span className={`inline-flex items-center rounded-md ${classes.bg} px-2 py-0.5 text-xs font-medium ${classes.text} ${classes.shadow} transition-all duration-160 ease-out hover:shadow-md border ${classes.border}`}>
                                      {user.salesScope}
                                    </span>
                                  );
                                })()}
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Payroll</span>
                                {(() => {
                                  const classes = getScopeSemanticClasses(user.payrollScope);
                                  return (
                                    <span className={`inline-flex items-center rounded-md ${classes.bg} px-2 py-0.5 text-xs font-medium ${classes.text} ${classes.shadow} transition-all duration-160 ease-out hover:shadow-md border ${classes.border}`}>
                                      {user.payrollScope}
                                    </span>
                                  );
                                })()}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium shadow-sm transition-all duration-160 ease-out hover:shadow-md border ${
                              user.forcePasswordReset
                                ? "bg-gradient-to-r from-amber-50 to-amber-100/50 text-amber-700 border-amber-200/60"
                                : "bg-gradient-to-r from-emerald-50 to-emerald-100/50 text-emerald-700 border-emerald-200/60"
                            }`}>
                              {user.forcePasswordReset ? "setup required" : "ready"}
                            </span>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium shadow-sm transition-all duration-160 ease-out hover:shadow-md border ${
                              user.isActive
                                ? "bg-gradient-to-r from-emerald-50 to-emerald-100/50 text-emerald-700 border-emerald-200/60"
                                : "bg-gradient-to-r from-stone-100 to-stone-50 text-stone-600 border-stone-200/60"
                            }`}>
                              {user.isActive ? "active" : "inactive"}
                            </span>
                          </td>
                          <td className="px-3 py-3 align-top text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-all duration-160 ease-out hover:bg-orange-50 hover:text-orange-600 hover:shadow-[0_0_0_1px_rgba(249,115,22,0.12)_inset,0_2px_8px_rgba(249,115,22,0.1)] active:scale-95 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-500 disabled:hover:shadow-none"
                                onClick={() => editUser(user)}
                                title="Edit User"
                                type="button"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-all duration-160 ease-out hover:bg-sky-50 hover:text-sky-600 hover:shadow-[0_0_0_1px_rgba(14,165,233,0.12)_inset,0_2px_8px_rgba(14,165,233,0.1)] active:scale-95 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-500 disabled:hover:shadow-none"
                                disabled={setupLinkSending !== null || !user.isActive}
                                onClick={() => sendSetupLink(user, "email")}
                                title={user.forcePasswordReset ? "Email Setup Link" : "Email Reset Link"}
                                type="button"
                              >
                                {setupLinkSending === `${user.loginId}:email` ? (
                                  <LoadingSpinner className="h-4 w-4" />
                                ) : (
                                  <Mail className="h-4 w-4" />
                                )}
                              </button>
                              <button
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-all duration-160 ease-out hover:bg-violet-50 hover:text-violet-600 hover:shadow-[0_0_0_1px_rgba(139,92,246,0.12)_inset,0_2px_8px_rgba(139,92,246,0.1)] active:scale-95 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-slate-500 disabled:hover:shadow-none"
                                disabled={setupLinkSending !== null || !user.isActive}
                                onClick={() => sendSetupLink(user, "copy")}
                                title={user.forcePasswordReset ? "Copy Setup Link" : "Copy Reset Link"}
                                type="button"
                              >
                                {setupLinkSending === `${user.loginId}:copy` ? (
                                  <LoadingSpinner className="h-4 w-4" />
                                ) : (
                                  <Copy className="h-4 w-4" />
                                )}
                              </button>
                              <button
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-all duration-160 ease-out hover:bg-rose-50 hover:text-rose-600 hover:shadow-[0_0_0_1px_rgba(244,63,94,0.12)_inset,0_2px_8px_rgba(244,63,94,0.1)] active:scale-95"
                                onClick={() => toggleUser(user)}
                                title={user.isActive ? "Disable Account" : "Enable Account"}
                                type="button"
                              >
                                {user.isActive ? (
                                  <Ban className="h-4 w-4" />
                                ) : (
                                  <CheckCircle2 className="h-4 w-4" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td className="px-4 py-16" colSpan={6}>
                          <div className="mx-auto flex max-w-md flex-col items-center text-center">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200/80 bg-gradient-to-br from-slate-50 to-white text-slate-400 shadow-sm">
                              <Users className="h-6 w-6" />
                            </div>
                            <p className="mt-5 text-base font-semibold text-slate-900">
                              {query || roleFilter !== "all" || lineFilter !== "all"
                                ? "No matching users"
                                : "No users added yet"}
                            </p>
                            <p className="mt-2 text-sm text-slate-500">
                              {query || roleFilter !== "all" || lineFilter !== "all"
                                ? "Try widening your filters or clearing the search to see the full directory."
                                : "Create the first admin profile or import a prepared workbook to populate access records."}
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 px-5 py-4 text-sm">
                <span className="text-slate-600 font-medium">{filteredUsers.length} users</span>
                <div className="flex items-center gap-2">
                  <Button
                    className="h-8 w-8 rounded-lg px-2 transition-all duration-200 hover:bg-slate-100 hover:shadow-sm active:scale-95"
                    disabled={page === 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    variant="secondary"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-gradient-to-r from-slate-100 to-slate-50 rounded-lg shadow-sm">
                    {page} / {pageCount}
                  </span>
                  <Button
                    className="h-8 w-8 rounded-lg px-2 transition-all duration-200 hover:bg-slate-100 hover:shadow-sm active:scale-95"
                    disabled={page === pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    variant="secondary"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Card>
          </div>

          <Card className={`${panelClassName} overflow-hidden p-0`}>
            <button
              className="flex w-full items-center justify-between border-b border-slate-200/80 px-5 py-4 text-left transition-colors hover:bg-stone-50"
              onClick={() => setShowPermissions((current) => !current)}
              type="button"
            >
              <AdminSectionHeader
                action={null}
                description="Role-level permission matrix and overrides."
                title="Advanced permissions"
              />
              {showPermissions ? (
                <ChevronUp className="h-4 w-4 text-slate-400" />
              ) : (
                <ChevronDown className="h-4 w-4 text-slate-400" />
              )}
            </button>
            {showPermissions && (
              <div className="border-t border-slate-200/80 overflow-x-auto">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-stone-50 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Role</th>
                      <th className="px-4 py-3">Sales</th>
                      <th className="px-4 py-3">Payroll</th>
                      {permissionResources.map((resource) => (
                        <th className="px-4 py-3" key={resource}>
                          {resource}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {phoenixRoles.map((role) => (
                      <tr className="border-b border-slate-100/80 transition-colors hover:bg-stone-50/50" key={role}>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium border ${
                            role === "Super Admin" || role === "CEO"
                              ? "bg-gradient-to-r from-rose-50 to-orange-50 text-rose-700 border-rose-200/60"
                              : role === "HR Specialist" || role === "Finance Manager"
                              ? "bg-gradient-to-r from-emerald-50 to-emerald-100/50 text-emerald-700 border-emerald-200/60"
                              : "bg-gradient-to-r from-violet-50 to-purple-50 text-violet-700 border-violet-200/60"
                          }`}>
                            {role}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            const classes = getScopeSemanticClasses(getSalesScope({ role }));
                            return (
                              <span className={`inline-flex items-center rounded-md ${classes.bg} px-2 py-0.5 text-xs font-medium ${classes.text} border ${classes.border} ${classes.shadow}`}>
                                {getSalesScope({ role })}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            const classes = getScopeSemanticClasses(getPayrollScope({ role }));
                            return (
                              <span className={`inline-flex items-center rounded-md ${classes.bg} px-2 py-0.5 text-xs font-medium ${classes.text} border ${classes.border} ${classes.shadow}`}>
                                {getPayrollScope({ role })}
                              </span>
                            );
                          })()}
                        </td>
                        {permissionResources.map((resource) => {
                          const allowedActions = data?.permissions?.[role]?.[resource] ?? [];
                          return (
                            <td className="border-l border-slate-100/80 px-4 py-3" key={`${role}-${resource}`}>
                              <div className="flex flex-wrap gap-2">
                                {permissionActions.map((action) => (
                                  <label className="flex items-center gap-1.5 text-[10px] cursor-pointer hover:text-slate-700 transition-colors" key={`${role}-${resource}-${action}`}>
                                    <input
                                      checked={allowedActions.includes(action)}
                                      className="h-3.5 w-3.5 accent-orange-500"
                                      disabled={permissionSaving === `${role}:${resource}:${action}`}
                                      onChange={(event) =>
                                        void updatePermission(role, resource, action, event.target.checked)
                                      }
                                      type="checkbox"
                                    />
                                    <span className="uppercase font-medium">{action}</span>
                                  </label>
                                ))}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className={`${panelClassName} overflow-hidden p-0`}>
            <button
              className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-stone-50"
              onClick={() => setShowAudit((current) => !current)}
              type="button"
            >
              <AdminSectionHeader
                action={null}
                description="Recent access-control changes."
                title="Audit log"
              />
              {showAudit ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
            </button>
            {showAudit && (
              <div className="space-y-2 border-t border-slate-200/80 p-5">
                {(data?.auditLogs ?? []).map((log) => (
                  <div
                    className="rounded-lg border border-slate-200 bg-stone-50 p-4 transition-colors hover:bg-stone-100 hover:shadow-sm"
                    key={log.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-900">{log.summary}</p>
                      <span className="text-xs text-slate-500">{formatDate(log.createdAt)}</span>
                    </div>
                    <p className="mt-1.5 text-xs text-slate-500">
                      Actor: {log.actorLoginId ?? "system"} / Entity: {log.entityId ?? "-"}
                    </p>
                  </div>
                ))}
                {(data?.auditLogs ?? []).length === 0 && (
                  <p className="py-8 text-center text-sm text-slate-400">No audit logs found.</p>
                )}
              </div>
            )}
          </Card>
        </>
      ) : (
        <Card className={`${panelClassName} overflow-hidden bg-white p-0`}>
          <div className="grid gap-6 px-6 py-8 lg:grid-cols-[auto_minmax(0,1fr)] lg:px-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-rose-200 bg-rose-50 text-rose-600">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Access restricted</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
                This account can open the route but does not currently have permission to read the access-control
                dashboard. Request the <span className="font-medium text-slate-900">admin_access:read</span>{" "}
                capability or sign in with an authorized role.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Why this is hidden</p>
                  <p className="mt-2 text-sm leading-5 text-slate-500">
                    User management, permission overrides, and audit history are only loaded after a successful
                    authorization check.
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-slate-400">What to do next</p>
                  <p className="mt-2 text-sm leading-5 text-slate-500">
                    Have an administrator grant access, then refresh this page to load the live dashboard and controls.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}
      </div>
    </div>
  );
}
