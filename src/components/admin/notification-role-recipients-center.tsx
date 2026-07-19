"use client";

import { AlertTriangle, BellRing, Loader2 } from "lucide-react";
import { useState } from "react";

import { AdminSectionHeader } from "@/components/admin/admin-design-system";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { phoenixRoles, type PhoenixRole } from "@/lib/auth/permissions";
import type { NotificationRoleKey } from "@/lib/notifications/role-recipients";

type NotificationRolePolicyView = {
  key: NotificationRoleKey;
  label: string;
  description: string;
  roles: PhoenixRole[];
};

const ROLE_OPTIONS = phoenixRoles.map((role) => ({ code: role, label: role }));

// Documentation about WHEN each notification fires — kept in code next to the UI, not in the
// DB row, since it's informational, not configuration. Only entries worth calling out (fires
// from more than one job, or from the 5-minute processor instead of the daily cron) get a hint.
const TRIGGERED_BY: Partial<Record<NotificationRoleKey, string>> = {
  ireports360_sync_notify: "The 3x/day sync job and the weekly reconcile job — both fire this.",
  attendance_ingestion_alert: "The 5-minute notification outbox processor, not the daily cron.",
};

// Cards for the 2 notifications whose recipient set is a hybrid of this admin-editable
// broadcast list plus a dynamically-resolved portion that isn't configurable here.
const HYBRID_NOTICE: Partial<Record<NotificationRoleKey, string>> = {
  vacation_sla_hr_escalation: "The manager-stage recipient is always the specific request's manager-of-manager and isn't affected by this list.",
  probation_weekly_dv_digest: "The probationer's own manager, NSM chain, and line-matched PM/GPM are always included and aren't affected by this list.",
};

export function NotificationRoleRecipientsCenter({ initialPolicies }: { initialPolicies: NotificationRolePolicyView[] }) {
  const [policies, setPolicies] = useState(initialPolicies);
  const [savingKey, setSavingKey] = useState<NotificationRoleKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function updatePolicy(key: NotificationRoleKey, roles: PhoenixRole[]) {
    setPolicies((current) => current.map((policy) => (policy.key === key ? { ...policy, roles } : policy)));
  }

  async function savePolicy(policy: NotificationRolePolicyView) {
    setSavingKey(policy.key);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/notification-recipients/${policy.key}`, {
        body: JSON.stringify({ roles: policy.roles }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; policy?: NotificationRolePolicyView; message?: string } | null;
      if (!response.ok || !payload?.ok || !payload.policy) {
        throw new Error(payload?.message ?? `Request failed (${response.status})`);
      }
      updatePolicy(policy.key, payload.policy.roles);
      setMessage(`${policy.label} recipients saved.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save notification recipients.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="space-y-4">
      <AdminSectionHeader
        description="Which roles receive each cron-triggered system notification. Editing here changes the next run — not a display-only setting."
        title="Notification Recipients"
      />

      {message ? (
        <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2.5 text-sm font-semibold text-[#0F172A]">{message}</div>
      ) : null}

      <div className="grid gap-4">
        {policies.map((policy) => (
          <NotificationPolicyCard
            key={policy.key}
            onRolesChange={(roles) => updatePolicy(policy.key, roles)}
            onSave={() => savePolicy(policy)}
            policy={policy}
            saving={savingKey === policy.key}
          />
        ))}
      </div>
    </div>
  );
}

function NotificationPolicyCard({
  policy,
  saving,
  onRolesChange,
  onSave,
}: {
  policy: NotificationRolePolicyView;
  saving: boolean;
  onRolesChange: (roles: PhoenixRole[]) => void;
  onSave: () => void;
}) {
  const triggeredBy = TRIGGERED_BY[policy.key];
  const hybridNotice = HYBRID_NOTICE[policy.key];
  const isEmpty = policy.roles.length === 0;

  return (
    <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-black text-[#0F172A]">
            <BellRing className="h-4 w-4 text-[#F97316]" />
            {policy.label}
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-[#64748B]">{policy.description}</p>
          {triggeredBy ? <p className="mt-1 text-xs font-semibold text-[#94A3B8]">Triggered by: {triggeredBy}</p> : null}
        </div>
      </div>

      {hybridNotice ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-sky-200 bg-sky-50 p-2.5 text-xs text-sky-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{hybridNotice}</span>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <MultiSelectFilter
          allLabel="Nobody (disabled)"
          label="Recipient roles"
          mode="include"
          onModeChange={() => {
            /* Exclude mode doesn't apply to a recipient list — always "include". */
          }}
          onSelectedChange={(next) => onRolesChange(next as PhoenixRole[])}
          options={ROLE_OPTIONS}
          selected={policy.roles}
        />
        <button
          className="inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-[#0B0B0B] px-4 text-[11px] font-black text-white transition hover:bg-[#1E293B] disabled:opacity-50"
          disabled={saving}
          onClick={onSave}
          type="button"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </button>
      </div>

      {isEmpty ? (
        <div className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>No roles selected — nobody will receive this notification.</span>
        </div>
      ) : null}
    </div>
  );
}
