"use client";

import { useMemo, useState } from "react";
import {
  BellRing,
  Check,
  ChevronDown,
  Eye,
  Loader2,
  Mail,
  Route,
  Save,
  ShieldCheck,
} from "lucide-react";

import {
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  AdminStatCard,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  renderGeneralNotificationEmailHtml,
  renderGeneralNotificationEmailText,
} from "@/emails/general-notification";
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

type PreviewSample = {
  candidateEmail?: string;
  ctaHref?: string;
  ctaLabel?: string;
  employeeHrId?: string;
  metrics?: Array<{ label: string; value: string }>;
  subject: string;
  summary: string;
  title: string;
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

const previewSamples: Record<EmailNotificationType, PreviewSample> = {
  birthday: {
    employeeHrId: "B-001",
    metrics: [
      { label: "Employee", value: "Mariam Nabil" },
      { label: "Birthday", value: "Today" },
      { label: "Routing", value: "Employee" },
    ],
    subject: "Happy Birthday, Mariam Nabil",
    summary: "Happy birthday wishes for Mariam Nabil.",
    title: "Happy Birthday",
  },
  contract_renewal: {
    employeeHrId: "B-001",
    metrics: [
      { label: "Employee", value: "Mariam Nabil (B-001)" },
      { label: "Status", value: "Pending Manager Recommendation" },
      { label: "Renewal date", value: "2026-06-15" },
    ],
    subject: "Contract Renewal Reminder - Mariam Nabil",
    summary: "Contract renewal for Mariam Nabil is pending manager recommendation.",
    title: "Contract Renewal Reminder - Pending Manager Recommendation",
  },
  offer: {
    candidateEmail: "candidate@example.com",
    ctaHref: "/offers",
    ctaLabel: "Open offers",
    metrics: [
      { label: "Candidate", value: "Youssef Ahmed" },
      { label: "Role", value: "Medical Representative" },
      { label: "Offer ID", value: "OFF-2026-001" },
    ],
    subject: "Phoenix Offer Updated - Youssef Ahmed",
    summary: "Offer workflow for Youssef Ahmed requires HR follow-up.",
    title: "Offer Updated",
  },
  probation: {
    ctaHref: "/probation",
    ctaLabel: "Open probation tracker",
    employeeHrId: "B-001",
    metrics: [
      { label: "Employee", value: "Mariam Nabil (B-001)" },
      { label: "Status", value: "manager feedback" },
      { label: "Decision", value: "Pending" },
    ],
    subject: "Phoenix Probation Review Updated - Mariam Nabil",
    summary: "Probation review for Mariam Nabil is now manager feedback.",
    title: "Probation Review Updated",
  },
  resignation: {
    ctaHref: "/resignations",
    ctaLabel: "Open resignations",
    employeeHrId: "B-001",
    metrics: [
      { label: "Employee", value: "Mariam Nabil (B-001)" },
      { label: "Status", value: "under review" },
      { label: "Effective date", value: "2026-06-30" },
    ],
    subject: "Phoenix Resignation Workflow Updated - Mariam Nabil",
    summary: "Resignation workflow for Mariam Nabil is now under review.",
    title: "Resignation Workflow Updated",
  },
  password_reset: {
    candidateEmail: "employee@example.com",
    ctaHref: "/password-setup/example",
    ctaLabel: "Reset password",
    metrics: [
      { label: "Login ID", value: "B-001" },
      { label: "Expires", value: "15 minutes" },
    ],
    subject: "Phoenix Workforce password reset",
    summary: "Use this one-time link to reset your Phoenix Workforce password.",
    title: "Reset your Phoenix Workforce password",
  },
  user_created: {
    candidateEmail: "employee@example.com",
    ctaHref: "/password-setup/example",
    ctaLabel: "Set password",
    metrics: [
      { label: "Login ID", value: "B-001" },
      { label: "Expires", value: "15 minutes" },
    ],
    subject: "Phoenix Workforce account setup",
    summary: "Use this one-time link to create your Phoenix Workforce password.",
    title: "Create your Phoenix Workforce password",
  },
  general: {
    ctaHref: "/overview",
    ctaLabel: "Open Phoenix Workforce",
    metrics: [{ label: "Source", value: "Phoenix Workforce" }],
    subject: "Phoenix Workforce notification",
    summary: "General Phoenix Workforce notification requiring your attention.",
    title: "Phoenix Workforce Notification",
  },
};

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

function templateToken(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function templateValue(sample: PreviewSample, value: string) {
  const metricVariables = Object.fromEntries(
    (sample.metrics ?? []).map((metric) => [templateToken(metric.label), String(metric.value)]),
  );
  const variables: Record<string, string> = {
    candidate: sample.candidateEmail ?? "",
    ctaLabel: sample.ctaLabel ?? "Open dashboard",
    ctaUrl: sample.ctaHref ?? "",
    ctalabel: sample.ctaLabel ?? "Open dashboard",
    ctaurl: sample.ctaHref ?? "",
    date: metricVariables.date ?? metricVariables.birthday ?? metricVariables.effectivedate ?? "",
    employee: metricVariables.employee ?? sample.employeeHrId ?? "",
    employeehrid: sample.employeeHrId ?? "",
    status: metricVariables.status ?? "",
    subject: sample.subject,
    summary: sample.summary,
    title: sample.title,
    ...metricVariables,
  };

  return value.replace(/\{([^}]+)\}/g, (_match, key: string) => variables[templateToken(key)] ?? "");
}

function buildLiveEmailPreview(policy: EmailPolicyView): EmailPreviewView {
  const sample = previewSamples[policy.type];
  const template = {
    bodyText: templateValue(sample, policy.template.bodyText || "{summary}"),
    closingText: templateValue(sample, policy.template.closingText || "Please review this update."),
    greeting: templateValue(sample, policy.template.greeting || "Dear Phoenix Team,"),
    previewText: templateValue(sample, policy.template.previewText || sample.summary),
    subject: templateValue(sample, policy.template.subject || "{subject}"),
    title: templateValue(sample, policy.template.title || "{title}"),
  };
  const action = sample.ctaHref
    ? { href: sample.ctaHref, label: sample.ctaLabel ?? "Open dashboard" }
    : undefined;

  return {
    html: renderGeneralNotificationEmailHtml({
      action,
      bodyText: template.bodyText,
      closingText: template.closingText,
      greeting: template.greeting,
      metadataRows: sample.metrics,
      previewText: template.previewText,
      signatureName: "Phoenix HR Team",
      subject: template.subject,
      summary: template.bodyText,
      title: template.title,
    }),
    plainText: renderGeneralNotificationEmailText({
      action,
      bodyText: template.bodyText,
      closingText: template.closingText,
      greeting: template.greeting,
      metadataRows: sample.metrics,
      previewText: template.previewText,
      signatureName: "Phoenix HR Team",
      subject: template.subject,
      summary: template.bodyText,
      title: template.title,
    }),
    subject: template.subject,
  };
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
  const activePolicy = policies.find((policy) => policy.type === activeType) ?? policies[0] ?? null;
  const activePreview = useMemo(
    () => activePolicy ? buildLiveEmailPreview(activePolicy) : emailPreviews[activeType],
    [activePolicy, activeType, emailPreviews],
  );

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
      setMessage(`${policy.label} email notification saved.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save notification policy.");
    } finally {
      setSavingType(null);
    }
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip tone="orange">Approved HR workflows only</AdminInsightChip>
            <AdminInsightChip>Manager hierarchy routing</AdminInsightChip>
            <AdminInsightChip tone="slate">Live email previews</AdminInsightChip>
          </div>
        }
        description="Choose one email notification, edit its routing and content, and review the exact email preview while you work."
        eyebrow="Email Governance"
        icon={<Mail className="h-3.5 w-3.5" />}
        title="Email Notification Center"
      />

      <div className="grid gap-3 md:grid-cols-4">
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

      <Card className={cn(adminPanelClassName, "p-4")}>
        <div className="grid gap-4 lg:grid-cols-[minmax(280px,420px)_1fr] lg:items-end">
          <label className="block">
            <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">
              Email notification
            </span>
            <span className="relative block">
              <select
                className="h-12 w-full appearance-none rounded-2xl border border-[#D8E0EA] bg-white px-4 pr-10 text-sm font-black text-[#0F172A] shadow-[0_10px_24px_rgba(15,23,42,0.05)] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                onChange={(event) => setActiveType(event.target.value as EmailNotificationType)}
                value={activeType}
              >
                {policies.map((policy) => (
                  <option key={policy.type} value={policy.type}>
                    {policy.label} - {policy.enabled ? "Enabled" : "Paused"}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#F97316]" />
            </span>
          </label>
          {activePolicy ? (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-full px-3 py-2 text-xs font-black uppercase tracking-[0.14em]",
                  activePolicy.enabled
                    ? "bg-[#DCFCE7] text-[#166534]"
                    : "bg-[#F1F5F9] text-[#64748B]",
                )}
              >
                {activePolicy.enabled ? "Delivery enabled" : "Delivery paused"}
              </span>
              <span className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-bold text-[#475569]">
                {activePolicy.recipientModes.map(modeLabel).join(", ")}
              </span>
              {activePolicy.includeHrInbox ? (
                <span className="rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-xs font-bold text-[#9A3412]">
                  HR inbox copied
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      {activePolicy ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(430px,0.95fr)_minmax(520px,1.05fr)]">
          <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
            <AdminSectionHeader
              description={activePolicy.description}
              title={`${activePolicy.label} settings`}
            />
            <div className="space-y-4 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-[#E2E8F0] bg-[#F8FAFC] p-3">
                <div className="flex flex-wrap items-center gap-4">
                  <label className="inline-flex items-center gap-2 text-sm font-bold text-[#0F172A]">
                    <input
                      checked={activePolicy.enabled}
                      className="h-4 w-4 accent-[#F97316]"
                      onChange={(event) => updatePolicy(activePolicy.type, { enabled: event.target.checked })}
                      type="checkbox"
                    />
                    Allow Resend delivery
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm font-bold text-[#0F172A]">
                    <input
                      checked={activePolicy.includeHrInbox}
                      className="h-4 w-4 accent-[#F97316]"
                      onChange={(event) => updatePolicy(activePolicy.type, { includeHrInbox: event.target.checked })}
                      type="checkbox"
                    />
                    Copy HR inbox
                  </label>
                </div>
                <Button
                  className="h-10 rounded-xl bg-[#F97316] px-4 text-white hover:bg-[#EA580C]"
                  disabled={savingType === activePolicy.type}
                  onClick={() => void savePolicy(activePolicy)}
                >
                  {savingType === activePolicy.type ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save
                </Button>
              </div>

              <section className="rounded-[18px] border border-[#E2E8F0] bg-white p-3">
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                  Recipient logic
                </p>
                <div className="mt-3 grid max-h-64 gap-2 overflow-auto pr-1 sm:grid-cols-2">
                  {recipientModeOptions.map((option) => (
                    <label
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm transition",
                        activePolicy.recipientModes.includes(option.value)
                          ? "border-[#FDBA74] bg-[#FFF7ED] text-[#9A3412]"
                          : "border-[#E2E8F0] bg-white text-[#0F172A]",
                      )}
                      key={option.value}
                    >
                      <input
                        checked={activePolicy.recipientModes.includes(option.value)}
                        className="mt-1 h-4 w-4 accent-[#F97316]"
                        onChange={(event) => toggleMode(activePolicy, option.value, event.target.checked)}
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
              </section>

              <details className="rounded-[18px] border border-[#E2E8F0] bg-[#F8FAFC] p-3">
                <summary className="cursor-pointer list-none text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                  Advanced targeting
                </summary>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div className="rounded-[16px] border border-[#E2E8F0] bg-white p-3">
                    <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                      Company titles
                    </p>
                    <div className="mt-3 max-h-44 space-y-2 overflow-auto pr-1">
                      {routingOptions.titles.length ? routingOptions.titles.map((title) => (
                        <label className="flex items-center gap-2 text-sm font-bold text-[#0F172A]" key={title}>
                          <input
                            checked={activePolicy.targetTitles.includes(title)}
                            className="h-4 w-4 accent-[#F97316]"
                            onChange={(event) => toggleTextValue(activePolicy, "targetTitles", title, event.target.checked)}
                            type="checkbox"
                          />
                          {title}
                        </label>
                      )) : (
                        <p className="text-xs font-bold text-[#64748B]">No employee titles found yet.</p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-[16px] border border-[#E2E8F0] bg-white p-3">
                    <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                      Lines
                    </p>
                    <div className="mt-3 max-h-44 space-y-2 overflow-auto pr-1">
                      {routingOptions.lines.length ? routingOptions.lines.map((line) => (
                        <label className="flex items-center gap-2 text-sm font-bold text-[#0F172A]" key={line}>
                          <input
                            checked={activePolicy.targetLines.includes(line)}
                            className="h-4 w-4 accent-[#F97316]"
                            onChange={(event) => toggleTextValue(activePolicy, "targetLines", line, event.target.checked)}
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
              </details>

              <section className="rounded-[18px] border border-[#E2E8F0] bg-white p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                    Editable template
                  </p>
                  <span className="text-xs font-bold text-[#64748B]">Preview updates live</span>
                </div>
                <div className="mt-3 grid gap-3">
                  <input
                    className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                    onChange={(event) => updateTemplate(activePolicy.type, { subject: event.target.value })}
                    placeholder="Subject"
                    value={activePolicy.template.subject}
                  />
                  <div className="grid gap-3 md:grid-cols-2">
                    <input
                      className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(activePolicy.type, { title: event.target.value })}
                      placeholder="Email title"
                      value={activePolicy.template.title}
                    />
                    <input
                      className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(activePolicy.type, { greeting: event.target.value })}
                      placeholder="Greeting"
                      value={activePolicy.template.greeting}
                    />
                  </div>
                  <textarea
                    className="min-h-32 rounded-xl border border-[#D8E0EA] px-3 py-2 text-sm font-semibold leading-6 text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                    onChange={(event) => updateTemplate(activePolicy.type, { bodyText: event.target.value })}
                    placeholder="Body text"
                    value={activePolicy.template.bodyText}
                  />
                  <div className="grid gap-3 md:grid-cols-2">
                    <input
                      className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(activePolicy.type, { closingText: event.target.value })}
                      placeholder="Closing text"
                      value={activePolicy.template.closingText}
                    />
                    <input
                      className="h-11 rounded-xl border border-[#D8E0EA] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
                      onChange={(event) => updateTemplate(activePolicy.type, { previewText: event.target.value })}
                      placeholder="Inbox preview text"
                      value={activePolicy.template.previewText}
                    />
                  </div>
                  <p className="text-xs font-bold leading-5 text-[#64748B]">
                    Supported variables: {"{subject}"}, {"{title}"}, {"{summary}"}, {"{employee}"}, {"{status}"}, {"{date}"}, {"{ctaLabel}"}, {"{ctaUrl}"}, and any metric label.
                  </p>
                </div>
              </section>
            </div>
          </Card>

          <Card className={cn(adminPanelClassName, "overflow-hidden p-0 xl:sticky xl:top-4 xl:self-start")}>
            <AdminSectionHeader
              description={`Previewing ${activePolicy.label}. Routes: ${activePolicy.recipientModes.map(modeLabel).join(", ")}.`}
              title="Live Email Preview"
            />
            <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-5 py-4">
              <div className="flex items-start gap-3">
                <Eye className="mt-0.5 h-4 w-4 text-[#F97316]" />
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Subject</p>
                  <p className="mt-1 text-sm font-black text-[#0F172A]">{activePreview?.subject}</p>
                </div>
              </div>
            </div>
            <div className="bg-[#EEF2F7] p-4">
              <iframe
                className="h-[620px] w-full rounded-[18px] border border-[#CBD5E1] bg-white shadow-[0_18px_42px_rgba(15,23,42,0.10)]"
                sandbox="allow-same-origin"
                srcDoc={activePreview?.html ?? ""}
                title={`${activePolicy.type} email preview`}
              />
            </div>
          </Card>
        </div>
      ) : (
        <Card className={cn(adminPanelClassName, "p-5 text-sm font-bold text-[#64748B]")}>
          No email notification policies are available.
        </Card>
      )}
    </div>
  );
}
