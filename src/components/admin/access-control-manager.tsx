"use client";

import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  LockKeyhole,
  Download,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  UserCog,
  UserPlus,
  XCircle,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { AccessUserRow, AuditLogRow, PhoenixLine } from "@/lib/admin/access-control";
import {
  getPayrollScope,
  getSalesScope,
  permissionActions,
  permissionResources,
  type PermissionAction,
  type PermissionMap,
  phoenixRoles,
  type BusinessScope,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

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
  password: string;
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
  password: "",
  role: "Employee",
  salesScopeOverride: "",
};

const pageSize = 8;
const scopes: BusinessScope[] = ["SELF", "TEAM", "HIERARCHY", "LINE", "COMPANY", "NONE"];

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

export function AccessControlManager({ initialData = null, initialError = null }: Props) {
  const [data, setData] = React.useState<DashboardData | null>(initialData);
  const [error, setError] = React.useState<string | null>(initialError);
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState("all");
  const [lineFilter, setLineFilter] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [tab, setTab] = React.useState<"users" | "permissions" | "audit">("users");
  const [uploadResults, setUploadResults] = React.useState<RowResult[] | null>(null);
  const [permissionSaving, setPermissionSaving] = React.useState<string | null>(null);

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
    const loginId = form.loginId.trim() || form.hrId.trim();
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
          (payload.errors?.join(" ") || payload.message || "See details below.")
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

  function editUser(user: AccessUserRow) {
    setForm({
      email: user.email ?? "",
      hrId: user.hrId ?? "",
      isActive: user.isActive,
      line: user.line,
      loginId: user.loginId,
      managerHrId: user.managerHrId ?? "",
      name: user.name,
      password: "",
      role: user.role,
      salesScopeOverride: user.salesScopeOverride ?? "",
    });
  }

  const users = data?.users ?? [];
  const filteredUsers = users.filter((user) => {
    const haystack = [user.name, user.hrId, user.role, user.line, user.loginId, user.email].join(" ").toLowerCase();
    if (query && !haystack.includes(query.toLowerCase())) return false;
    if (roleFilter !== "all" && user.role !== roleFilter) return false;
    if (lineFilter !== "all" && user.line !== lineFilter) return false;
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const visibleUsers = filteredUsers.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#F97316]">Admin / Access Control</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-[#0F172A]">Users, Roles & Scope Engine</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#64748B]">
            Centralized RBAC for employee-linked accounts, sales visibility, payroll confidentiality, overrides, and audit history.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className="inline-flex items-center gap-2 rounded-lg border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-semibold text-[#0F172A] transition hover:bg-[#F8FAFC]"
            download
            href="/api/admin/users/bulk"
            rel="noopener noreferrer"
            target="_blank"
          >
            <Download className="h-4 w-4 text-[#F97316]" />
            Download template
          </a>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-semibold text-[#0F172A] transition hover:bg-[#F8FAFC]">
            <Upload className="h-4 w-4 text-[#F97316]" />
            Bulk upload
            <input accept=".xlsx,.xls" className="sr-only" onChange={uploadBulkUsers} type="file" />
          </label>
          <Button className="gap-2" disabled={isLoading} onClick={loadUsers} variant="secondary">
            {isLoading ? <LoadingSpinner /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-[#EF4444] bg-[#FEF2F2] p-4 text-sm text-[#DC2626]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {uploadResults && (
        <Card className="rounded-2xl border border-[#E2E8F0] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
          <div className="flex items-start justify-between gap-3 border-b border-[#E2E8F0] p-4">
            <div>
              <h3 className="font-bold text-[#0F172A]">Upload Validation Results</h3>
              <p className="text-sm text-[#64748B]">
                {uploadResults.filter((r) => r.action === "created").length} created, {" "}
                {uploadResults.filter((r) => r.action === "updated").length} updated, {" "}
                {uploadResults.filter((r) => r.action === "skipped").length} skipped, {" "}
                {uploadResults.filter((r) => r.action === "error").length} failed
              </p>
            </div>
            <Button className="h-8 px-3 text-xs" onClick={() => setUploadResults(null)} variant="secondary">
              Dismiss
            </Button>
          </div>
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
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        {[
          ["Active users", users.filter((user) => user.isActive).length],
          ["Company payroll", users.filter((user) => user.payrollScope === "COMPANY").length],
          ["Sales overrides", users.filter((user) => user.salesScopeOverride).length],
          ["Audit entries", data?.auditLogs.length ?? 0],
        ].map(([label, value]) => (
          <Card className="rounded-2xl border border-[#E2E8F0] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(15,23,42,0.08)]" key={label}>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#64748B]">{label}</p>
            <p className="mt-3 text-3xl font-black text-[#0F172A]">{value}</p>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 rounded-xl border border-[#E2E8F0] bg-white p-1 shadow-sm">
        {(["users", "permissions", "audit"] as const).map((item) => (
          <button
            className={cn("rounded-lg px-4 py-2 text-sm font-bold transition", tab === item ? "bg-[#F97316] text-white" : "text-[#64748B] hover:bg-[#F8FAFC]")}
            key={item}
            onClick={() => setTab(item)}
            type="button"
          >
            {item === "users" ? "Users" : item === "permissions" ? "Permissions" : "Audit Logs"}
          </button>
        ))}
      </div>

      {tab === "users" && (
        <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
          <Card className="rounded-2xl border border-[#E2E8F0] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-[#0F172A]">User actions</h2>
                <p className="mt-1 text-sm text-[#64748B]">Create, assign role, link HR_ID, set line, manager, and reset password.</p>
              </div>
              <UserPlus className="h-5 w-5 text-[#F97316]" />
            </div>
            <form className="mt-5 grid gap-3" onSubmit={saveUser}>
              <Input onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Name" value={form.name} />
              <Input onChange={(e) => setForm((p) => ({ ...p, loginId: e.target.value }))} placeholder="Login HR_ID (auto-filled if empty)" value={form.loginId} />
              <Input onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} placeholder="Email" type="email" value={form.email} />
              <Input
                onChange={(e) => {
                  const hrId = e.target.value;
                  setForm((p) => ({
                    ...p,
                    hrId,
                    loginId: p.loginId ? p.loginId : hrId,
                  }));
                }}
                placeholder="HR_ID"
                value={form.hrId}
              />
              <select className="h-10 rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm" onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as PhoenixRole }))} value={form.role}>
                {phoenixRoles.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-3">
                <select className="h-10 rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm" onChange={(e) => setForm((p) => ({ ...p, line: e.target.value as PhoenixLine }))} value={form.line}>
                  {(data?.lines ?? ["CNS", "Pedia", "Anti-Infective", "Office", "Other"]).map((line) => <option key={line} value={line}>{line}</option>)}
                </select>
                <Input onChange={(e) => setForm((p) => ({ ...p, managerHrId: e.target.value }))} placeholder="Manager_HR_ID" value={form.managerHrId} />
              </div>
              <Input onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} placeholder="Password / reset password" type="password" value={form.password} />
              <select className="h-10 rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm" onChange={(e) => setForm((p) => ({ ...p, salesScopeOverride: e.target.value as BusinessScope | "" }))} value={form.salesScopeOverride}>
                <option value="">Automatic sales scope</option>
                {scopes.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
              </select>
              <div className="rounded-lg border border-[#F97316]/20 bg-[#F97316]/5 p-3 text-xs font-semibold text-[#F97316]">
                <LockKeyhole className="mr-2 inline h-3.5 w-3.5" />
                Payroll: {getPayrollScope({ role: form.role })}. Only CEO, HR Specialist, Finance Manager, and Super Admin receive COMPANY.
              </div>
              <label className="flex items-center justify-between rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm font-bold">
                Active account
                <input checked={form.isActive} className="h-4 w-4 accent-[#F97316]" onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))} type="checkbox" />
              </label>
              <Button className="w-full gap-2" disabled={isSaving} type="submit">
                {isSaving ? <LoadingSpinner /> : <KeyRound className="h-4 w-4" />}
                Save user
              </Button>
            </form>
          </Card>

          <Card className="overflow-hidden rounded-2xl border border-[#E2E8F0] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)] p-0">
            <div className="grid gap-3 border-b border-[#E2E8F0] p-4 lg:grid-cols-[1fr_190px_160px]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#64748B]" />
                <Input className="pl-9 border-[#E2E8F0]" onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="Search name, HR_ID, role, line" value={query} />
              </div>
              <select className="h-10 rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm" onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }} value={roleFilter}>
                <option value="all">All roles</option>
                {phoenixRoles.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <select className="h-10 rounded-lg border border-[#E2E8F0] bg-white px-3 text-sm" onChange={(e) => { setLineFilter(e.target.value); setPage(1); }} value={lineFilter}>
                <option value="all">All lines</option>
                {(data?.lines ?? []).map((line) => <option key={line} value={line}>{line}</option>)}
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                  <tr>
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">Role / Line</th>
                    <th className="px-4 py-3">Sales</th>
                    <th className="px-4 py-3">Payroll</th>
                    <th className="px-4 py-3">Manager</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((user) => (
                    <tr className="border-b border-[#E2E8F0] transition hover:bg-[#F8FAFC]" key={user.loginId}>
                      <td className="px-4 py-3">
                        <p className="font-bold text-[#0F172A]">{user.name}</p>
                        <p className="text-xs text-[#64748B]">{user.hrId ?? "-"} / {user.loginId}</p>
                      </td>
                      <td className="px-4 py-3"><Badge variant={roleBadge(user.role)}>{user.role}</Badge><p className="mt-1 text-xs text-[#64748B]">{user.line}</p></td>
                      <td className="px-4 py-3"><Badge variant={scopeBadge(user.salesScope)}>{user.salesScope}</Badge>{user.salesScopeOverride && <p className="mt-1 text-[10px] font-bold text-[#F97316]">override</p>}</td>
                      <td className="px-4 py-3"><Badge variant={scopeBadge(user.payrollScope)}>{user.payrollScope}</Badge></td>
                      <td className="px-4 py-3 text-[#64748B]">{user.managerHrId ?? "-"}</td>
                      <td className="px-4 py-3"><Badge variant={user.isActive ? "success" : "danger"}>{user.isActive ? "active" : "inactive"}</Badge></td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <Button className="h-8 px-3 text-xs" onClick={() => editUser(user)} variant="secondary"><UserCog className="mr-1 h-3.5 w-3.5" />Edit</Button>
                          <Button className="h-8 px-3 text-xs" onClick={() => toggleUser(user)} variant={user.isActive ? "destructive" : "primary"}>
                            {user.isActive ? <XCircle className="mr-1 h-3.5 w-3.5" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
                            {user.isActive ? "Disable" : "Enable"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-[#E2E8F0] px-4 py-3 text-sm text-[#64748B]">
              <span>{filteredUsers.length} users</span>
              <div className="flex items-center gap-2">
                <Button className="h-8 px-2" disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))} variant="secondary"><ChevronLeft className="h-4 w-4" /></Button>
                <span className="font-bold">{page} / {pageCount}</span>
                <Button className="h-8 px-2" disabled={page === pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} variant="secondary"><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {tab === "permissions" && (
        <Card className="overflow-hidden rounded-2xl border border-[#E2E8F0] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)] p-0">
          <div className="border-b border-[#E2E8F0] p-5">
            <ShieldCheck className="mr-2 inline h-5 w-5 text-[#F97316]" />
            <span className="font-bold text-[#0F172A]">Effective role matrix and default scopes</span>
            <p className="mt-1 text-xs text-[#64748B]">
              Toggle any permission cell to override role access in real-time.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
                <tr>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Sales</th>
                  <th className="px-4 py-3">Payroll</th>
                  {permissionResources.map((resource) => (
                    <th className="px-4 py-3" key={resource}>{resource}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {phoenixRoles.map((role) => (
                  <tr className="border-b border-[#E2E8F0]" key={role}>
                    <td className="px-4 py-3"><Badge variant={roleBadge(role)}>{role}</Badge></td>
                    <td className="px-4 py-3"><Badge variant={scopeBadge(getSalesScope({ role }))}>{getSalesScope({ role })}</Badge></td>
                    <td className="px-4 py-3"><Badge variant={scopeBadge(getPayrollScope({ role }))}>{getPayrollScope({ role })}</Badge></td>
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
                                    void updatePermission(
                                      role,
                                      resource,
                                      action,
                                      event.target.checked,
                                    )
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
        </Card>
      )}

      {tab === "audit" && (
        <Card className="rounded-2xl border border-[#E2E8F0] bg-white shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
          <div className="space-y-3">
            {(data?.auditLogs ?? []).map((log) => (
              <div className="rounded-lg border border-[#E2E8F0] p-4 transition hover:border-[#F97316]/30 hover:bg-[#F8FAFC]" key={log.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-bold text-[#0F172A]">{log.summary}</p>
                  <span className="text-xs font-semibold text-[#64748B]">{formatDate(log.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-[#64748B]">Actor: {log.actorLoginId ?? "system"} / Entity: {log.entityId ?? "-"}</p>
              </div>
            ))}
            {(data?.auditLogs ?? []).length === 0 && <p className="py-8 text-center text-sm text-[#64748B]">No audit logs found.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
