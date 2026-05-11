"use client";

import { useState } from "react";
import { BellRing, Check, Eye, Loader2, Mail, Route, ShieldCheck } from "lucide-react";

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

type EmailNotificationType =
  | "probation"
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

type EmailTemplateContent = {
  bodyText: string;
  closingText: string;
  greeting: string;
  previewText: string;
  subject: string;
  title: string;
};

type EmailPolicyView = {
  description: string;
  enabled: boolean;
  includeHrInbox: boolean;
  label: string;
  recipientMode: EmailRecipientMode;
  recipientModes: EmailRecipientMode[];
  targetLines: string[];
  targetTitles: string[];
  template: EmailTemplateContent;
  type: EmailNotificationType;
};

type EmailPreviewView = {
  html: string;
  plainText: string;
  subject: string;
};

type EmailOutboxStats = {
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
  previews: Record<EmailNotificationType, EmailPreviewView>;
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

function modeLabel(mode: EmailRecipientMode) {
  return recipientModeOptions.find((option) => option.value === mode)?.label ?? mode.replace(/_/g, " ");
}

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
  previews,
  routingOptions,
}: EmailNotificationCenterProps) {
  const [policies, setPolicies] = useState(initialPolicies);
  const [emailPreviews, setEmailPreviews] = useState(previews);
  const [activeType, setActiveType] = useState<EmailNotificationType>(initialPolicies[0]?.type ?? "probation");
  const [savingType, setSavingType] = useState<EmailNotificationType | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const activePolicy = policies.find((policy) => policy.type === activeType) ?? policies[0];

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

  function updateTemplate(type: EmailNotificationType, patch: Partial<EmailTemplateContent>) {
    setPolicies((current) =>
      current.map((policy) =>
        policy.type === type ? { ...policy, template: { ...policy.template, ...patch } } : policy,
      ),
    );
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
          template: policy.template,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PATCH",
      });
      const payload = (await response.json().catch(() => null)) as {
        message?: string;
        policy?: EmailPolicyView;
        preview?: EmailPreviewView;
      } | null;

      if (!response.ok) {
        throw new Error(payload?.message ?? "Failed to save notification policy.");
      }

      if (payload?.policy) updatePolicy(policy.type, payload.policy);
      if (payload?.preview) {
        setEmailPreviews((current) => ({ ...current, [policy.type]: payload.preview as EmailPreviewView }));
      }
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
            <AdminInsightChip tone="orange">Approved HR workflows only</AdminInsightChip>
            <AdminInsightChip>Manager hierarchy routing</AdminInsightChip>
            <AdminInsightChip tone="slate">Live email previews</AdminInsightChip>
          </div>
        }
        description="Control which Phoenix emails are allowed to hit Resend, preview every HR workflow template, and route recipients by business logic instead of hard-coded names."
        eyebrow="Email Governance"
        icon={<Mail className="h-3.5 w-3.5" />}
        title="Email Notification Center"
      />

      <div className="grid gap-4 md:grid-cols-4">
        <AdminStatCard
          description="Typed workflow emails in the latest outbox sample."
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Allowed"
          value={outboxStats.recentAllowed}
        />
        <AdminStatCard
          description="Queued emails waiting for retry or processing."
          icon={<BellRing className="h-5 w-5" />}
          label="Pending"
          value={outboxStats.pending}
        />
        <AdminStatCard
          description="Successfully accepted by the provider."
          icon={<Check className="h-5 w-5" />}
          label="Sent"
          value={outboxStats.sent}
        />
        <AdminStatCard
          description={formatDateTime(outboxStats.lastSentAt)}
          icon={<Route className="h-5 w-5" />}
          label="Last Send"
          value={outboxStats.recentTotal}
        />
      </div>

      {message ? (
        <div className="rounded-[16px] border border-[#FED7AA] bg-[#FFF7ED] px-4 py-3 text-sm font-bold text-[#9A3412]">
          {message}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(420px,0.9fr)_minmax(540px,1.1fr)]">
        <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
          <AdminSectionHeader
            description="Enable only the workflow emails you want and select recipient logic for each type."
            title="Routing Policies"
          />
          <div className="divide-y divide-[#E2E8F0]">
            {policies.map((policy) => (
              <div
                className={cn(
                  "space-y-4 p-4 transition",
                  activeType === policy.type ? "bg-[#FFF7ED]/45" : "bg-white",
                )}
                key={policy.type}
              >
                <button
                  className="flex w-full items-start justify-between gap-3 text-left"
                  onClick={() => setActiveType(policy.type)}
                  type="button"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-base font-black text-[#0F172A]">{policy.label}</span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em]",
                          policy.enabled
                            ? "bg-[#DCFCE7] text-[#166534]"
                            : "bg-[#F1F5F9] text-[#64748B]",
                        )}
                      >
                        {policy.enabled ? "Enabled" : "Paused"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-6 text-[#64748B]">{policy.description}</p>
                  </div>
                  <Eye className="mt-1 h-4 w-4 text-[#F97316]" />
                </button>

                <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-start">
                  <div>
                    <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                      Recipient logic
                    </span>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {recipientModeOptions.map((option) => (
                        <label
                          className={cn(
                            "flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm transition",
                            policy.recipientModes.includes(option.value)
                              ? "border-[#FDBA74] bg-[#FFF7ED] text-[#9A3412]"
                              : "border-[#E2E8F0] bg-white text-[#0F172A]",
                          )}
                          key={option.value}
                        >
                          <input
                            checked={policy.recipientModes.includes(option.value)}
                            className="mt-1 h-4 w-4 accent-[#F97316]"
                            onChange={(event) => toggleMode(policy, option.value, event.target.checked)}
                            type="checkbox"
                          />
                          <span>
                            <span className="block font-black">{option.label}</span>
                            <span className="block text-xs font-semibold leading-5 text-[#64748B]">
                              {option.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <Button
                    className="h-11 rounded-xl bg-[#F97316] px-4 text-white hover:bg-[#EA580C]"
                    disabled={savingType === policy.type}
                    onClick={() => void savePolicy(policy)}
                  >
                    {savingType === policy.type ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Save
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-sm font-bold text-[#0F172A]">
                    <input
                      checked={policy.enabled}
                      className="h-4 w-4 accent-[#F97316]"
                      onChange={(event) => updatePolicy(policy.type, { enabled: event.target.checked })}
                      type="checkbox"
                    />
                    Allow Resend delivery
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm font-bold text-[#0F172A]">
                    <input
                      checked={policy.includeHrInbox}
                      className="h-4 w-4 accent-[#F97316]"
                      onChange={(event) => updatePolicy(policy.type, { includeHrInbox: event.target.checked })}
                      type="checkbox"
                    />
                    Copy HR inbox
                  </label>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-[16px] border border-[#E2E8F0] bg-[#F8FAFC] p-3">
                    <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                      Company titles
                    </p>
                    <div className="mt-3 max-h-44 space-y-2 overflow-auto pr-1">
                      {routingOptions.titles.length ? routingOptions.titles.map((title) => (
                        <label className="flex items-center gap-2 text-sm font-bold text-[#0F172A]" key={title}>
                          <input
                            checked={policy.targetTitles.includes(title)}
                            className="h-4 w-4 accent-[#F97316]"
                            onChange={(event) => toggleTextValue(policy, "targetTitles", title, event.target.checked)}
                            type="checkbox"
                          />
                          {title}
                        </label>
                      )) : (
                        <p className="text-xs font-bold text-[#64748B]">No employee titles found yet.</p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[16px] border border-[#E2E8F0] bg-[#F8FAFC] p-3">
                    <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                      Lines
                    </p>
                    <div className="mt-3 max-h-44 space-y-2 overflow-auto pr-1">
                      {routingOptions.lines.length ? routingOptions.lines.map((line) => (
                        <label className="flex items-center gap-2 text-sm font-bold text-[#0F172A]" key={line}>
                          <input
                            checked={policy.targetLines.includes(line)}
                            className="h-4 w-4 accent-[#F97316]"
                            onChange={(event) => toggleTextValue(policy, "targetLines", line, event.target.checked)}
                            type="checkbox"
                          />
                          {line}
                        </label>
                      )) : (
                        <p className="text-xs font-bold text-[#64748B]">No company lines found yet.</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-[16px] border border-[#E2E8F0] bg-white p-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                    Editable template
                  </p>
                  <div className="mt-3 grid gap-3">
                    <input
                      className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(policy.type, { subject: event.target.value })}
                      placeholder="Subject"
                      value={policy.template.subject}
                    />
                    <input
                      className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(policy.type, { title: event.target.value })}
                      placeholder="Email title"
                      value={policy.template.title}
                    />
                    <input
                      className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(policy.type, { greeting: event.target.value })}
                      placeholder="Greeting"
                      value={policy.template.greeting}
                    />
                    <textarea
                      className="min-h-28 rounded-xl border border-[#D8E0EA] px-3 py-2 text-sm font-semibold leading-6 text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(policy.type, { bodyText: event.target.value })}
                      placeholder="Body text"
                      value={policy.template.bodyText}
                    />
                    <input
                      className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(policy.type, { closingText: event.target.value })}
                      placeholder="Closing text"
                      value={policy.template.closingText}
                    />
                    <input
                      className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(policy.type, { previewText: event.target.value })}
                      placeholder="Inbox preview text"
                      value={policy.template.previewText}
                    />
                    <p className="text-xs font-bold leading-5 text-[#64748B]">
                      Supported variables: {"{subject}"}, {"{title}"}, {"{summary}"}, {"{employee}"}, {"{status}"}, {"{date}"}, {"{ctaLabel}"}, {"{ctaUrl}"}, and any metric label.
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
          <AdminSectionHeader
            description={
              activePolicy
                ? `Previewing ${activePolicy.label}. Routes: ${activePolicy.recipientModes.map(modeLabel).join(", ")}.`
                : "Previewing Phoenix email output."
            }
            title="Live Email Preview"
          />
          <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-5 py-4">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Subject</p>
            <p className="mt-1 text-sm font-black text-[#0F172A]">{emailPreviews[activeType]?.subject}</p>
          </div>
          <div className="bg-[#EEF2F7] p-4">
            <iframe
              className="h-[640px] w-full rounded-[18px] border border-[#CBD5E1] bg-white shadow-[0_18px_42px_rgba(15,23,42,0.10)]"
              sandbox="allow-same-origin"
              srcDoc={emailPreviews[activeType]?.html ?? ""}
              title={`${activeType} email preview`}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
