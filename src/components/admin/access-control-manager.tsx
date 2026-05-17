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
  permissionOverrides?: PermissionOverrideMarker[];
  roles: typeof phoenixRoles;
  users: AccessUserRow[];
};

type PermissionOverrideMarker = {
  action: PermissionAction;
  isAllowed: boolean;
  resource: PermissionResource;
  role: PhoenixRole;
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
  capabilities?: {
    canBulkImportUsers: boolean;
    canManagePermissions: boolean;
    canManageUsers: boolean;
    canReadUsers: boolean;
  };
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

const roleFamilies: Record<PhoenixRole, "executive" | "finance" | "hr" | "manager" | "employee"> = {
  CEO: "executive",
  "District Manager": "manager",
  Employee: "employee",
  "Finance Manager": "finance",
  "Group Product Manager": "manager",
  "HR Specialist": "hr",
  Manager: "manager",
  "Marketing Manager": "manager",
  "Medical Rep": "employee",
  "National Sales Manager": "manager",
  "Product Manager": "manager",
  "Regional Manager": "manager",
  "SFE Manager": "manager",
  "Super Admin": "executive",
  "Training Manager": "manager",
};

const permissionDomains: Array<{
  description: string;
  label: string;
  resources: PermissionResource[];
}> = [
  {
    description: "Employee records, lifecycle workflows, hierarchy, documents, and team visibility.",
    label: "People",
    resources: ["employees", "employee_profile", "employee_documents", "team", "organogram", "vacancies", "offers", "probation", "resignations", "contracts"],
  },
  {
    description: "Payroll dashboards, salary artifacts, and payslip access.",
    label: "Payroll",
    resources: ["payroll", "payslips"],
  },
  {
    description: "Sales performance, coaching, and line-based commercial visibility.",
    label: "Sales",
    resources: ["sales", "coaching"],
  },
  {
    description: "Expense requests, approvals, exports, and outstation workflows.",
    label: "Expenses / Outstation",
    resources: ["expenses", "outstation"],
  },
  {
    description: "User administration, imports, permission overrides, and admin route access.",
    label: "Admin / Governance",
    resources: ["admin", "overview", "admin_access", "imports", "user_admin", "permission_admin"],
  },
  {
    description: "Calendar and cross-system operating surfaces.",
    label: "System",
    resources: ["hr_calendar"],
  },
];

const permissionResourceDescriptions: Partial<Record<PermissionResource, string>> = {
  admin: "Administrative shell and system controls.",
  admin_access: "Users & Access dashboard visibility.",
  coaching: "Coaching reports and performance feedback.",
  contracts: "Contract renewal and employment terms.",
  employee_documents: "Employee files and document exports.",
  employee_profile: "Personal employment profile fields.",
  employees: "Employee directory and employee record management.",
  expenses: "Expense request and approval workflows.",
  hr_calendar: "HR calendar and workforce events.",
  imports: "Bulk import workflows and validation.",
  offers: "Offer generation and candidate decision flows.",
  organogram: "Hierarchy and organization chart visibility.",
  outstation: "Outstation requests and approvals.",
  payroll: "Payroll dashboard and salary operations.",
  payslips: "Payslip visibility and export.",
  permission_admin: "Role permission override governance.",
  probation: "Probation tracking and outcomes.",
  resignations: "Resignation lifecycle workflows.",
  sales: "Sales dashboards and exports.",
  team: "Team views and subordinate data.",
  user_admin: "User identity and role administration.",
  vacancies: "Vacancy and headcount planning.",
};

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

function badgeClassName(tone: "amber" | "emerald" | "orange" | "rose" | "sky" | "slate" | "violet") {
  const classes = {
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    orange: "border-orange-200 bg-orange-50 text-orange-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    sky: "border-sky-200 bg-sky-50 text-sky-700",
    slate: "border-slate-200 bg-slate-50 text-slate-600",
    violet: "border-violet-200 bg-violet-50 text-violet-700",
  };
  return `inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${classes[tone]}`;
}

function roleBadgeTone(role: PhoenixRole) {
  const family = roleFamilies[role];
  if (family === "executive") return "rose";
  if (family === "hr") return "orange";
  if (family === "finance") return "sky";
  if (family === "manager") return "violet";
  return "slate";
}

function RoleBadge({ role }: { role: PhoenixRole }) {
  const family = roleFamilies[role];
  const label = family === "executive" && role === "Super Admin"
    ? "Super Admin"
    : family === "hr"
      ? "HR"
      : family === "finance"
        ? "Finance"
        : family === "manager"
          ? "Manager"
          : "Employee";

  return (
    <span className={badgeClassName(roleBadgeTone(role))}>
      {role}
      <span className="ml-1 text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</span>
    </span>
  );
}

function ScopeBadge({ label, scope }: { label: string; scope: BusinessScope }) {
  const classes = getScopeSemanticClasses(scope);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500">
      {label}
      <span className={`rounded-full border ${classes.border} ${classes.bg} px-1.5 py-0.5 text-[10px] ${classes.text}`}>
        {scope}
      </span>
    </span>
  );
}

function StatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span className={badgeClassName(isActive ? "emerald" : "slate")}>
      {isActive ? "Active" : "Inactive"}
    </span>
  );
}

function PasswordBadge({ forcePasswordReset }: { forcePasswordReset: boolean }) {
  return (
    <span className={badgeClassName(forcePasswordReset ? "amber" : "emerald")}>
      {forcePasswordReset ? "Setup pending" : "Password ready"}
    </span>
  );
}

function auditReason(log: AuditLogRow) {
  const reason = log.newValues?.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

function auditActionLabel(log: AuditLogRow) {
  const action = log.newValues?.action;
  if (action === "password_setup_link_generated") return "Token-safe setup/reset event";
  if (log.entityType === "permission_override") return "Permission override";
  if (/deactivated/i.test(log.summary)) return "Access revoked";
  if (/activated/i.test(log.summary)) return "Access restored";
  if (/role/i.test(log.summary)) return "Role governance";
  return "User governance";
}

export function AccessControlManager({
  capabilities = {
    canBulkImportUsers: false,
    canManagePermissions: false,
    canManageUsers: false,
    canReadUsers: false,
  },
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
  const [pendingGovernanceAction, setPendingGovernanceAction] = React.useState<{
    body: string;
    confirmLabel: string;
    onConfirm: (reason: string) => Promise<void>;
    reasonPlaceholder: string;
    title: string;
  } | null>(null);
  const [governanceReason, setGovernanceReason] = React.useState("");
  const [isConfirmingGovernanceAction, setIsConfirmingGovernanceAction] = React.useState(false);

  const canManageUsers = capabilities.canManageUsers;
  const canManagePermissions = capabilities.canManagePermissions;

  function requestGovernanceConfirmation(input: {
    body: string;
    confirmLabel: string;
    onConfirm: (reason: string) => Promise<void>;
    reasonPlaceholder?: string;
    title: string;
  }) {
    setGovernanceReason("");
    setPendingGovernanceAction({
      ...input,
      reasonPlaceholder: input.reasonPlaceholder ?? "Optional governance reason",
    });
  }

  async function confirmGovernanceAction() {
    if (!pendingGovernanceAction) return;
    setIsConfirmingGovernanceAction(true);
    try {
      await pendingGovernanceAction.onConfirm(governanceReason.trim());
      setPendingGovernanceAction(null);
      setGovernanceReason("");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Governance action failed.");
    } finally {
      setIsConfirmingGovernanceAction(false);
    }
  }

  async function updatePermission(
    role: PhoenixRole,
    resource: PermissionResource,
    action: PermissionAction,
    isAllowed: boolean,
  ) {
    if (!canManagePermissions) {
      setError("Only Super Admin can update permission overrides.");
      return;
    }
    requestGovernanceConfirmation({
      body: `Change ${role} permission for ${resource}:${action} to ${isAllowed ? "allowed" : "restricted"}. This affects every user assigned to that role and will be written to the governance audit log.`,
      confirmLabel: "Update permission",
      onConfirm: async (reason) => {
        await performPermissionUpdate(role, resource, action, isAllowed, reason);
      },
      reasonPlaceholder: "Why is this permission override required?",
      title: "Confirm permission override",
    });
  }

  async function performPermissionUpdate(
    role: PhoenixRole,
    resource: PermissionResource,
    action: PermissionAction,
    isAllowed: boolean,
    governanceReason: string,
  ) {
    setError(null);
    const key = `${role}:${resource}:${action}`;
    setPermissionSaving(key);
    try {
      const response = await fetch("/api/admin/permissions", {
        body: JSON.stringify({
          action,
          governanceReason,
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
    if (!canManageUsers) {
      setError("You do not have permission to update users.");
      return;
    }
    const existing = data?.users.find((user) => user.loginId === (form.hrId.trim() || form.loginId.trim()));
    const roleChanged = Boolean(existing && existing.role !== form.role);
    const privilegedRole = form.role === "Super Admin" || form.role === "CEO" || form.role === "HR Specialist" || form.role === "Finance Manager";
    const deactivating = Boolean(existing?.isActive && !form.isActive);

    if (roleChanged || privilegedRole || deactivating) {
      requestGovernanceConfirmation({
        body: `Save ${form.hrId.trim() || form.loginId.trim() || "this user"} with role ${form.role}${deactivating ? " and deactivate access" : ""}. Role and status changes can alter payroll, employee, and admin visibility immediately.`,
        confirmLabel: "Save user",
        onConfirm: async (reason) => {
          await performSaveUser(reason);
        },
        reasonPlaceholder: "Reason for role/access governance change",
        title: "Confirm user access change",
      });
      return;
    }

    await performSaveUser("");
  }

  async function performSaveUser(governanceReason: string) {
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
          governanceReason,
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
    if (!capabilities.canBulkImportUsers) {
      setError("You do not have permission to bulk import users.");
      event.target.value = "";
      return;
    }
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
    if (!canManageUsers) {
      setError("You do not have permission to update users.");
      return;
    }
    requestGovernanceConfirmation({
      body: `${user.isActive ? "Deactivate" : "Reactivate"} ${user.name} (${user.loginId}). Deactivation revokes active Phoenix sessions, updates Supabase Auth access state, and blocks future sign-in.`,
      confirmLabel: user.isActive ? "Deactivate user" : "Reactivate user",
      onConfirm: async (reason) => {
        await performToggleUser(user, reason);
      },
      reasonPlaceholder: "Reason for changing account status",
      title: user.isActive ? "Confirm deactivation" : "Confirm reactivation",
    });
  }

  async function performToggleUser(user: AccessUserRow, governanceReason: string) {
    setError(null);
    const response = await fetch("/api/admin/users", {
      body: JSON.stringify({ governanceReason, isActive: !user.isActive, loginId: user.loginId }),
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
    if (!canManageUsers) {
      setError("You do not have permission to generate password links.");
      return;
    }
    requestGovernanceConfirmation({
      body: `${deliveryMode === "email" ? "Email" : "Generate and copy"} a one-time ${user.forcePasswordReset ? "setup" : "reset"} link for ${user.name} (${user.loginId}). The link is token-safe in audit records, but it can set account credentials before expiry.`,
      confirmLabel: deliveryMode === "email" ? "Send link" : "Generate link",
      onConfirm: async (reason) => {
        await performSendSetupLink(user, deliveryMode, reason);
      },
      reasonPlaceholder: "Reason for password setup/reset link",
      title: "Confirm password link",
    });
  }

  async function performSendSetupLink(user: AccessUserRow, deliveryMode: "copy" | "email", governanceReason: string) {
    setError(null);
    setSetupLinkMessage(null);
    setSetupLinkSending(`${user.loginId}:${deliveryMode}`);

    try {
      const response = await fetch("/api/admin/users/setup-link", {
        body: JSON.stringify({
          deliveryMode,
          governanceReason,
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
    if (!canManageUsers) {
      setError("You do not have permission to edit users.");
      return;
    }
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
  const pendingSetupUsers = users.filter((user) => user.forcePasswordReset).length;
  const inactiveUsers = users.length - activeUsers;
  const auditEntries = data?.auditLogs.length ?? 0;
  const hasDashboard = data !== null;
  const hasUsers = filteredUsers.length > 0;
  const lineOptions = data?.lines ?? ["CNS", "Pedia", "Anti-Infective", "Office", "Other"];
  const accessMode = canManageUsers
    ? canManagePermissions
      ? "Full admin"
      : "User admin"
    : capabilities.canReadUsers
      ? "Read only"
      : "Restricted";
  const permissionOverrideSet = new Set(
    (data?.permissionOverrides ?? []).map((override) =>
      `${override.role}:${override.resource}:${override.action}:${override.isAllowed ? "allow" : "deny"}`,
    ),
  );
  const permissionOverrideCount = data?.permissionOverrides?.length ?? 0;
  const visiblePermissionDomains = permissionDomains.map((domain) => ({
    ...domain,
    resources: domain.resources.filter((resource) => permissionResources.includes(resource)),
  })).filter((domain) => domain.resources.length > 0);

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

  function renderUserActions(user: AccessUserRow, layout: "compact" | "stacked" = "compact") {
    if (!canManageUsers) {
      return (
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500" title="Your role can view governance state but cannot mutate users.">
          Restricted
        </span>
      );
    }

    const buttonBase = layout === "stacked"
      ? "inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-all duration-160 ease-out active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      : "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition-all duration-160 ease-out active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";

    return (
      <div className={layout === "stacked" ? "grid grid-cols-2 gap-2" : "flex flex-wrap items-center justify-end gap-1.5"}>
        <button
          aria-label={`Edit ${user.name}`}
          className={`${buttonBase} border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100`}
          onClick={() => editUser(user)}
          type="button"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </button>
        <button
          aria-label={`${user.forcePasswordReset ? "Email setup link" : "Email reset link"} for ${user.name}`}
          className={`${buttonBase} border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100`}
          disabled={setupLinkSending !== null || !user.isActive}
          onClick={() => sendSetupLink(user, "email")}
          title={!user.isActive ? "Inactive users cannot receive password links." : "Governed email delivery"}
          type="button"
        >
          {setupLinkSending === `${user.loginId}:email` ? <LoadingSpinner className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />}
          Email link
        </button>
        <button
          aria-label={`${user.forcePasswordReset ? "Copy setup link" : "Copy reset link"} for ${user.name}`}
          className={`${buttonBase} border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100`}
          disabled={setupLinkSending !== null || !user.isActive}
          onClick={() => sendSetupLink(user, "copy")}
          title={!user.isActive ? "Inactive users cannot receive password links." : "Governed copy workflow"}
          type="button"
        >
          {setupLinkSending === `${user.loginId}:copy` ? <LoadingSpinner className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          Copy link
        </button>
        <button
          aria-label={`${user.isActive ? "Deactivate" : "Reactivate"} ${user.name}`}
          className={`${buttonBase} ${user.isActive ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100" : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}`}
          onClick={() => toggleUser(user)}
          type="button"
        >
          {user.isActive ? <Ban className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {user.isActive ? "Deactivate" : "Reactivate"}
        </button>
      </div>
    );
  }

  function renderEmptyUsers() {
    const filtered = query || roleFilter !== "all" || lineFilter !== "all";
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200/80 bg-gradient-to-br from-slate-50 to-white text-slate-400 shadow-sm">
          <Users className="h-6 w-6" />
        </div>
        <p className="mt-5 text-base font-semibold text-slate-900">{filtered ? "No matching users" : "No users added yet"}</p>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          {filtered
            ? "Clear a filter or search for HR_ID, name, role, email, or line."
            : canManageUsers
              ? "Create a governed user profile or import a validated workbook."
              : "No visible user records are available for your current access."}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[24px] border border-slate-200/80 bg-gradient-to-b from-stone-50 to-stone-100/50 p-6 shadow-[0_1px_3px_rgba(0,0,0,0.05)] sm:p-8">
      <div className="space-y-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex-1">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
            <ShieldCheck className="h-3.5 w-3.5 text-orange-600" />
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-orange-700">Identity Governance</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">Users & Access</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Control workforce identities, role scopes, password setup, and governed permission overrides.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Your mode", value: accessMode },
              { label: "Mutations", value: canManageUsers ? "Allowed with reason" : "Read-only" },
              { label: "Permission edits", value: canManagePermissions ? "Super Admin" : "Locked" },
              { label: "Sensitive actions", value: "Confirmed + audited" },
            ].map((item) => (
              <div className="rounded-lg border border-slate-200 bg-white/80 px-3 py-2 shadow-sm" key={item.label}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{item.label}</p>
                <p className="mt-1 text-sm font-semibold text-slate-800">{item.value}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:items-end">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="font-medium">Audit required</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-sky-700">
              <ShieldCheck className="h-3 w-3" />
              <span className="font-medium">RLS protected</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-violet-700">
              <LockKeyhole className="h-3 w-3" />
              <span className="font-medium">Session revocation</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            {capabilities.canReadUsers && (
              <a
                className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 shadow-sm transition-all duration-160 ease-out hover:border-slate-300 hover:bg-slate-50 hover:shadow-md hover:-translate-y-px"
                aria-label="Download the governed bulk user import template"
                download
                href="/api/admin/users/bulk"
                rel="noopener noreferrer"
                target="_blank"
              >
                <Download className="h-3.5 w-3.5 text-slate-500" />
                Download template
              </a>
            )}
            <label className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 shadow-sm transition-all duration-160 ease-out ${capabilities.canBulkImportUsers ? "cursor-pointer hover:border-slate-300 hover:bg-slate-50 hover:shadow-md hover:-translate-y-px" : "cursor-not-allowed opacity-60"}`} title={capabilities.canBulkImportUsers ? "Upload the validated Users & Access workbook." : "Bulk import requires user administration and import permission."}>
              <Upload className="h-3.5 w-3.5 text-slate-500" />
              {capabilities.canBulkImportUsers ? "Bulk upload" : "Import restricted"}
              <input accept=".xlsx,.xls" aria-label="Bulk upload user access workbook" className="sr-only" disabled={!capabilities.canBulkImportUsers} onChange={uploadBulkUsers} type="file" />
            </label>
            <Button
              aria-label="Refresh Users & Access data"
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
          <span>{error}</span>
        </AdminCallout>
      )}

      {setupLinkMessage && (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{setupLinkMessage}</span>
        </AdminCallout>
      )}

      {hasDashboard && (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Bulk upload</p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Use the template for HR_ID, name, role, line, email, manager HR_ID, active state, and scope override. Rows are validated before mutation.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Action governance</p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Dangerous changes are confirmed, reasoned, audited, and blocked server-side when your role is not authorized.
            </p>
          </div>
        </div>
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

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">Access health</p>
              <p className="mt-1 text-sm text-emerald-800">
                {activeUsers} active, {inactiveUsers} inactive, {pendingSetupUsers} setup pending.
              </p>
            </div>
            <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-wider text-orange-700">Sensitive actions</p>
              <p className="mt-1 text-sm text-orange-800">
                Role changes, deactivation, setup links, and overrides require confirmation.
              </p>
            </div>
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-wider text-sky-700">Permission posture</p>
              <p className="mt-1 text-sm text-sky-800">
                {permissionOverrideCount} override{permissionOverrideCount === 1 ? "" : "s"} active. Inherited permissions remain role based.
              </p>
            </div>
          </div>

          <div className="grid gap-8 xl:grid-cols-[420px_minmax(0,1fr)]">
            <Card className={`${panelClassName} h-fit p-0 xl:sticky xl:top-6`}>
              <AdminSectionHeader
                action={<div className="text-xs font-semibold text-[#0F172A]">{canManageUsers ? "Active" : "Read only"}</div>}
                description="Create or update a user profile, then issue setup and reset links from the user table."
                title="User editor"
              />

              {!canManageUsers && (
                <div className="mx-5 mt-5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  Your current role can review access governance but cannot create, edit, deactivate, or issue password links.
                </div>
              )}

              <form className="grid gap-5 px-5 py-5" onSubmit={saveUser}>
                <div className="space-y-4">
                  <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Identity</div>
                  <div className="grid gap-3">
                    <Input
                      aria-label="Full name"
                      className="h-9 rounded-lg border-slate-200 bg-white px-3 text-sm font-medium transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      disabled={!canManageUsers}
                      onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Full name"
                      value={form.name}
                    />
                    <Input
                      aria-label="HR ID"
                      className="h-9 rounded-lg border-slate-200 bg-white px-3 text-sm font-medium transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      disabled={!canManageUsers}
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
                      aria-label="Email address"
                      className="h-9 rounded-lg border-slate-200 bg-white px-3 text-sm font-medium transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      disabled={!canManageUsers}
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
                      aria-label="Phoenix role"
                      className="h-9 w-full rounded-lg border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      disabled={!canManageUsers}
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
                        aria-label="Phoenix line"
                        className="h-9 w-full rounded-lg border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                        disabled={!canManageUsers}
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
                        aria-label="Manager HR ID"
                        className="h-9 rounded-lg border-slate-200 bg-white px-3 text-sm font-medium transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                        disabled={!canManageUsers}
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
                      aria-label="Sales scope override"
                      className="h-9 w-full rounded-lg border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition-all duration-160 ease-out outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 hover:border-slate-300 hover:shadow-sm"
                      disabled={!canManageUsers}
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
                        aria-label="Active account"
                        checked={form.isActive}
                        className="h-4 w-4 accent-orange-500 transition-all duration-160 ease-out"
                        disabled={!canManageUsers}
                        onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))}
                        type="checkbox"
                      />
                    </label>
                  </div>
                </div>

                <Button className="h-9 w-full gap-2 rounded-lg text-sm font-medium transition-all duration-160 ease-out hover:shadow-sm active:scale-95" disabled={isSaving || !canManageUsers} type="submit">
                  {isSaving ? <LoadingSpinner /> : <CheckCircle2 className="h-4 w-4" />}
                  {canManageUsers ? "Save user" : "Read-only access"}
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
                description={canManageUsers ? "Search, filter, edit, enable, disable, and issue governed password links." : "Search and review user access. Mutations are hidden for your role."}
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

              <div className="hidden overflow-x-auto lg:block">
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
                                  <span className="font-mono text-slate-700">HR_ID {user.hrId ?? "-"}</span>
                                  <span className="text-slate-400">/</span>
                                  <span className="font-mono text-slate-700">{user.loginId}</span>
                                  {user.email && (
                                    <>
                                      <span className="text-slate-400">-</span>
                                      <span className="truncate text-slate-700">{user.email}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="flex flex-col gap-1.5">
                              <RoleBadge role={user.role} />
                              <span className="text-xs text-slate-700 font-medium">Line: {user.line}</span>
                              <span className="text-xs text-slate-500">Manager: {user.managerHrId ?? "-"}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="flex flex-col gap-1.5">
                              <ScopeBadge label="Sales" scope={user.salesScope} />
                              <ScopeBadge label="Payroll" scope={user.payrollScope} />
                              {user.salesScopeOverride && <span className={badgeClassName("orange")}>Scope override</span>}
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <PasswordBadge forcePasswordReset={user.forcePasswordReset} />
                          </td>
                          <td className="px-3 py-3 align-top">
                            <div className="flex flex-col gap-1.5">
                              <StatusBadge isActive={user.isActive} />
                              <span className="text-[11px] text-slate-500">Updated {formatDate(user.updatedAt)}</span>
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top text-right">
                            {renderUserActions(user)}
                          </td>
                        </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td className="px-4 py-16" colSpan={6}>
                          {renderEmptyUsers()}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-3 p-4 lg:hidden">
                {hasUsers ? (
                  visibleUsers.map((user) => (
                    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" key={user.loginId}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-base font-semibold text-slate-900">{user.name}</p>
                          <p className="mt-1 font-mono text-xs text-slate-600">HR_ID {user.hrId ?? "-"} / {user.loginId}</p>
                          {user.email && <p className="mt-1 truncate text-xs text-slate-500">{user.email}</p>}
                        </div>
                        <StatusBadge isActive={user.isActive} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <RoleBadge role={user.role} />
                        <PasswordBadge forcePasswordReset={user.forcePasswordReset} />
                        {user.salesScopeOverride && <span className={badgeClassName("orange")}>Scope override</span>}
                      </div>
                      <div className="mt-3 grid gap-2 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
                        <div className="flex justify-between gap-3">
                          <span>Line</span>
                          <span className="font-semibold text-slate-800">{user.line}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span>Manager HR_ID</span>
                          <span className="font-mono text-slate-800">{user.managerHrId ?? "-"}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <ScopeBadge label="Sales" scope={user.salesScope} />
                          <ScopeBadge label="Payroll" scope={user.payrollScope} />
                        </div>
                        <div className="text-[11px] text-slate-500">Updated {formatDate(user.updatedAt)}</div>
                      </div>
                      <div className="mt-3">{renderUserActions(user, "stacked")}</div>
                    </article>
                  ))
                ) : (
                  renderEmptyUsers()
                )}
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
              <div className="border-t border-slate-200/80">
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                  <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">Inherited</span>
                  <span className="inline-flex items-center rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 font-semibold text-orange-700">Override</span>
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 font-semibold text-slate-500">Restricted</span>
                  {!canManagePermissions && <span className="font-medium text-slate-500">Permission changes are locked to Super Admin governance.</span>}
                </div>
                <div className="overflow-x-auto">
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
                                {permissionActions.map((action) => {
                                  const isAllowed = allowedActions.includes(action);
                                  const isAllowOverride = permissionOverrideSet.has(`${role}:${resource}:${action}:allow`);
                                  const isDenyOverride = permissionOverrideSet.has(`${role}:${resource}:${action}:deny`);
                                  const provenance = isAllowOverride || isDenyOverride
                                    ? "Override"
                                    : isAllowed
                                      ? "Inherited"
                                      : "Restricted";
                                  return (
                                    <label
                                      className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[10px] transition-colors ${
                                        isAllowOverride || isDenyOverride
                                          ? "border-orange-200 bg-orange-50 text-orange-700"
                                          : isAllowed
                                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                            : "border-slate-200 bg-white text-slate-500"
                                      } ${canManagePermissions ? "cursor-pointer hover:text-slate-700" : "cursor-not-allowed opacity-70"}`}
                                      key={`${role}-${resource}-${action}`}
                                      title={`${provenance}: ${role} ${action} ${resource}`}
                                    >
                                      <input
                                        checked={isAllowed}
                                        className="h-3.5 w-3.5 accent-orange-500"
                                        disabled={!canManagePermissions || permissionSaving === `${role}:${resource}:${action}`}
                                        onChange={(event) =>
                                          void updatePermission(role, resource, action, event.target.checked)
                                        }
                                        type="checkbox"
                                      />
                                      <span className="uppercase font-medium">{action}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
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
      {pendingGovernanceAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-orange-200 bg-orange-50 text-orange-600">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-slate-900">{pendingGovernanceAction.title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">{pendingGovernanceAction.body}</p>
              </div>
            </div>
            <label className="mt-5 block text-xs font-semibold uppercase tracking-wider text-slate-500">
              Governance reason
              <textarea
                className="mt-2 min-h-24 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-800 outline-none transition-all duration-160 ease-out placeholder:text-slate-400 focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                maxLength={500}
                onChange={(event) => setGovernanceReason(event.target.value)}
                placeholder={pendingGovernanceAction.reasonPlaceholder}
                value={governanceReason}
              />
            </label>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button
                className="h-9 rounded-lg px-3.5 text-xs"
                disabled={isConfirmingGovernanceAction}
                onClick={() => {
                  setPendingGovernanceAction(null);
                  setGovernanceReason("");
                }}
                type="button"
                variant="secondary"
              >
                Cancel
              </Button>
              <Button
                className="h-9 rounded-lg px-3.5 text-xs"
                disabled={isConfirmingGovernanceAction}
                onClick={confirmGovernanceAction}
                type="button"
              >
                {isConfirmingGovernanceAction ? <LoadingSpinner className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                {pendingGovernanceAction.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
