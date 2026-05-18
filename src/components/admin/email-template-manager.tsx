"use client";

import { AlertTriangle, Check, Eye, Mail, Save, Send, Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState, useTransition } from "react";

import {
  AdminCallout,
  AdminPageHero,
  adminPanelClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { EmailTemplateRecipientRole, EmailTemplateRow } from "@/lib/email-templates/service";
import { cn } from "@/lib/utils";

type RoutingOptions = {
  lines: string[];
  recipientRoles: Array<{ label: string; value: EmailTemplateRecipientRole }>;
  titles: string[];
};

type PreviewState = {
  html: string;
  previewText: string;
  subject: string;
  text: string;
};

type ValidationIssue = {
  field: string;
  message: string;
  token?: string;
  type: "email" | "placeholder" | "required";
};

type Props = {
  initialPlaceholderHints: string[];
  initialRoutingOptions: RoutingOptions;
  initialTemplates: EmailTemplateRow[];
};

const recipientGroups = [
  { key: "toRoles", label: "TO" },
  { key: "ccRoles", label: "CC" },
  { key: "bccRoles", label: "BCC" },
] as const;

const roleLabels: Record<EmailTemplateRecipientRole, string> = {
  admin: "Admin",
  all_lines_selected_titles: "All Lines Selected Titles",
  candidate: "Candidate",
  ceo: "CEO",
  direct_manager: "Direct Manager",
  district_manager: "District Manager",
  employee: "Employee",
  finance: "Finance",
  hiring_manager: "Hiring Manager",
  hr: "HR",
  hr_manager: "HR Manager",
  line_manager: "Line Manager",
  manager_chain: "Full Manager Chain",
  manager_of_manager: "Manager of Manager",
  national_sales_manager: "National Sales Manager",
  recruiter: "Recruiter",
  regional_sales_manager: "Regional Sales Manager",
  same_line_selected_titles: "Same Line Selected Titles",
  selected_lines_selected_titles: "Selected Lines + Selected Titles",
};

function cloneTemplate(template: EmailTemplateRow): EmailTemplateRow {
  return {
    ...template,
    rules: {
      bccRoles: [...template.rules.bccRoles],
      bccStaticEmails: [...template.rules.bccStaticEmails],
      ccRoles: [...template.rules.ccRoles],
      ccStaticEmails: [...template.rules.ccStaticEmails],
      targetLines: [...template.rules.targetLines],
      targetTitles: [...template.rules.targetTitles],
      toRoles: [...template.rules.toRoles],
      toStaticEmails: [...template.rules.toStaticEmails],
    },
  };
}

function emailText(values: string[]) {
  return values.join("\n");
}

function parseLines(value: string) {
  return Array.from(new Set(value.split(/[\n,;]/).map((item) => item.trim()).filter(Boolean)));
}

function roleChecked(template: EmailTemplateRow, key: "toRoles" | "ccRoles" | "bccRoles", role: EmailTemplateRecipientRole) {
  return template.rules[key].includes(role);
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim().toLowerCase());
}

function extractPlaceholders(value: string) {
  const tokens = Array.from(value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)).map((match) => match[1]);
  const malformed = (value.match(/\{\{/g) ?? []).length !== (value.match(/\}\}/g) ?? []).length;
  return { malformed, tokens };
}

function validateDraft(template: EmailTemplateRow, allowedVariables: string[]) {
  const allowed = new Set(allowedVariables);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const fields: Array<[keyof Pick<EmailTemplateRow, "subject" | "greeting" | "previewText" | "bodyHtml" | "bodyText" | "closingText">, string]> = [
    ["subject", "Subject"],
    ["greeting", "Greeting"],
    ["previewText", "Preview text"],
    ["bodyHtml", "Body HTML"],
    ["bodyText", "Body text"],
    ["closingText", "Closing"],
  ];

  if (!template.subject.trim()) {
    warnings.push({
      field: "subject",
      message: "Subject is empty. Save as draft is okay, but published emails should have a subject.",
      type: "required",
    });
  }

  for (const [field, label] of fields) {
    const { malformed, tokens } = extractPlaceholders(template[field]);
    if (malformed) {
      errors.push({
        field,
        message: `${label} has an incomplete placeholder. Use {{employeeName}} format.`,
        type: "placeholder",
      });
    }
    for (const token of tokens) {
      if (!allowed.has(token)) {
        errors.push({
          field,
          message: `Unknown variable {{${token}}}.`,
          token,
          type: "placeholder",
        });
      }
    }
  }

  const emailFields: Array<[keyof Pick<EmailTemplateRow["rules"], "toStaticEmails" | "ccStaticEmails" | "bccStaticEmails">, string]> = [
    ["toStaticEmails", "Static TO emails"],
    ["ccStaticEmails", "Static CC emails"],
    ["bccStaticEmails", "Static BCC emails"],
  ];
  for (const [field, label] of emailFields) {
    for (const email of template.rules[field]) {
      if (email.trim() && !validEmail(email)) {
        errors.push({
          field: `rules.${field}`,
          message: `${label} contains an invalid email: ${email}.`,
          type: "email",
        });
      }
    }
  }

  return { errors, warnings };
}

export function EmailTemplateManager({
  initialPlaceholderHints,
  initialRoutingOptions,
  initialTemplates,
}: Props) {
  const [templates, setTemplates] = useState(initialTemplates);
  const firstTemplate = initialTemplates[0];
  const [selectedKey, setSelectedKey] = useState(firstTemplate?.templateKey ?? "offer");
  const [draft, setDraft] = useState(() => firstTemplate ? cloneTemplate(firstTemplate) : null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [isPending, startTransition] = useTransition();

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.templateKey === selectedKey) ?? templates[0],
    [selectedKey, templates],
  );
  const validation = useMemo(
    () => draft ? validateDraft(draft, initialPlaceholderHints) : { errors: [], warnings: [] },
    [draft, initialPlaceholderHints],
  );
  const hasValidationErrors = validation.errors.length > 0;

  function fieldIssues(field: string) {
    return [...validation.errors, ...validation.warnings].filter((issue) => issue.field === field);
  }

  function templatePayload(template: EmailTemplateRow) {
    return {
      bodyHtml: template.bodyHtml,
      bodyText: template.bodyText,
      closingText: template.closingText,
      description: template.description,
      greeting: template.greeting,
      isActive: template.isActive,
      previewText: template.previewText,
      rules: template.rules,
      subject: template.subject,
      templateName: template.templateName,
    };
  }

  function selectTemplate(templateKey: string) {
    const next = templates.find((template) => template.templateKey === templateKey);
    if (!next) return;
    setSelectedKey(next.templateKey);
    setDraft(cloneTemplate(next));
    setPreview(null);
    setMessage(null);
    setError(null);
  }

  function updateDraft<K extends keyof EmailTemplateRow>(key: K, value: EmailTemplateRow[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  function updateRules<K extends keyof EmailTemplateRow["rules"]>(key: K, value: EmailTemplateRow["rules"][K]) {
    setDraft((current) => current ? { ...current, rules: { ...current.rules, [key]: value } } : current);
  }

  function toggleRole(key: "toRoles" | "ccRoles" | "bccRoles", role: EmailTemplateRecipientRole) {
    if (!draft) return;
    const current = draft.rules[key];
    updateRules(
      key,
      current.includes(role) ? current.filter((value) => value !== role) : [...current, role],
    );
  }

  function saveTemplate(mode: "draft" | "publish" | "current" = "current") {
    if (!draft) return;
    setError(null);
    setMessage(null);
    if (hasValidationErrors) {
      setError("Fix the highlighted template issues before saving.");
      return;
    }
    const nextDraft = mode === "current" ? draft : { ...draft, isActive: mode === "publish" };
    startTransition(async () => {
      const response = await fetch(`/api/admin/email-templates/${encodeURIComponent(draft.templateKey)}`, {
        body: JSON.stringify(templatePayload(nextDraft)),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? payload?.issues?.[0]?.message ?? "Email template save failed.");
        return;
      }
      const saved = payload.template as EmailTemplateRow;
      setTemplates((current) => current.map((template) => template.templateKey === saved.templateKey ? saved : template));
      setDraft(cloneTemplate(saved));
      setMessage(mode === "draft" ? "Draft saved as inactive." : "Template saved. Future emails of this type will use these settings.");
    });
  }

  function refreshPreview() {
    if (!draft) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/admin/email-templates/preview", {
          body: JSON.stringify({
            context: {
              area: "Cairo",
              candidateName: "Ahmed Hassan",
              ctaLabel: "Open in Phoenix Workforce",
              ctaUrl: "https://phoenix.example.com/action",
              employeeHrId: "PHX-1024",
              employeeName: "Mariam Adel",
              jobTitle: "Medical Rep",
              line: "Cardio Line",
              managerName: "Omar Nabil",
              recipientName: "Ahmed",
              startDate: "2026-06-01",
              endDate: "2026-06-05",
              status: "Pending manager approval",
              subject: "Phoenix Workforce notification",
              summary: "This is a sample HR notification generated from the saved template structure.",
              vacationType: "Annual Leave",
            },
            template: templatePayload(draft),
            templateKey: draft.templateKey,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setError(payload?.message ?? "Email template preview failed.");
          return;
        }
        setPreview(payload.preview as PreviewState);
      } catch {
        setError("Preview failed to render. Your edits are still safe.");
      }
    });
  }

  function sendTestEmail() {
    if (!draft) return;
    setError(null);
    setMessage(null);
    if (hasValidationErrors) {
      setError("Fix the highlighted template issues before sending a test.");
      return;
    }
    if (!validEmail(testEmail)) {
      setError("Enter a valid test email address.");
      return;
    }
    startTransition(async () => {
      try {
        const response = await fetch("/api/admin/email-templates/test", {
          body: JSON.stringify({
            template: templatePayload(draft),
            templateKey: draft.templateKey,
            to: testEmail,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setError(payload?.message ?? payload?.issues?.[0]?.message ?? "Test email failed.");
          return;
        }
        setMessage(payload.result?.skipped ? `Test email skipped: ${payload.result.reason}` : `Test email sent to ${testEmail}.`);
      } catch {
        setError("Test email failed safely. Check email configuration and try again.");
      }
    });
  }

  if (!draft || !selectedTemplate) {
    return (
      <div className="min-h-screen bg-[#F3F6FA] p-6">
        <AdminCallout tone="warning">Email templates are not available. Run the email template migration and refresh.</AdminCallout>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-[#F3F6FA] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <AdminPageHero
          description="Manage the single source of truth for Phoenix Workforce system emails, default recipients, and safe template variables."
          eyebrow="Admin Communication"
          icon={<Mail className="h-3.5 w-3.5" />}
          title="Email Templates"
          actions={
            <>
              <Button
                className="gap-2 rounded-xl border border-[#CBD5E1] bg-white px-4 py-2.5 font-black text-[#0F172A] hover:bg-[#F8FAFC]"
                onClick={refreshPreview}
                type="button"
                variant="secondary"
              >
                <Eye className="h-4 w-4" />
                Preview
              </Button>
              <Button
                className="gap-2 rounded-xl bg-[#F97316] px-4 py-2.5 font-black text-white hover:bg-[#EA580C]"
                disabled={isPending || hasValidationErrors}
                onClick={() => saveTemplate("publish")}
                type="button"
              >
                <Save className="h-4 w-4" />
                Publish
              </Button>
            </>
          }
        />

        {message ? (
          <AdminCallout tone="success">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{message}</span>
          </AdminCallout>
        ) : null}
        {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
        {(validation.errors.length > 0 || validation.warnings.length > 0) ? (
          <AdminCallout tone={validation.errors.length > 0 ? "danger" : "warning"}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              {[...validation.errors, ...validation.warnings].slice(0, 4).map((issue) => (
                <p key={`${issue.field}-${issue.message}`}>{issue.message}</p>
              ))}
            </div>
          </AdminCallout>
        ) : null}

        <div className="sticky top-3 z-20 rounded-2xl border border-[#D8E0EA] bg-white/95 p-3 shadow-[0_14px_34px_rgba(15,23,42,0.12)] backdrop-blur">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">
                {draft.isActive ? "Published template" : "Draft / inactive template"}
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-[#475569]">
                {hasValidationErrors ? "Fix validation issues before saving or sending tests." : "Changes can be saved as draft or published immediately."}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                className="h-10 min-w-[240px] rounded-xl"
                onChange={(event) => setTestEmail(event.target.value)}
                placeholder="test@example.com"
                type="email"
                value={testEmail}
              />
              <Button
                className="gap-2 rounded-xl border border-[#CBD5E1] bg-white font-black text-[#0F172A] hover:bg-[#F8FAFC]"
                disabled={isPending || hasValidationErrors}
                onClick={sendTestEmail}
                type="button"
                variant="secondary"
              >
                <Send className="h-4 w-4" />
                Send Test
              </Button>
              <Button
                className="gap-2 rounded-xl border border-[#CBD5E1] bg-white font-black text-[#0F172A] hover:bg-[#F8FAFC]"
                disabled={isPending || hasValidationErrors}
                onClick={() => saveTemplate("draft")}
                type="button"
                variant="secondary"
              >
                Save Draft
              </Button>
              <Button
                className="gap-2 rounded-xl bg-[#F97316] font-black text-white hover:bg-[#EA580C]"
                disabled={isPending || hasValidationErrors}
                onClick={() => saveTemplate("publish")}
                type="button"
              >
                Publish
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(460px,0.95fr)]">
          <section className="space-y-5">
            <Card className={cn(adminPanelClassName, "p-5")}>
              <label className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]" htmlFor="email-template-select">
                Select Email Template
              </label>
              <select
                className="mt-2 h-11 w-full rounded-xl border border-[#CBD5E1] bg-white px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20"
                id="email-template-select"
                onChange={(event) => selectTemplate(event.target.value)}
                value={selectedKey}
              >
                {templates.map((template) => (
                  <option key={template.templateKey} value={template.templateKey}>
                    {template.templateName}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-sm leading-6 text-[#64748B]">{draft.description}</p>
            </Card>

            <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Template Editor</p>
                  <h2 className="mt-1 text-lg font-black tracking-[-0.02em] text-[#0F172A]">{draft.templateName}</h2>
                </div>
                <div className="flex items-center gap-3 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
                  <span className="text-xs font-bold text-[#475569]">{draft.isActive ? "Active" : "Inactive"}</span>
                  <Switch checked={draft.isActive} label="Template active status" onChange={(checked) => updateDraft("isActive", checked)} />
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Email name">
                  <Input value={draft.templateName} onChange={(event) => updateDraft("templateName", event.target.value)} />
                </Field>
                <Field issues={fieldIssues("subject")} label="Subject">
                  <Input value={draft.subject} onChange={(event) => updateDraft("subject", event.target.value)} />
                </Field>
              </div>
              <Field issues={fieldIssues("greeting")} label="Greeting">
                <Input value={draft.greeting} onChange={(event) => updateDraft("greeting", event.target.value)} />
              </Field>
              <Field issues={fieldIssues("previewText")} label="Preview text">
                <Input value={draft.previewText} onChange={(event) => updateDraft("previewText", event.target.value)} />
              </Field>
              <Field issues={fieldIssues("bodyHtml")} label="Body HTML">
                <textarea
                  className="min-h-[180px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-3 font-mono text-sm leading-6 text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20"
                  value={draft.bodyHtml}
                  onChange={(event) => updateDraft("bodyHtml", event.target.value)}
                />
              </Field>
              <Field issues={fieldIssues("bodyText")} label="Body text fallback">
                <textarea
                  className="min-h-[110px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-3 text-sm leading-6 text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20"
                  value={draft.bodyText}
                  onChange={(event) => updateDraft("bodyText", event.target.value)}
                />
              </Field>
              <Field issues={fieldIssues("closingText")} label="Closing">
                <Input value={draft.closingText} onChange={(event) => updateDraft("closingText", event.target.value)} />
              </Field>
            </Card>

            <Card className={cn(adminPanelClassName, "space-y-5 p-5")}>
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-[#F97316]" />
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Recipient Rules</p>
                  <p className="mt-1 text-sm text-[#64748B]">Select default TO, CC, and BCC recipients for this email type.</p>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                {recipientGroups.map((group) => (
                  <div className={cn(adminSoftPanelClassName, "p-4")} key={group.key}>
                    <p className="text-sm font-black text-[#0F172A]">{group.label}</p>
                    <div className="mt-3 space-y-2">
                      {initialRoutingOptions.recipientRoles.map(({ label, value: role }) => (
                        <label className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm text-[#334155] hover:bg-[#FFF7ED]" key={`${group.key}-${role}`}>
                          <input
                            checked={roleChecked(draft, group.key, role)}
                            className="mt-1 h-4 w-4 rounded border-[#CBD5E1] accent-[#F97316]"
                            onChange={() => toggleRole(group.key, role)}
                            type="checkbox"
                          />
                          <span className="leading-5">{roleLabels[role] ?? label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 lg:grid-cols-3">
                <Field issues={fieldIssues("rules.toStaticEmails")} label="Static TO emails">
                  <textarea
                    className="min-h-[88px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-2 text-sm leading-6 text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20"
                    value={emailText(draft.rules.toStaticEmails)}
                    onChange={(event) => updateRules("toStaticEmails", parseLines(event.target.value))}
                  />
                </Field>
                <Field issues={fieldIssues("rules.ccStaticEmails")} label="Static CC emails">
                  <textarea
                    className="min-h-[88px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-2 text-sm leading-6 text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20"
                    value={emailText(draft.rules.ccStaticEmails)}
                    onChange={(event) => updateRules("ccStaticEmails", parseLines(event.target.value))}
                  />
                </Field>
                <Field issues={fieldIssues("rules.bccStaticEmails")} label="Static BCC emails">
                  <textarea
                    className="min-h-[88px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-2 text-sm leading-6 text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20"
                    value={emailText(draft.rules.bccStaticEmails)}
                    onChange={(event) => updateRules("bccStaticEmails", parseLines(event.target.value))}
                  />
                </Field>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Selected lines">
                  <select
                    className="min-h-[112px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-2 text-sm text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20"
                    multiple
                    onChange={(event) => updateRules("targetLines", Array.from(event.currentTarget.selectedOptions).map((option) => option.value))}
                    value={draft.rules.targetLines}
                  >
                    {initialRoutingOptions.lines.map((line) => <option key={line} value={line}>{line}</option>)}
                  </select>
                </Field>
                <Field label="Selected titles">
                  <select
                    className="min-h-[112px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-2 text-sm text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20"
                    multiple
                    onChange={(event) => updateRules("targetTitles", Array.from(event.currentTarget.selectedOptions).map((option) => option.value))}
                    value={draft.rules.targetTitles}
                  >
                    {initialRoutingOptions.titles.map((title) => <option key={title} value={title}>{title}</option>)}
                  </select>
                </Field>
              </div>
            </Card>
          </section>

          <aside className="space-y-5 xl:sticky xl:top-5 xl:self-start">
            <Card className={cn(adminPanelClassName, "p-5")}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Live Preview</p>
                  <h2 className="mt-1 text-lg font-black text-[#0F172A]">{preview?.subject ?? draft.subject}</h2>
                </div>
                <Button className="gap-2 rounded-xl bg-[#0F172A] font-black text-white hover:bg-[#1E293B]" onClick={refreshPreview} type="button">
                  <Send className="h-4 w-4" />
                  Render
                </Button>
              </div>
              <div className="mt-4 overflow-hidden rounded-xl border border-[#CBD5E1] bg-white">
                {preview?.html ? (
                  <iframe
                    className="h-[650px] w-full bg-white"
                    sandbox=""
                    srcDoc={preview.html}
                    title="Email template preview"
                  />
                ) : (
                  <div className="flex h-[650px] items-center justify-center px-6 text-center text-sm leading-6 text-[#64748B]">
                    Render a preview to inspect the final email layout.
                  </div>
                )}
              </div>
            </Card>

            <Card className={cn(adminPanelClassName, "p-5")}>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Available Variables</p>
              <p className="mt-2 text-sm leading-6 text-[#64748B]">
                Use these exact placeholders. Unknown variables are blocked before save.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {initialPlaceholderHints.map((hint) => (
                  <code className="rounded-lg border border-[#FED7AA] bg-[#FFF7ED] px-2.5 py-1.5 text-xs font-bold text-[#C2410C]" key={hint}>
                    {"{{"}{hint}{"}}"}
                  </code>
                ))}
              </div>
            </Card>
          </aside>
        </div>
      </div>
    </main>
  );
}

function Field({ children, issues = [], label }: { children: ReactNode; issues?: ValidationIssue[]; label: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">{label}</span>
      {children}
      {issues.length > 0 ? (
        <div className="mt-1.5 space-y-1">
          {issues.map((issue) => (
            <p
              className={cn(
                "text-xs font-semibold leading-5",
                issue.type === "required" ? "text-[#B45309]" : "text-[#BE123C]",
              )}
              key={`${issue.field}-${issue.message}`}
            >
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}
    </label>
  );
}
