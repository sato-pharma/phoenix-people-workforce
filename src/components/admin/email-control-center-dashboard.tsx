"use client";

import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { Switch } from "@/components/ui/switch";
import { phoenixRoles, type PhoenixRole } from "@/lib/auth/permissions";
import type { EmailControlCenterItem, EmailControlCenterSnapshot } from "@/lib/notifications/email-control-center";
import { cn } from "@/lib/utils";

const ROLE_OPTIONS = phoenixRoles.map((role) => ({ code: role, label: role }));

// Mirrors emailTemplateRecipientRoleOptions in src/lib/email-templates/service.ts — duplicated
// here (rather than imported) so this client bundle doesn't pull in that server-heavy module
// just for a string list. Keep in sync if that list ever changes.
const TEMPLATE_ROLE_OPTIONS = [
  "employee",
  "candidate",
  "direct_manager",
  "manager_of_manager",
  "manager_chain",
  "employee_team",
  "direct_reports",
  "employee_line",
  "hr",
  "hr_manager",
  "finance",
  "hiring_manager",
  "admin",
  "ceo",
  "recruiter",
  "district_manager",
  "regional_sales_manager",
  "national_sales_manager",
  "line_manager",
  "same_line_selected_titles",
  "all_lines_selected_titles",
  "selected_lines_selected_titles",
].map((role) => ({ code: role, label: role.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") }));

type PatchPayload = {
  enabled?: boolean;
  roles?: PhoenixRole[];
  toRoles?: string[];
};

export function EmailControlCenterDashboard({
  initialSnapshot,
  canMutate,
}: {
  initialSnapshot: EmailControlCenterSnapshot;
  canMutate: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [moduleFilter, setModuleFilter] = useState("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const moduleOptions = useMemo(() => ["All", ...snapshot.groups.map((group) => group.module)], [snapshot.groups]);
  const visibleGroups = useMemo(
    () => (moduleFilter === "All" ? snapshot.groups : snapshot.groups.filter((group) => group.module === moduleFilter)),
    [moduleFilter, snapshot.groups],
  );

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/email-control-center");
      if (!res.ok) throw new Error(`Refresh failed (${res.status})`);
      setSnapshot((await res.json()) as EmailControlCenterSnapshot);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to refresh.");
    } finally {
      setLoading(false);
    }
  }

  async function savePatch(item: EmailControlCenterItem, patch: PatchPayload) {
    setPendingId(item.id);
    try {
      const [system, key] = [item.sourceSystem === "role_recipients" ? "role-recipients" : item.sourceSystem === "email_notifications" ? "email-notifications" : "email-templates", item.key];
      const res = await fetch(`/api/admin/email-control-center/${system}/${encodeURIComponent(key)}`, {
        body: JSON.stringify(patch),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
      toast.success(`${item.label} updated.`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold text-phx-ink-soft">
          {snapshot.totals.total} automated emails · {snapshot.totals.enabled} on · {snapshot.totals.disabled} off
          {loading ? <Loader2 className="ml-2 inline h-3 w-3 animate-spin" /> : null}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {moduleOptions.map((module) => (
            <button
              className={cn(
                "rounded-full border px-3 py-1 text-phx-xs font-black transition",
                moduleFilter === module ? "border-[#0B0B0B] bg-[#0B0B0B] text-white" : "border-phx-line bg-white text-phx-ink-2 hover:border-orange-300",
              )}
              key={module}
              onClick={() => setModuleFilter(module)}
              type="button"
            >
              {module}
            </button>
          ))}
        </div>
      </div>

      {!canMutate ? (
        <div className="flex items-start gap-1.5 rounded-lg border border-sky-200 bg-sky-50 p-2.5 text-xs text-sky-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>View only — Super Admin access is required to change any of these settings.</span>
        </div>
      ) : null}

      <div className="space-y-6">
        {visibleGroups.map((group) => (
          <div key={group.module}>
            <h3 className="mb-2 text-xs font-black uppercase tracking-wide text-phx-ink-faint">{group.module}</h3>
            <div className="grid gap-3">
              {group.items.map((item) => (
                <ControlCenterRow
                  canMutate={canMutate}
                  expanded={expandedId === item.id}
                  item={item}
                  key={item.id}
                  onSave={(patch) => savePatch(item, patch)}
                  onToggleExpand={() => setExpandedId((current) => (current === item.id ? null : item.id))}
                  pending={pendingId === item.id}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<EmailControlCenterItem["sourceSystem"], string> = {
  role_recipients: "Cron / HR digest",
  email_notifications: "Core system email",
  email_templates: "Email template",
};

function ControlCenterRow({
  item,
  canMutate,
  pending,
  expanded,
  onToggleExpand,
  onSave,
}: {
  item: EmailControlCenterItem;
  canMutate: boolean;
  pending: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSave: (patch: PatchPayload) => void;
}) {
  const [draftRoles, setDraftRoles] = useState<string[]>(item.recipientSummary.roles ?? item.recipientSummary.toRoles ?? []);
  const rolesDirty = expanded && JSON.stringify([...draftRoles].sort()) !== JSON.stringify([...(item.recipientSummary.roles ?? item.recipientSummary.toRoles ?? [])].sort());

  return (
    <div className="rounded-2xl border border-phx-line bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-black text-phx-ink">{item.label}</h4>
            <span className="rounded-full border border-phx-line bg-phx-paper px-2 py-0.5 text-phx-xs font-black uppercase tracking-wide text-phx-ink-faint">
              {SOURCE_LABEL[item.sourceSystem]}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-xs text-phx-ink-soft">{item.description}</p>
          <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">{item.recipientSummary.countLabel}</p>
        </div>

        <div className="flex items-center gap-2">
          <div className={cn("flex items-center gap-2 rounded-full border border-phx-line bg-phx-paper px-3 py-2", !canMutate && "pointer-events-none opacity-50")}>
            <span className="text-xs font-bold text-phx-ink-2">{item.enabled ? "On" : "Off"}</span>
            <Switch
              checked={item.enabled}
              label={`${item.label} enabled`}
              onChange={(enabled) => canMutate && onSave({ enabled })}
            />
          </div>
          {(item.recipientSummary.kind === "roles" || item.recipientSummary.kind === "template_rules") && canMutate ? (
            <button
              className="rounded-lg border border-phx-line bg-white px-3 py-2 text-phx-xs font-black text-phx-ink transition hover:border-orange-300"
              onClick={onToggleExpand}
              type="button"
            >
              {expanded ? "Close" : "Edit roles"}
            </button>
          ) : null}
          <a className="inline-flex items-center gap-1 text-phx-xs font-black text-phx-accent hover:underline" href={item.deepLinkHref}>
            Full editor <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      {item.hybridNotice ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-sky-200 bg-sky-50 p-2.5 text-xs text-sky-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{item.hybridNotice}</span>
        </div>
      ) : null}
      {item.roleGatingCaveat ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-sky-200 bg-sky-50 p-2.5 text-xs text-sky-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{item.roleGatingCaveat}</span>
        </div>
      ) : null}

      {item.sourceSystem === "email_notifications" ? (
        <p className="mt-3 text-phx-xs text-phx-ink-faint">
          Recipient routing (who exactly, e.g. direct manager vs. selected job titles) is edited in the full editor — this row only
          controls whether it sends at all.
        </p>
      ) : null}

      {expanded && (item.recipientSummary.kind === "roles" || item.recipientSummary.kind === "template_rules") ? (
        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-phx-paper-2 pt-3">
          <MultiSelectFilter
            allLabel="Nobody"
            label={item.recipientSummary.kind === "roles" ? "Recipient roles" : "To roles"}
            mode="include"
            onModeChange={() => {
              /* Exclude mode doesn't apply to a recipient list — always "include". */
            }}
            onSelectedChange={setDraftRoles}
            options={item.recipientSummary.kind === "roles" ? ROLE_OPTIONS : TEMPLATE_ROLE_OPTIONS}
            selected={draftRoles}
          />
          <button
            className="inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-[#0B0B0B] px-4 text-phx-xs font-black text-white transition hover:bg-[#1E293B] disabled:opacity-50"
            disabled={pending || !rolesDirty}
            onClick={() =>
              onSave(
                item.recipientSummary.kind === "roles"
                  ? { roles: draftRoles as PhoenixRole[] }
                  : { toRoles: draftRoles },
              )
            }
            type="button"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save roles
          </button>
        </div>
      ) : null}
    </div>
  );
}
