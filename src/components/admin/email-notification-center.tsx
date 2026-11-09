"use client";

import Link from "next/link";
import { useState } from "react";
import { BellRing, Check, Loader2, Mail, PencilLine, Route, ShieldCheck } from "lucide-react";

import {
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Hand-kept copy of `emailNotificationTypes` in src/lib/notifications/email.ts — this is a client
// component and that module is server-side. The copy is NOT free: adding `probation_milestone`
// there on 2026-09-29 and not here turned the required `checks` job red on Typecheck alone.
// tests/email-control-center.test.ts now pins the two lists to the same members, so the next
// addition fails in the unit suite with a message that says what to do.
type EmailNotificationType =
  | "probation"
  | "probation_milestone"
  | "contract_renewal"
  | "birthday"
  | "offer"
  | "resignation"
  | "password_reset"
  | "user_created"
  | "general";
type EmailRecipientMode =
  | "hr_notifications"
  | "employee"
  | "direct_manager"
  | "manager_manager"
  | "manager_chain"
  | "employee_and_direct_manager"
  | "candidate"
  | "same_line_selected_titles"
  | "selected_titles_all_lines"
  | "selected_titles_selected_lines";

type EmailPolicyView = {
  description: string;
  enabled: boolean;
  includeHrInbox: boolean;
  label: string;
  recipientMode: EmailRecipientMode;
  recipientModes: EmailRecipientMode[];
  targetLines: string[];
  targetTitles: string[];
  type: EmailNotificationType;
};

type EmailOutboxStats = {
  available: boolean;
  failed: number;
  lastSentAt: string | null;
  pending: number;
  recentAllowed: number;
  recentTotal: number;
  sent: number;
};

type EmailNotificationCenterProps = {
  initialPolicies: EmailPolicyView[];
  outboxStats: EmailOutboxStats;
  routingOptions: {
    lines: string[];
    titles: string[];
  };
};

const recipientModeOptions: Array<{
  description: string;
  label: string;
  value: EmailRecipientMode;
}> = [
  {
    description: "Use HR_NOTIFICATION_EMAILS only.",
    label: "HR inbox",
    value: "hr_notifications",
  },
  {
    description: "Send to the employee work email.",
    label: "Employee",
    value: "employee",
  },
  {
    description: "Resolve the employee's direct manager.",
    label: "Direct manager",
    value: "direct_manager",
  },
  {
    description: "Resolve the manager of the direct manager.",
    label: "Manager's manager",
    value: "manager_manager",
  },
  {
    description: "Resolve direct manager and upward manager chain.",
    label: "Manager chain",
    value: "manager_chain",
  },
  {
    description: "Send to employee and direct manager.",
    label: "Employee + manager",
    value: "employee_and_direct_manager",
  },
  {
    description: "Use candidate email from the offer record.",
    label: "Candidate",
    value: "candidate",
  },
  {
    description: "Resolve selected job titles in the same line as the target employee.",
    label: "Same-line titles",
    value: "same_line_selected_titles",
  },
  {
    description: "Resolve selected job titles across all company lines.",
    label: "Selected titles, all lines",
    value: "selected_titles_all_lines",
  },
  {
    description: "Resolve selected job titles only inside selected lines.",
    label: "Selected titles + lines",
    value: "selected_titles_selected_lines",
  },
];

function formatDateTime(value: string | null) {
  if (!value) return "No successful send yet";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function EmailNotificationCenter({
  initialPolicies,
  outboxStats,
  routingOptions,
}: EmailNotificationCenterProps) {
  const [policies, setPolicies] = useState(initialPolicies);
  const [savingType, setSavingType] = useState<EmailNotificationType | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function updatePolicy(type: EmailNotificationType, patch: Partial<EmailPolicyView>) {
    setPolicies((current) =>
      current.map((policy) => (policy.type === type ? { ...policy, ...patch } : policy)),
    );
  }

  function toggleMode(policy: EmailPolicyView, mode: EmailRecipientMode, checked: boolean) {
    const nextModes = checked
      ? Array.from(new Set([...policy.recipientModes, mode]))
      : policy.recipientModes.filter((item) => item !== mode);
    const recipientModes = nextModes.length ? nextModes : [policy.recipientMode];
    updatePolicy(policy.type, {
      recipientMode: recipientModes[0],
      recipientModes,
    });
  }

  function toggleTextValue(
    policy: EmailPolicyView,
    key: "targetLines" | "targetTitles",
    value: string,
    checked: boolean,
  ) {
    const current = policy[key];
    updatePolicy(policy.type, {
      [key]: checked
        ? Array.from(new Set([...current, value]))
        : current.filter((item) => item !== value),
    } as Partial<EmailPolicyView>);
  }

  async function savePolicy(policy: EmailPolicyView) {
    setSavingType(policy.type);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/email-notifications", {
        body: JSON.stringify({
          enabled: policy.enabled,
          includeHrInbox: policy.includeHrInbox,
          notificationType: policy.type,
          recipientMode: policy.recipientMode,
          recipientModes: policy.recipientModes,
          targetLines: policy.targetLines,
          targetTitles: policy.targetTitles,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PATCH",
      });
      const payload = (await response.json().catch(() => null)) as {
        message?: string;
        policy?: EmailPolicyView;
      } | null;

      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to save notification policy.");
      }

      if (payload?.policy) updatePolicy(policy.type, payload.policy);
      setMessage(`${policy.label} routing saved.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save notification policy.");
    } finally {
      setSavingType(null);
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip tone="orange">Delivery governance</AdminInsightChip>
            <AdminInsightChip>Manager hierarchy routing</AdminInsightChip>
            <AdminInsightChip tone="slate">On/off per workflow</AdminInsightChip>
          </div>
        }
        description="Control which Phoenix emails are allowed to send and route their recipients by business logic instead of hard-coded names."
        eyebrow="Email Governance"
        icon={<Mail className="h-3.5 w-3.5" />}
        title="Email Notification Center"
      />

      <Card className={cn(adminPanelClassName, "flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between")}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-phx-accent-soft text-phx-accent-press">
            <PencilLine className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-black text-phx-ink">Email wording lives in Email Templates</p>
            <p className="mt-1 text-sm leading-6 text-phx-ink-soft">
              This page controls only <strong>whether</strong> each email sends and <strong>who</strong> receives it.
              To edit the actual subject and content, open the Email Templates editor.
            </p>
          </div>
        </div>
        <Link
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-phx-ink px-4 text-sm font-black text-white hover:bg-[#1E293B]"
          href="/admin/email-templates"
        >
          Open Email Templates
        </Link>
      </Card>

      {!outboxStats.available ? (
        <div className="rounded-[16px] border border-[#FED7AA] bg-phx-accent-soft px-4 py-3 text-sm font-bold text-[#9A3412]">
          Outbox statistics are unavailable — the notification outbox table is not deployed yet. Run the latest Supabase migration to see live counts.
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <AdminStatCard
          description="Typed workflow emails in the latest outbox sample."
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Allowed"
          value={outboxStats.available ? outboxStats.recentAllowed : "—"}
        />
        <AdminStatCard
          description="Queued emails waiting for retry or processing."
          icon={<BellRing className="h-5 w-5" />}
          label="Pending"
          value={outboxStats.available ? outboxStats.pending : "—"}
        />
        <AdminStatCard
          description="Successfully accepted by the provider."
          icon={<Check className="h-5 w-5" />}
          label="Sent"
          value={outboxStats.available ? outboxStats.sent : "—"}
        />
        <AdminStatCard
          description={outboxStats.available ? formatDateTime(outboxStats.lastSentAt) : "Unavailable"}
          icon={<Route className="h-5 w-5" />}
          label="Last Send"
          value={outboxStats.available ? outboxStats.recentTotal : "—"}
        />
      </div>

      {message ? (
        <div className="rounded-[16px] border border-[#FED7AA] bg-phx-accent-soft px-4 py-3 text-sm font-bold text-[#9A3412]">
          {message}
        </div>
      ) : null}

      <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
        <AdminSectionHeader
          description="Enable only the workflow emails you want and select recipient logic for each type."
          title="Routing Policies"
        />
        <div className="divide-y divide-phx-line">
          {policies.map((policy) => (
            <div className="space-y-4 bg-white p-4" key={policy.type}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-black text-phx-ink">{policy.label}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-1 text-phx-sm font-black uppercase tracking-[0.14em]",
                        policy.enabled
                          ? "bg-[#DCFCE7] text-[#166534]"
                          : "bg-phx-paper-2 text-phx-ink-soft",
                      )}
                    >
                      {policy.enabled ? "Enabled" : "Paused"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-phx-ink-soft">{policy.description}</p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-start">
                <div>
                  <span className="mb-2 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                    Recipient logic
                  </span>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {recipientModeOptions.map((option) => (
                      <label
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm transition",
                          policy.recipientModes.includes(option.value)
                            ? "border-phx-accent-line bg-phx-accent-soft text-[#9A3412]"
                            : "border-phx-line bg-white text-phx-ink",
                        )}
                        key={option.value}
                      >
                        <input
                          checked={policy.recipientModes.includes(option.value)}
                          className="mt-1 h-4 w-4 accent-phx-accent"
                          onChange={(event) => toggleMode(policy, option.value, event.target.checked)}
                          type="checkbox"
                        />
                        <span>
                          <span className="block font-black">{option.label}</span>
                          <span className="block text-xs font-semibold leading-5 text-phx-ink-soft">
                            {option.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <Button
                  className="h-11 rounded-xl bg-phx-accent px-4 text-white hover:bg-phx-accent-hover"
                  disabled={savingType === policy.type}
                  onClick={() => void savePolicy(policy)}
                >
                  {savingType === policy.type ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-sm font-bold text-phx-ink">
                  <input
                    checked={policy.enabled}
                    className="h-4 w-4 accent-phx-accent"
                    onChange={(event) => updatePolicy(policy.type, { enabled: event.target.checked })}
                    type="checkbox"
                  />
                  Allow Resend delivery
                </label>
                <label className="inline-flex items-center gap-2 text-sm font-bold text-phx-ink">
                  <input
                    checked={policy.includeHrInbox}
                    className="h-4 w-4 accent-phx-accent"
                    onChange={(event) => updatePolicy(policy.type, { includeHrInbox: event.target.checked })}
                    type="checkbox"
                  />
                  Copy HR inbox
                </label>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-[16px] border border-phx-line bg-phx-paper p-3">
                  <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                    Company titles
                  </p>
                  <div className="mt-3 max-h-44 space-y-2 overflow-auto pr-1">
                    {routingOptions.titles.length ? routingOptions.titles.map((title) => (
                      <label className="flex items-center gap-2 text-sm font-bold text-phx-ink" key={title}>
                        <input
                          checked={policy.targetTitles.includes(title)}
                          className="h-4 w-4 accent-phx-accent"
                          onChange={(event) => toggleTextValue(policy, "targetTitles", title, event.target.checked)}
                          type="checkbox"
                        />
                        {title}
                      </label>
                    )) : (
                      <p className="text-xs font-bold text-phx-ink-soft">No employee titles found yet.</p>
                    )}
                  </div>
                </div>

                <div className="rounded-[16px] border border-phx-line bg-phx-paper p-3">
                  <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                    Lines
                  </p>
                  <div className="mt-3 max-h-44 space-y-2 overflow-auto pr-1">
                    {routingOptions.lines.length ? routingOptions.lines.map((line) => (
                      <label className="flex items-center gap-2 text-sm font-bold text-phx-ink" key={line}>
                        <input
                          checked={policy.targetLines.includes(line)}
                          className="h-4 w-4 accent-phx-accent"
                          onChange={(event) => toggleTextValue(policy, "targetLines", line, event.target.checked)}
                          type="checkbox"
                        />
                        {line}
                      </label>
                    )) : (
                      <p className="text-xs font-bold text-phx-ink-soft">No company lines found yet.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
