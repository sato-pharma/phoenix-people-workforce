"use client";

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  UserCog,
  Users,
  XCircle,
} from "lucide-react";
import * as React from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminStatCard,
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
  "rounded-3xl border border-[#D8E0EA] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]";
const selectClassName =
  "h-11 w-full rounded-2xl border border-[#D7E0EA] bg-[#F8FAFC] px-4 text-sm font-semibold text-[#0F172A] transition outline-none focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10";

function roleBadge(role: PhoenixRole) {
  if (role === "Super Admin" || role === "CEO") return "danger" as const;
  if (role === "HR Specialist" || role === "Finance Manager") return "success" as const;
  if (role === "District Manager" || role === "Regional Manager" || role === "Manager") return "warning" as const;
  return "neutral" as const;
}

function scopeBadge(scope: BusinessScope) {
  if (scope === "COMPANY") return "danger" as const;
  if (scope === "NONE") return "neutral" as const;
  if (scope === "SELF") return "success" as const;
  return "warning" as const;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
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
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
      <Card className="relative overflow-hidden rounded-3xl border border-[#D8E0EA] bg-white/95 p-0 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-12 h-28 w-28 rounded-full bg-slate-200/45 blur-2xl" />
        <div className="relative flex flex-col gap-5 p-7 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
              <span className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">Identity command</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0B0B0B] text-orange-400 shadow-[0_14px_30px_rgba(15,23,42,0.22)]">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-3xl font-black tracking-tight text-slate-950">Users & Access</h1>
                <p className="mt-1 max-w-3xl text-sm text-slate-500">
                  Manage identities, role scopes, permission overrides, and onboarding links in one control surface.
                </p>
              </div>
            </div>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:min-w-[520px] sm:grid-cols-3">
              <a
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[#D7E0EA] bg-white px-3 text-xs font-black text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
                download
                href="/api/admin/users/bulk"
                rel="noopener noreferrer"
                target="_blank"
              >
                <Download className="h-3.5 w-3.5 text-[#F97316]" />
                Download template
              </a>
              <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-[#D7E0EA] bg-white px-3 text-xs font-black text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]">
                <Upload className="h-3.5 w-3.5 text-[#F97316]" />
                Bulk upload
                <input accept=".xlsx,.xls" className="sr-only" onChange={uploadBulkUsers} type="file" />
              </label>
              <Button
                className="h-10 rounded-xl px-3 text-xs"
                disabled={isLoading}
                onClick={loadUsers}
                variant="secondary"
              >
                {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh
              </Button>
            </div>
        </div>
        <div className="relative flex flex-wrap gap-2 border-t border-[#E2E8F0] px-7 pb-5 pt-4 text-xs text-[#475569]">
          <AdminInsightChip>Roles inherit default sales and payroll scopes.</AdminInsightChip>
          <AdminInsightChip tone="orange">Setup and reset links are generated on demand.</AdminInsightChip>
          <AdminInsightChip tone="slate">Use refresh to pull fresh data after role changes.</AdminInsightChip>
        </div>
      </Card>

      {error && (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
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
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {statCards.map((card) => {
              const Icon = card.icon;
              return (
                <AdminStatCard
                  description={card.description}
                  icon={<Icon className="h-5 w-5" />}
                  key={card.label}
                  label={card.label}
                  value={card.value}
                />
              );
            })}
          </div>

          <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
            <Card className={`${panelClassName} h-fit p-0 xl:sticky xl:top-6`}>
              <AdminSectionHeader
                action={<div className="text-xs font-semibold text-[#0F172A]">Active</div>}
                description="Create or update a user profile, then issue setup and reset links from the user table."
                title="User editor"
              />

              <form className="grid gap-4 px-5 py-5" onSubmit={saveUser}>
                <Input
                  className="h-11 rounded-2xl border-[#D7E0EA] bg-[#F8FAFC] px-4 font-semibold"
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Full name"
                  value={form.name}
                />
                <Input
                  className="h-11 rounded-2xl border-[#D7E0EA] bg-[#F8FAFC] px-4 font-semibold"
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
                  className="h-11 rounded-2xl border-[#D7E0EA] bg-[#F8FAFC] px-4 font-semibold"
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                  placeholder="Email"
                  type="email"
                  value={form.email}
                />
                <select
                  className={selectClassName}
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
                    className={selectClassName}
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
                    className="h-11 rounded-2xl border-[#D7E0EA] bg-[#F8FAFC] px-4 font-semibold"
                    onChange={(e) => setForm((p) => ({ ...p, managerHrId: e.target.value }))}
                    placeholder="Manager HR_ID"
                    value={form.managerHrId}
                  />
                </div>
                <select
                  className={selectClassName}
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
                <div className="rounded-2xl border border-[#FED7AA] bg-[#FFF7ED] p-4 text-sm text-[#C2410C]">
                  <div className="flex items-center gap-2 font-semibold">
                    <LockKeyhole className="h-4 w-4" />
                    Scope preview
                  </div>
                  <p className="mt-2 leading-6">
                    Payroll scope:{" "}
                    <span className="font-bold">{getPayrollScope({ role: form.role })}</span>. Sales scope:{" "}
                    <span className="font-bold">
                      {getSalesScope({
                        role: form.role,
                        salesScopeOverride: form.salesScopeOverride || null,
                      })}
                    </span>
                    .
                  </p>
                </div>
                <div className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 text-sm leading-6 text-[#475569]">
                  New users start in password-setup mode. After saving, use the setup link action from the list to
                  complete onboarding.
                </div>
                <label className="flex items-center justify-between rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] px-4 py-3 text-sm font-bold text-[#0F172A]">
                  Active account
                  <input
                    checked={form.isActive}
                    className="h-4 w-4 accent-[#F97316]"
                    onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))}
                    type="checkbox"
                  />
                </label>
                <Button className="h-11 w-full gap-2 rounded-xl text-sm font-semibold" disabled={isSaving} type="submit">
                  {isSaving ? <LoadingSpinner /> : <KeyRound className="h-4 w-4" />}
                  Save user
                </Button>
              </form>
            </Card>

            <Card className={`${panelClassName} overflow-hidden p-0`}>
              <AdminSectionHeader
                action={<Badge variant="neutral">{filteredUsers.length} visible</Badge>}
                description="Search, filter, edit, enable, and disable accounts without leaving the page."
                title="Users list"
              />

              <div className="grid gap-3 border-b border-[#E2E8F0] p-4 lg:grid-cols-[minmax(0,1fr)_220px_170px]">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-4 top-3.5 h-4 w-4 text-[#64748B]" />
                  <Input
                    className="h-11 rounded-2xl border-[#D7E0EA] bg-[#F8FAFC] pl-11 font-semibold"
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(1);
                    }}
                    placeholder="Search name, HR_ID, role, line"
                    value={query}
                  />
                </div>
                <select
                  className={selectClassName}
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
                  className={selectClassName}
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

              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                    <tr>
                      <th className="px-5 py-4">User</th>
                      <th className="px-5 py-4">Role / Line</th>
                      <th className="px-5 py-4">Access</th>
                      <th className="px-5 py-4">Password</th>
                      <th className="px-5 py-4">Status</th>
                      <th className="px-5 py-4">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hasUsers ? (
                      visibleUsers.map((user) => (
                        <tr className="border-b border-[#E2E8F0] align-top transition hover:bg-orange-50/35" key={user.loginId}>
                          <td className="px-5 py-4">
                            <p className="text-sm font-black text-[#0F172A]">{user.name}</p>
                            <p className="mt-1 text-xs text-[#64748B]">
                              {user.hrId ?? "-"} / {user.loginId}
                            </p>
                            <p className="mt-1 text-xs text-[#64748B]">{user.email ?? "-"}</p>
                          </td>
                          <td className="px-5 py-4">
                            <Badge variant={roleBadge(user.role)}>{user.role}</Badge>
                            <p className="mt-2 text-xs font-medium text-[#64748B]">{user.line}</p>
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex flex-col gap-2">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#64748B]">Sales</span>
                                <Badge variant={scopeBadge(user.salesScope)}>{user.salesScope}</Badge>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#64748B]">Payroll</span>
                                <Badge variant={scopeBadge(user.payrollScope)}>{user.payrollScope}</Badge>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-4">
                            <Badge variant={user.forcePasswordReset ? "warning" : "success"}>
                              {user.forcePasswordReset ? "setup required" : "ready"}
                            </Badge>
                          </td>
                          <td className="px-5 py-4">
                            <Badge variant={user.isActive ? "success" : "danger"}>
                              {user.isActive ? "active" : "inactive"}
                            </Badge>
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex flex-wrap gap-2">
                              <Button className="h-9 rounded-xl px-3 text-xs" onClick={() => editUser(user)} variant="secondary">
                                <UserCog className="mr-1 h-3.5 w-3.5" />
                                Edit
                              </Button>
                              <Button
                                className="h-9 rounded-xl px-3 text-xs"
                                disabled={setupLinkSending !== null || !user.isActive}
                                onClick={() => sendSetupLink(user, "email")}
                                variant="secondary"
                              >
                                {setupLinkSending === `${user.loginId}:email` ? (
                                  <LoadingSpinner />
                                ) : (
                                  <KeyRound className="mr-1 h-3.5 w-3.5" />
                                )}
                                {user.forcePasswordReset ? "Email setup link" : "Email reset link"}
                              </Button>
                              <Button
                                className="h-9 rounded-xl px-3 text-xs"
                                disabled={setupLinkSending !== null || !user.isActive}
                                onClick={() => sendSetupLink(user, "copy")}
                                variant="secondary"
                              >
                                {setupLinkSending === `${user.loginId}:copy` ? (
                                  <LoadingSpinner />
                                ) : (
                                  <KeyRound className="mr-1 h-3.5 w-3.5" />
                                )}
                                {user.forcePasswordReset ? "Copy setup link" : "Copy reset link"}
                              </Button>
                              <Button
                                className="h-9 rounded-xl px-3 text-xs"
                                onClick={() => toggleUser(user)}
                                variant={user.isActive ? "destructive" : "primary"}
                              >
                                {user.isActive ? (
                                  <XCircle className="mr-1 h-3.5 w-3.5" />
                                ) : (
                                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                                )}
                                {user.isActive ? "Disable" : "Enable"}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td className="px-6 py-14" colSpan={6}>
                          <div className="mx-auto flex max-w-md flex-col items-center text-center">
                            <div className="rounded-3xl border border-[#FED7AA] bg-[#FFF7ED] p-4 text-[#F97316]">
                              <Users className="h-6 w-6" />
                            </div>
                            <p className="mt-4 text-lg font-bold text-[#0F172A]">
                              {query || roleFilter !== "all" || lineFilter !== "all"
                                ? "No matching users"
                                : "No users added yet"}
                            </p>
                            <p className="mt-2 text-sm leading-6 text-[#64748B]">
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

              <div className="flex items-center justify-between border-t border-[#E2E8F0] bg-[#F8FAFC]/80 px-5 py-3 text-sm text-[#64748B]">
                <span className="font-semibold">{filteredUsers.length} users</span>
                <div className="flex items-center gap-2">
                  <Button
                    className="h-8 rounded-xl px-2"
                    disabled={page === 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    variant="secondary"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="font-bold">
                    {page} / {pageCount}
                  </span>
                  <Button
                    className="h-8 rounded-xl px-2"
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
              className="flex w-full items-center justify-between border-b border-[#E2E8F0] px-5 py-4 text-left"
              onClick={() => setShowPermissions((current) => !current)}
              type="button"
            >
              <AdminSectionHeader
                action={null}
                description="Role-level permission matrix and overrides."
                title="Advanced permissions"
              />
              {showPermissions ? (
                <ChevronUp className="h-4 w-4 text-[#64748B]" />
              ) : (
                <ChevronDown className="h-4 w-4 text-[#64748B]" />
              )}
            </button>
            {showPermissions && (
              <div className="border-t border-[#E2E8F0] overflow-x-auto">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
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
                      <tr className="border-b border-[#E2E8F0]" key={role}>
                        <td className="px-4 py-3">
                          <Badge variant={roleBadge(role)}>{role}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={scopeBadge(getSalesScope({ role }))}>{getSalesScope({ role })}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={scopeBadge(getPayrollScope({ role }))}>{getPayrollScope({ role })}</Badge>
                        </td>
                        {permissionResources.map((resource) => {
                          const allowedActions = data?.permissions?.[role]?.[resource] ?? [];
                          return (
                            <td className="border-l border-[#E2E8F0] px-4 py-3" key={`${role}-${resource}`}>
                              <div className="flex flex-wrap gap-2">
                                {permissionActions.map((action) => (
                                  <label className="flex items-center gap-1 text-[10px]" key={`${role}-${resource}-${action}`}>
                                    <input
                                      checked={allowedActions.includes(action)}
                                      className="h-3.5 w-3.5 accent-[#F97316]"
                                      disabled={permissionSaving === `${role}:${resource}:${action}`}
                                      onChange={(event) =>
                                        void updatePermission(role, resource, action, event.target.checked)
                                      }
                                      type="checkbox"
                                    />
                                    <span className="uppercase">{action}</span>
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
              className="flex w-full items-center justify-between px-5 py-4 text-left"
              onClick={() => setShowAudit((current) => !current)}
              type="button"
            >
              <AdminSectionHeader
                action={null}
                description="Recent access-control changes."
                title="Audit log"
              />
              {showAudit ? <ChevronUp className="h-4 w-4 text-[#64748B]" /> : <ChevronDown className="h-4 w-4 text-[#64748B]" />}
            </button>
            {showAudit && (
              <div className="space-y-3 border-t border-[#E2E8F0] p-5">
                {(data?.auditLogs ?? []).map((log) => (
                  <div
                    className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] p-4 transition hover:border-[#FDBA74] hover:bg-white"
                    key={log.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-bold text-[#0F172A]">{log.summary}</p>
                      <span className="text-xs font-semibold text-[#64748B]">{formatDate(log.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-xs text-[#64748B]">
                      Actor: {log.actorLoginId ?? "system"} / Entity: {log.entityId ?? "-"}
                    </p>
                  </div>
                ))}
                {(data?.auditLogs ?? []).length === 0 && (
                  <p className="py-8 text-center text-sm text-[#64748B]">No audit logs found.</p>
                )}
              </div>
            )}
          </Card>
        </>
      ) : (
        <Card className={`${panelClassName} overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-0`}>
          <div className="grid gap-6 px-6 py-8 lg:grid-cols-[auto_minmax(0,1fr)] lg:px-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-3xl border border-[#FECACA] bg-[#FEF2F2] text-[#DC2626]">
              <ShieldAlert className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-2xl font-black tracking-[-0.03em] text-[#0F172A]">Access restricted</h2>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-[#475569]">
                This account can open the route but does not currently have permission to read the access-control
                dashboard. Request the <span className="font-semibold text-[#0F172A]">admin_access:read</span>{" "}
                capability or sign in with an authorized role.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-[#64748B]">Why this is hidden</p>
                  <p className="mt-2 text-sm leading-6 text-[#475569]">
                    User management, permission overrides, and audit history are only loaded after a successful
                    authorization check.
                  </p>
                </div>
                <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-[#64748B]">What to do next</p>
                  <p className="mt-2 text-sm leading-6 text-[#475569]">
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
