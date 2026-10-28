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

import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
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
  assignablePhoenixRoles,
  getPayrollScope,
  getSalesScope,
  permissionActions,
  permissionResources,
  type BusinessScope,
  type PermissionAction,
  type PermissionMap,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { displayTitleForRole } from "@/lib/auth/hr-functions";
import { humanizeCode } from "@/lib/format/code-label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
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
  permissionOverrides?: PermissionOverrideMarker[];
  roles: readonly PhoenixRole[];
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

type BulkSetupLinkResultItem = {
  loginId: string;
  status: "sent" | "failed";
  message: string;
  setupUrl?: string;
};

type BulkSetupLinkSummary = {
  deliveryMode: "copy" | "email";
  requested: number;
  processed: number;
  sent: number;
  failed: number;
  capped: number;
  cap: number;
  results: BulkSetupLinkResultItem[];
  clipboardCopied?: boolean;
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
  "Financial Advisor": "finance",
  "Group Product Manager": "manager",
  Manager: "manager",
  "Marketing Manager": "manager",
  "Medical Rep": "employee",
  "National Sales Manager": "manager",
  "Product Manager": "manager",
  "Regional Manager": "manager",
  "SFE Manager": "manager",
  "Super Admin": "executive",
  "HR Advisory": "hr",
  "HR Operations": "hr",
  "HR Resourcing": "hr",
  "HR Administration": "hr",
  "Training Manager": "manager",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
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
      {displayTitleForRole(role)}
      <span className="ml-1 text-phx-2xs font-bold uppercase tracking-wider opacity-70">{label}</span>
    </span>
  );
}

function ScopeBadge({ label, scope }: { label: string; scope: BusinessScope }) {
  const classes = getScopeSemanticClasses(scope);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-phx-line bg-white px-2 py-0.5 text-phx-xs font-semibold text-phx-ink-soft">
      {label}
      <span className={`rounded-full border ${classes.border} ${classes.bg} px-1.5 py-0.5 text-phx-2xs ${classes.text}`}>
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
  const [passwordFilter, setPasswordFilter] = React.useState<"all" | "pending" | "ready">("all");
  const [page, setPage] = React.useState(1);
  const [uploadResults, setUploadResults] = React.useState<RowResult[] | null>(null);
  const [permissionSaving, setPermissionSaving] = React.useState<string | null>(null);
  const [setupLinkMessage, setSetupLinkMessage] = React.useState<string | null>(null);
  const [setupLinkSending, setSetupLinkSending] = React.useState<string | null>(null);
  const [selectedLoginIds, setSelectedLoginIds] = React.useState<Set<string>>(() => new Set());
  const [bulkSending, setBulkSending] = React.useState<"copy" | "email" | null>(null);
  const [bulkResults, setBulkResults] = React.useState<BulkSetupLinkSummary | null>(null);
  const [showPermissions, setShowPermissions] = React.useState(false);
  const [matrixRole, setMatrixRole] = React.useState<(typeof assignablePhoenixRoles)[number]>(assignablePhoenixRoles[0]);
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
      body: `Change ${displayTitleForRole(role)} permission for ${resource}:${action} to ${isAllowed ? "allowed" : "restricted"}. This affects every user assigned to that role and will be written to the governance audit log.`,
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
    const privilegedRole = form.role === "Super Admin" || form.role === "CEO" || form.role === "Finance Manager";
    const deactivating = Boolean(existing?.isActive && !form.isActive);

    if (roleChanged || privilegedRole || deactivating) {
      requestGovernanceConfirmation({
        body: `Save ${form.hrId.trim() || form.loginId.trim() || "this user"} with role ${displayTitleForRole(form.role)}${deactivating ? " and deactivate access" : ""}. Role and status changes can alter payroll, employee, and admin visibility immediately.`,
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

  function toggleSelect(loginId: string, checked: boolean) {
    setSelectedLoginIds((current) => {
      const next = new Set(current);
      if (checked) next.add(loginId);
      else next.delete(loginId);
      return next;
    });
  }

  function toggleSelectPage(checked: boolean) {
    setSelectedLoginIds((current) => {
      const next = new Set(current);
      for (const user of visibleUsers) {
        if (!user.isActive) continue;
        if (checked) next.add(user.loginId);
        else next.delete(user.loginId);
      }
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedLoginIds((current) => {
      const next = new Set(current);
      for (const user of filteredUsers) {
        if (user.isActive) next.add(user.loginId);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedLoginIds(new Set());
  }

  function requestBulkSetupLink(deliveryMode: "copy" | "email") {
    if (!canManageUsers) {
      setError("You do not have permission to generate password links.");
      return;
    }
    // Selection is a global set; resolve it against the full user list so a
    // change to the on-screen filter never silently changes who gets a link.
    const targets = users.filter((user) => user.isActive && selectedLoginIds.has(user.loginId));
    if (targets.length === 0) {
      setError("Select at least one active user to send links to.");
      return;
    }
    const noun = targets.length === 1 ? "user" : "users";
    // Every processed user is signed out and forced into password-setup mode —
    // including those who already have a working password. Surface that blast
    // radius so a "select all" cannot quietly reset active accounts.
    const alreadyPasswordReady = targets.filter((user) => !user.forcePasswordReset).length;
    requestGovernanceConfirmation({
      body:
        `${deliveryMode === "email" ? "Email" : "Generate copy-ready"} one-time password setup/reset links for ${targets.length} selected ${noun}. ` +
        "This signs each of them out immediately and forces a new password on next sign-in; every link expires in 48h and every send is written to the governance audit log." +
        (alreadyPasswordReady > 0
          ? ` ${alreadyPasswordReady} of them already have a working password and will be reset too.`
          : "") +
        (deliveryMode === "email"
          ? " Email delivery is bounded by the daily provider budget — any overflow beyond the per-batch cap is reported so you can re-run later."
          : ""),
      confirmLabel:
        deliveryMode === "email"
          ? `Email ${targets.length} link${targets.length === 1 ? "" : "s"}`
          : `Generate ${targets.length} link${targets.length === 1 ? "" : "s"}`,
      onConfirm: async (reason) => {
        await performBulkSetupLink(deliveryMode, reason);
      },
      reasonPlaceholder: "Reason for bulk password setup/reset links",
      title: "Confirm bulk password links",
    });
  }

  async function performBulkSetupLink(deliveryMode: "copy" | "email", governanceReason: string) {
    setError(null);
    setSetupLinkMessage(null);
    setBulkResults(null);
    setBulkSending(deliveryMode);

    const loginIds = users
      .filter((user) => user.isActive && selectedLoginIds.has(user.loginId))
      .map((user) => user.loginId);

    try {
      const response = await fetch("/api/admin/users/setup-link/bulk", {
        body: JSON.stringify({ deliveryMode, governanceReason, loginIds }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | (BulkSetupLinkSummary & { message?: string })
        | { message?: string }
        | null;

      if (!response.ok || !payload || !("results" in payload)) {
        throw new Error((payload as { message?: string } | null)?.message ?? "Bulk password links could not be sent.");
      }

      const summary = payload as BulkSetupLinkSummary;
      let clipboardCopied = false;
      if (deliveryMode === "copy") {
        const lines = summary.results
          .filter((item) => item.status === "sent" && item.setupUrl)
          .map((item) => `${item.loginId}\t${item.setupUrl}`);
        if (lines.length > 0 && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(lines.join("\n"));
            clipboardCopied = true;
          } catch {
            clipboardCopied = false;
          }
        }
      }

      setBulkResults({ ...summary, clipboardCopied });
      setSetupLinkMessage(
        deliveryMode === "email"
          ? `Emailed ${summary.sent} of ${summary.processed} link${summary.processed === 1 ? "" : "s"}` +
              `${summary.failed ? `, ${summary.failed} failed` : ""}` +
              `${summary.capped ? `, ${summary.capped} deferred over the ${summary.cap}/batch cap` : ""}.`
          : `Generated ${summary.sent} link${summary.sent === 1 ? "" : "s"}` +
              `${clipboardCopied ? " and copied them to your clipboard" : ""}` +
              `${summary.failed ? `, ${summary.failed} failed` : ""}.`,
      );
      setSelectedLoginIds(new Set());
      await loadUsers();
    } catch (bulkError) {
      setError(bulkError instanceof Error ? bulkError.message : "Bulk password links could not be sent.");
    } finally {
      setBulkSending(null);
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
    const haystack = [user.name, user.hrId, user.role, displayTitleForRole(user.role), user.line, user.loginId, user.email]
      .join(" ")
      .toLowerCase();
    if (query && !haystack.includes(query.toLowerCase())) return false;
    if (roleFilter !== "all" && user.role !== roleFilter) return false;
    if (lineFilter !== "all" && user.line !== lineFilter) return false;
    if (passwordFilter === "pending" && !user.forcePasswordReset) return false;
    if (passwordFilter === "ready" && user.forcePasswordReset) return false;
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const visibleUsers = filteredUsers.slice((page - 1) * pageSize, page * pageSize);
  const managerNameOf = (user: AccessUserRow) => {
    if (!user.managerHrId) return null;
    const manager = users.find((candidate) => candidate.hrId === user.managerHrId);
    return manager?.name ?? null;
  };
  const selectedCount = users.filter((user) => user.isActive && selectedLoginIds.has(user.loginId)).length;
  const selectableFilteredCount = filteredUsers.filter((user) => user.isActive).length;
  const pageActiveUsers = visibleUsers.filter((user) => user.isActive);
  const pageAllSelected =
    pageActiveUsers.length > 0 && pageActiveUsers.every((user) => selectedLoginIds.has(user.loginId));
  const pageSomeSelected = pageActiveUsers.some((user) => selectedLoginIds.has(user.loginId));
  const activeUsers = users.filter((user) => user.isActive).length;
  const companyPayrollUsers = users.filter((user) => user.payrollScope === "COMPANY").length;
  const salesOverrides = users.filter((user) => user.salesScopeOverride).length;
  const pendingSetupUsers = users.filter((user) => user.forcePasswordReset).length;
  const inactiveUsers = users.length - activeUsers;
  const auditEntries = data?.auditLogs.length ?? 0;
  const hasDashboard = data !== null;
  const hasUsers = filteredUsers.length > 0;
  const lineOptions = data?.lines ?? ["CNS", "Pedia", "Anti Infective", "Office", "Other"];
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
        <span className="inline-flex items-center rounded-full border border-phx-line bg-phx-paper px-2 py-1 text-phx-2xs font-semibold uppercase tracking-wider text-phx-ink-soft" title="Your role can view governance state but cannot mutate users.">
          Restricted
        </span>
      );
    }

    const buttonBase = layout === "stacked"
      ? "inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold transition-all duration-160 ease-out active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
      : "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-phx-xs font-semibold transition-all duration-160 ease-out active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";

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
    const filtered = query || roleFilter !== "all" || lineFilter !== "all" || passwordFilter !== "all";
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
            <span className="text-phx-2xs font-bold uppercase tracking-[0.18em] text-orange-700">Identity Governance</span>
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
                <p className="text-phx-2xs font-bold uppercase tracking-wider text-slate-400">{item.label}</p>
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

      {bulkResults &&
        (bulkResults.failed > 0 ||
          bulkResults.capped > 0 ||
          (bulkResults.deliveryMode === "copy" && bulkResults.results.some((item) => item.setupUrl))) && (
          <AdminCallout tone={bulkResults.failed > 0 || bulkResults.capped > 0 ? "warning" : "success"}>
            <div className="min-w-0 space-y-2">
              <p className="font-semibold">
                Bulk {bulkResults.deliveryMode === "email" ? "email" : "copy"} links — {bulkResults.sent} sent
                {bulkResults.failed > 0 ? `, ${bulkResults.failed} failed` : ""}
                {bulkResults.capped > 0 ? `, ${bulkResults.capped} deferred` : ""}.
              </p>
              {bulkResults.capped > 0 && (
                <p className="text-xs leading-5">
                  Only the first {bulkResults.cap} were processed to stay within the{" "}
                  {bulkResults.deliveryMode === "email" ? "daily email budget" : "per-batch limit"}. Re-run for the
                  remaining {bulkResults.capped} once ready.
                </p>
              )}
              {bulkResults.deliveryMode === "copy" && (
                <p className="text-xs leading-5">
                  {bulkResults.clipboardCopied
                    ? "Links copied to your clipboard as HR_ID + URL rows — paste into a sheet or message to distribute."
                    : "Copy the links below (HR_ID + URL) to distribute manually."}
                </p>
              )}
              {bulkResults.failed > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">Show {bulkResults.failed} failed</summary>
                  <ul className="mt-1 space-y-0.5">
                    {bulkResults.results
                      .filter((item) => item.status === "failed")
                      .map((item) => (
                        <li className="break-all" key={item.loginId}>
                          <span className="font-mono">{item.loginId}</span> — {item.message}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
              {bulkResults.deliveryMode === "copy" && !bulkResults.clipboardCopied && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">Show links</summary>
                  <ul className="mt-1 space-y-0.5">
                    {bulkResults.results
                      .filter((item) => item.status === "sent" && item.setupUrl)
                      .map((item) => (
                        <li className="break-all" key={item.loginId}>
                          <span className="font-mono">{item.loginId}</span> — {item.setupUrl}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
            </div>
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
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <colgroup>
                <col className="w-[8%]" />
                <col className="w-[28%]" />
                <col className="w-[24%]" />
                <col className="w-[14%]" />
                <col className="w-[26%]" />
              </colgroup>
              <thead className="bg-phx-paper text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-ink-soft">
                <tr>
                  <th className="px-3 py-3">Row</th>
                  <th className="px-3 py-3">Name</th>
                  <th className="px-3 py-3">Role / Line</th>
                  <th className="px-3 py-3">Action</th>
                  <th className="px-3 py-3">Errors</th>
                </tr>
              </thead>
              <tbody>
                {uploadResults.map((result) => (
                  <tr className="border-b border-phx-line align-top" key={result.row}>
                    <td className="px-3 py-2 font-mono text-xs">{result.row}</td>
                    <td className="min-w-0 break-words px-3 py-2">{result.name || result.hrId || "—"}</td>
                    <td className="min-w-0 break-words px-3 py-2">
                      <p>{displayTitleForRole(result.role)}</p>
                      {result.line ? <p className="text-xs text-slate-500">{result.line}</p> : null}
                    </td>
                    <td className="min-w-0 break-words px-3 py-2">
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
                    <td className="min-w-0 break-words px-3 py-2 text-xs text-[#DC2626]">
                      {result.errors.length > 0 ? result.errors.join(", ") : "—"}
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
                        <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">{card.label}</p>
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
                action={<div className="text-xs font-semibold text-phx-ink">{canManageUsers ? "Active" : "Read only"}</div>}
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
                  <div className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Identity</div>
                  <div className="grid gap-3">
                    <Input
                      aria-label="Full name"
                      className="h-9 px-3"
                      disabled={!canManageUsers}
                      onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Full name"
                      value={form.name}
                    />
                    <Input
                      aria-label="HR ID"
                      className="h-9 px-3"
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
                      className="h-9 px-3"
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
                  <div className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Organization</div>
                  <div className="grid gap-3">
                    <SearchableSelect
                      aria-label="Phoenix role"
                      className="h-9 w-full px-3"
                      disabled={!canManageUsers}
                      onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as PhoenixRole }))}
                      value={form.role}
                    >
                      {assignablePhoenixRoles.map((role) => (
                        <option key={role} value={role}>
                          {displayTitleForRole(role)}
                        </option>
                      ))}
                    </SearchableSelect>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <SearchableSelect
                        aria-label="Phoenix line"
                        className="h-9 w-full px-3"
                        disabled={!canManageUsers}
                        onChange={(e) => setForm((p) => ({ ...p, line: e.target.value as PhoenixLine }))}
                        value={form.line}
                      >
                        {lineOptions.map((line) => (
                          <option key={line} value={line}>
                            {line}
                          </option>
                        ))}
                      </SearchableSelect>
                      <Input
                        aria-label="Manager HR ID"
                        className="h-9 px-3"
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
                  <div className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Access scope</div>
                  <div className="grid gap-3">
                    <SearchableSelect
                      aria-label="Sales scope override"
                      className="h-9 w-full px-3"
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
                    </SearchableSelect>
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
                  <div className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Status</div>
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
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_170px_140px_170px]">
                  <div className="relative group">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400 transition-colors duration-160 ease-out group-focus-within:text-orange-500" />
                    <Input
                      className="h-9 pl-9"
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setPage(1);
                      }}
                      placeholder="Search name, HR_ID, role, line"
                      value={query}
                    />
                  </div>
                  <SearchableSelect
                    className="h-9 w-full px-3"
                    onChange={(e) => {
                      setRoleFilter(e.target.value);
                      setPage(1);
                    }}
                    value={roleFilter}
                  >
                    <option value="all">All roles</option>
                    {assignablePhoenixRoles.map((role) => (
                      <option key={role} value={role}>
                        {displayTitleForRole(role)}
                      </option>
                    ))}
                  </SearchableSelect>
                  <SearchableSelect
                    className="h-9 w-full px-3"
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
                  </SearchableSelect>
                  <SearchableSelect
                    className="h-9 w-full px-3"
                    onChange={(e) => {
                      setPasswordFilter(e.target.value as "all" | "pending" | "ready");
                      setPage(1);
                    }}
                    value={passwordFilter}
                  >
                    <option value="all">All passwords</option>
                    <option value="pending">Setup pending</option>
                    <option value="ready">Password ready</option>
                  </SearchableSelect>
                </div>
              </div>

              <div className="h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent shadow-[0_1px_0_0_rgba(0,0,0,0.02)]" />

              {canManageUsers && (
                <div className="flex flex-col gap-3 border-b border-slate-200/80 bg-gradient-to-r from-sky-50/50 via-white to-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 font-semibold text-sky-700">
                      <Mail className="h-3.5 w-3.5" />
                      {selectedCount} selected
                    </span>
                    <button
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={selectableFilteredCount === 0}
                      onClick={selectAllFiltered}
                      type="button"
                    >
                      Select all filtered ({selectableFilteredCount})
                    </button>
                    {selectedCount > 0 && (
                      <button
                        className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-50"
                        onClick={clearSelection}
                        type="button"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="hidden text-phx-xs text-slate-400 sm:inline">One-time login links to selected</span>
                    <button
                      aria-label="Email one-time setup links to selected users"
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 text-xs font-semibold text-sky-700 transition-all duration-160 ease-out hover:bg-sky-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={selectedCount === 0 || bulkSending !== null}
                      onClick={() => requestBulkSetupLink("email")}
                      type="button"
                    >
                      {bulkSending === "email" ? <LoadingSpinner className="h-3.5 w-3.5" /> : <Mail className="h-3.5 w-3.5" />}
                      Email links{selectedCount > 0 ? ` (${selectedCount})` : ""}
                    </button>
                    <button
                      aria-label="Generate copy-ready setup links for selected users"
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 text-xs font-semibold text-violet-700 transition-all duration-160 ease-out hover:bg-violet-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={selectedCount === 0 || bulkSending !== null}
                      onClick={() => requestBulkSetupLink("copy")}
                      type="button"
                    >
                      {bulkSending === "copy" ? <LoadingSpinner className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      Copy links{selectedCount > 0 ? ` (${selectedCount})` : ""}
                    </button>
                  </div>
                </div>
              )}

              <div className="hidden lg:block">
                <table className="w-full table-fixed border-collapse text-left">
                  <colgroup>
                    {canManageUsers ? <col className="w-[4%]" /> : null}
                    <col className={canManageUsers ? "w-[24%]" : "w-[28%]"} />
                    <col className="w-[18%]" />
                    <col className="w-[14%]" />
                    <col className="w-[16%]" />
                    <col className="w-[24%]" />
                  </colgroup>
                  <thead className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/95 backdrop-blur-sm text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-600">
                    <tr>
                      {canManageUsers && (
                        <th className="w-10 px-3 py-3">
                          <input
                            aria-label="Select all active users on this page"
                            checked={pageAllSelected}
                            className="h-4 w-4 accent-orange-500"
                            onChange={(event) => toggleSelectPage(event.target.checked)}
                            ref={(el) => {
                              if (el) el.indeterminate = pageSomeSelected && !pageAllSelected;
                            }}
                            type="checkbox"
                          />
                        </th>
                      )}
                      <th className="px-3 py-3">User</th>
                      <th className="px-3 py-3">Role / Line</th>
                      <th className="px-3 py-3">Access</th>
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
                          {canManageUsers && (
                            <td className="px-3 py-3 align-top">
                              <input
                                aria-label={`Select ${user.name}`}
                                checked={selectedLoginIds.has(user.loginId)}
                                className="h-4 w-4 accent-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
                                disabled={!user.isActive}
                                onChange={(event) => toggleSelect(user.loginId, event.target.checked)}
                                title={!user.isActive ? "Inactive users cannot receive password links." : undefined}
                                type="checkbox"
                              />
                            </td>
                          )}
                          <td className="min-w-0 break-words px-3 py-3 align-top">
                            <div className="flex items-start gap-2.5">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-100 to-orange-50 text-orange-700 font-semibold text-sm shadow-sm transition-all duration-160 ease-out group-hover:scale-110 group-hover:shadow-md group-hover:from-orange-200 group-hover:to-orange-100">
                                {user.name.charAt(0).toUpperCase()}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-slate-900 transition-colors duration-160 ease-out group-hover:text-orange-950">{user.name}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600">
                                  <span className="font-mono text-slate-700">{user.loginId}</span>
                                  {user.email && <span className="break-all text-slate-700">{user.email}</span>}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="min-w-0 break-words px-3 py-3 align-top">
                            <div className="flex flex-col gap-1.5">
                              <RoleBadge role={user.role} />
                              <span className="text-xs text-slate-700 font-medium">Line: {user.line}</span>
                              {managerNameOf(user) ? <span className="text-xs text-slate-500">Manager: {managerNameOf(user)}</span> : null}
                            </div>
                          </td>
                          <td className="min-w-0 break-words px-3 py-3 align-top">
                            <div className="flex flex-col gap-1.5">
                              <ScopeBadge label="Sales" scope={user.salesScope} />
                              <ScopeBadge label="Payroll" scope={user.payrollScope} />
                              {user.salesScopeOverride && <span className={badgeClassName("orange")}>Scope override</span>}
                            </div>
                          </td>
                          <td className="min-w-0 break-words px-3 py-3 align-top">
                            <div className="flex flex-col items-start gap-1.5">
                              <StatusBadge isActive={user.isActive} />
                              <PasswordBadge forcePasswordReset={user.forcePasswordReset} />
                              <span className="text-phx-xs text-slate-500">Updated {formatDate(user.updatedAt)}</span>
                            </div>
                          </td>
                          <td className="min-w-0 px-3 py-3 align-top text-right">
                            {renderUserActions(user)}
                          </td>
                        </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td className="px-4 py-16" colSpan={canManageUsers ? 6 : 5}>
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
                        <div className="flex min-w-0 items-start gap-2.5">
                          {canManageUsers && (
                            <input
                              aria-label={`Select ${user.name}`}
                              checked={selectedLoginIds.has(user.loginId)}
                              className="mt-1 h-4 w-4 shrink-0 accent-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={!user.isActive}
                              onChange={(event) => toggleSelect(user.loginId, event.target.checked)}
                              title={!user.isActive ? "Inactive users cannot receive password links." : undefined}
                              type="checkbox"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="break-words text-base font-semibold text-slate-900">{user.name}</p>
                            <p className="mt-1 break-all font-mono text-xs text-slate-600">{user.loginId}</p>
                            {user.email && <p className="mt-1 break-all text-xs text-slate-500">{user.email}</p>}
                          </div>
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
                        {managerNameOf(user) ? (
                          <div className="flex justify-between gap-3">
                            <span>Manager</span>
                            <span className="text-slate-800">{managerNameOf(user)}</span>
                          </div>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          <ScopeBadge label="Sales" scope={user.salesScope} />
                          <ScopeBadge label="Payroll" scope={user.payrollScope} />
                        </div>
                        <div className="text-phx-xs text-slate-500">Updated {formatDate(user.updatedAt)}</div>
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
                <div className="border-b border-slate-200/80 px-4 py-3">
                  <SearchableSelect
                    aria-label="Role"
                    className="h-9 w-full px-3 sm:w-72"
                    onChange={(event) => setMatrixRole(event.target.value as (typeof assignablePhoenixRoles)[number])}
                    value={matrixRole}
                  >
                    {assignablePhoenixRoles.map((role) => (
                      <option key={role} value={role}>
                        {displayTitleForRole(role)}
                      </option>
                    ))}
                  </SearchableSelect>
                  <p className="mt-2 text-xs text-slate-600">
                    Sales: <span className="font-semibold text-slate-800">{getSalesScope({ role: matrixRole })}</span> · Payroll:{" "}
                    <span className="font-semibold text-slate-800">{getPayrollScope({ role: matrixRole })}</span>
                  </p>
                </div>
                <table className="w-full table-fixed border-collapse text-left text-xs">
                  <colgroup>
                    <col className="w-[34%]" />
                    <col className="w-[66%]" />
                  </colgroup>
                  <thead className="bg-stone-50 text-phx-2xs font-medium uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3 py-3">Area</th>
                      <th className="px-3 py-3">Allowed actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {permissionResources.map((resource) => {
                      const role = matrixRole;
                      const allowedActions = data?.permissions?.[role]?.[resource] ?? [];
                      return (
                        <tr className="border-b border-slate-100/80 align-top transition-colors hover:bg-stone-50/50" key={`${role}-${resource}`}>
                          <td className="min-w-0 break-words px-3 py-3 font-medium text-slate-700">{humanizeCode(resource)}</td>
                          <td className="min-w-0 px-3 py-3">
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
                                                        className={`flex items-center gap-1.5 border px-1.5 py-1 text-phx-2xs transition-colors ${
                                                          isAllowOverride || isDenyOverride
                                                            ? "border-orange-200 bg-orange-50 text-orange-700"
                                                            : isAllowed
                                                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                                              : "border-slate-200 bg-white text-slate-500"
                                                        } ${canManagePermissions ? "cursor-pointer hover:text-slate-700" : "cursor-not-allowed opacity-70"}`}
                                                        key={`${role}-${resource}-${action}`}
                                                        title={`${provenance}: ${matrixRole} ${action} ${resource}`}
                                                      >
                                                        <input
                                                          checked={isAllowed}
                                                          className="h-3.5 w-3.5 accent-orange-500"
                                                          disabled={!canManagePermissions || permissionSaving === `${matrixRole}:${resource}:${action}`}
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
                        </tr>
                      );
                    })}
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
                className={cn(phxTextareaClassName, "mt-2 min-h-24 normal-case tracking-normal")}
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
