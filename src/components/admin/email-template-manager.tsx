"use client";

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Eye,
  Mail,
  Plus,
  Save,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState, useTransition } from "react";

import { cn } from "@/lib/utils";
import type {
  EmailRecipientRole,
  EmailTemplate,
  EmailTemplateKey,
} from "@/lib/email-templates/service";
import {
  EMAIL_RECIPIENT_ROLE_LABELS,
  EMAIL_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_LABELS,
  TEMPLATE_VARIABLES,
} from "@/lib/email-templates/service";

// ---------------------------------------------------------------------------
// Recipient role groups (for organised UI)
// ---------------------------------------------------------------------------

type RoleGroup = { label: string; roles: EmailRecipientRole[] };

const RECIPIENT_ROLE_GROUPS: RoleGroup[] = [
  {
    label: "People",
    roles: ["employee", "candidate"],
  },
  {
    label: "Management Hierarchy",
    roles: ["direct_manager", "manager_manager", "manager_chain", "line_manager"],
  },
  {
    label: "HR & Administration",
    roles: ["hr", "hr_manager", "finance", "admin", "ceo"],
  },
  {
    label: "Sales Hierarchy",
    roles: ["district_manager", "regional_sales_manager", "national_sales_manager"],
  },
  {
    label: "Title & Line Based",
    roles: ["same_line_selected_titles", "all_lines_selected_titles", "selected_lines_selected_titles"],
  },
];

// ---------------------------------------------------------------------------
// Sample context for live preview
// ---------------------------------------------------------------------------

const PREVIEW_CONTEXT: Record<string, string> = {
  employeeName: "Ahmed Hassan",
  employeeHrId: "PHX-2024-001",
  candidateName: "Sara Ahmed",
  jobTitle: "Senior Medical Representative",
  managerName: "Omar Fathi",
  line: "Cairo North",
  area: "Heliopolis",
  status: "Pending Review",
  date: "May 20, 2026",
  startDate: "May 20, 2026",
  endDate: "May 27, 2026",
  ctaUrl: "#",
  ctaLabel: "View Details",
  recipientName: "Ahmed Hassan",
  subject: "(subject placeholder)",
  body: "This is a sample email body for preview purposes.",
  summary: "This is a summary of the notification for preview purposes.",
};

// ---------------------------------------------------------------------------
// Client-side safe template renderer (no JS execution)
// ---------------------------------------------------------------------------

function renderPreviewStr(template: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = PREVIEW_CONTEXT[key];
    return value !== undefined ? escapeHtml(value) : `<span style="color:#f97316;font-weight:700">{{${key}}}</span>`;
  });
}

function renderPreviewStrPlain(template: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    return PREVIEW_CONTEXT[key] ?? `{{${key}}}`;
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Build full Phoenix-branded preview HTML (client-side, no server import)
// ---------------------------------------------------------------------------

const PHOENIX_SIGNATURE_URL =
  "https://futuretalents.satopharma.com/FTP-WP/wp-content/uploads/2026/05/ChatGPT-Image-May-1-2026-09_41_55-PM-1-1.png";

function buildPreviewHtml(form: EmailTemplate): string {
  const subject = renderPreviewStrPlain(form.subject) || form.templateName;
  const greeting = form.smartGreeting
    ? `Dear ${escapeHtml(PREVIEW_CONTEXT.employeeName)},`
    : renderPreviewStr(form.greeting);
  const bodyHtml = renderPreviewStr(form.bodyHtml);
  const closing = escapeHtml(renderPreviewStrPlain(form.closing));
  const previewText = escapeHtml(renderPreviewStrPlain(form.previewText));

  return `<!doctype html><html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(subject)}</title>
<style>
body{margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif}
.outer{padding:20px 12px;background:#f1f5f9}
.shell{width:100%;max-width:620px;margin:0 auto;border-radius:18px;overflow:hidden;border:1px solid #dbe3ee;box-shadow:0 16px 40px rgba(15,23,42,.12)}
.hdr{padding:26px 28px 24px;background:linear-gradient(135deg,#070b12 0%,#0d1423 60%,#1b1008 100%)}
.hdr-label{color:#fb923c;font-size:10px;font-weight:900;letter-spacing:.22em;text-transform:uppercase;margin:0}
.hdr-title{color:#fff;font-size:22px;font-weight:900;letter-spacing:-.02em;line-height:1.22;margin:10px 0 0}
.hdr-sub{color:#dbeafe;font-size:13px;line-height:1.65;margin:10px 0 0}
.bar{margin-top:16px;height:3px;border-radius:999px;background:linear-gradient(90deg,#fb923c,#f97316,#fed7aa)}
.body{padding:24px 28px 28px;background:#fff}
.greeting{color:#0f172a;font-size:15px;line-height:1.7;margin:0 0 14px}
.body-content{color:#0f172a;font-size:15px;line-height:1.75}
.body-content p{margin:0 0 14px;color:#0f172a;font-size:15px;line-height:1.75}
.closing{color:#0f172a;font-size:15px;line-height:1.75;margin:18px 0 0}
.divider{height:1px;background:#dbe3ee;margin:20px 0 0}
.footer{padding:0 0 4px}
.footer-regards{color:#0f172a;font-size:14px;font-weight:900;line-height:1.7;margin:16px 0 0}
.footer-name{color:#0f172a;font-size:14px;font-weight:900;line-height:1.7;margin:4px 0 0}
.sig{display:block;margin:14px 0 0;width:96px;height:96px;border-radius:4px;object-fit:contain}
.inactive-banner{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:8px 12px;margin-bottom:14px;font-size:12px;color:#92400e;font-weight:700}
</style>
</head>
<body>
<div class="outer">
  ${!form.isActive ? '<div class="inactive-banner">⚠ This template is currently inactive.</div>' : ""}
  <div class="shell">
    <div class="hdr">
      <p class="hdr-label">Phoenix Workforce HR System</p>
      <h1 class="hdr-title">${escapeHtml(subject)}</h1>
      <p class="hdr-sub">Official HR communication prepared through Phoenix Workforce.</p>
      <div class="bar"></div>
    </div>
    <div class="body">
      ${greeting ? `<p class="greeting">${greeting}</p>` : ""}
      <div class="body-content">${bodyHtml || "<p style='color:#94a3b8;font-style:italic'>No body content yet.</p>"}</div>
      ${closing ? `<p class="closing">${closing}</p>` : ""}
      <div class="divider"></div>
      <div class="footer">
        <p class="footer-regards">Best regards,</p>
        <p class="footer-name">Phoenix HR Team</p>
        <img alt="Phoenix Workforce" class="sig" src="${PHOENIX_SIGNATURE_URL}" width="96" height="96"/>
      </div>
    </div>
  </div>
  ${previewText ? `<p style="text-align:center;font-size:11px;color:#94a3b8;margin:12px 0 0">Preview: ${previewText}</p>` : ""}
</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label
      className="block text-xs font-bold uppercase tracking-[0.15em] text-slate-500 mb-1.5"
      htmlFor={htmlFor}
    >
      {children}
    </label>
  );
}

function Field({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mb-5", className)}>{children}</div>;
}

function TextInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20 disabled:opacity-50 transition"
      disabled={disabled}
      id={id}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      type="text"
      value={value}
    />
  );
}

function TextArea({
  id,
  value,
  onChange,
  placeholder,
  rows = 6,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <textarea
      className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20 disabled:opacity-50 resize-y font-mono leading-relaxed transition"
      disabled={disabled}
      id={id}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      value={value}
    />
  );
}

// ---------------------------------------------------------------------------
// Variable hint chips
// ---------------------------------------------------------------------------

function VariableChips({ onInsert }: { onInsert: (v: string) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {TEMPLATE_VARIABLES.map((v) => (
        <button
          className="inline-flex items-center gap-1 rounded-lg border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-mono font-semibold text-orange-700 hover:bg-orange-100 hover:border-orange-300 transition cursor-pointer"
          key={v.key}
          onClick={() => onInsert(`{{${v.key}}}`)}
          title={v.label}
          type="button"
        >
          {`{{${v.key}}}`}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content tab
// ---------------------------------------------------------------------------

function ContentTab({
  form,
  onChange,
  disabled,
}: {
  form: EmailTemplate;
  onChange: (patch: Partial<EmailTemplate>) => void;
  disabled: boolean;
}) {
  const [activeVariableField, setActiveVariableField] = useState<string | null>(null);

  function insertVariable(field: keyof EmailTemplate, variable: string) {
    const current = String(form[field] ?? "");
    onChange({ [field]: current + variable });
  }

  return (
    <div>
      <Field>
        <Label htmlFor="tmpl-name">Template Name</Label>
        <TextInput
          disabled={disabled}
          id="tmpl-name"
          onChange={(v) => onChange({ templateName: v })}
          placeholder="e.g. Job Offer"
          value={form.templateName}
        />
      </Field>

      <Field>
        <Label htmlFor="tmpl-description">Description</Label>
        <TextInput
          disabled={disabled}
          id="tmpl-description"
          onChange={(v) => onChange({ description: v })}
          placeholder="Brief note on when this email is sent"
          value={form.description}
        />
      </Field>

      <Field>
        <Label htmlFor="tmpl-subject">Subject Line</Label>
        <TextInput
          disabled={disabled}
          id="tmpl-subject"
          onChange={(v) => onChange({ subject: v })}
          placeholder="e.g. Your Job Offer — {{jobTitle}}"
          value={form.subject}
        />
        {activeVariableField === "subject" && (
          <VariableChips onInsert={(v) => insertVariable("subject", v)} />
        )}
        <button
          className="mt-1.5 text-[11px] font-semibold text-orange-600 hover:text-orange-700"
          onClick={() => setActiveVariableField(activeVariableField === "subject" ? null : "subject")}
          type="button"
        >
          {activeVariableField === "subject" ? "Hide variables" : "+ Insert variable"}
        </button>
      </Field>

      <Field>
        <div className="flex items-center justify-between mb-1.5">
          <Label>Greeting</Label>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-slate-500 font-semibold">Smart greeting</span>
            <button
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-orange-400/30",
                form.smartGreeting ? "bg-orange-500" : "bg-slate-200"
              )}
              onClick={() => onChange({ smartGreeting: !form.smartGreeting })}
              role="switch"
              aria-checked={form.smartGreeting}
              type="button"
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform duration-200",
                  form.smartGreeting ? "translate-x-4" : "translate-x-0"
                )}
              />
            </button>
          </label>
        </div>
        <TextInput
          disabled={disabled || form.smartGreeting}
          id="tmpl-greeting"
          onChange={(v) => onChange({ greeting: v })}
          placeholder={form.smartGreeting ? "Auto: Dear {{recipientName}}," : "e.g. Dear {{employeeName}},"}
          value={form.smartGreeting ? "" : form.greeting}
        />
        {form.smartGreeting && (
          <p className="mt-1.5 text-xs text-slate-400">
            <Sparkles className="inline h-3 w-3 mr-1 text-orange-400" />
            Smart mode: uses recipient name when available, falls back to &ldquo;Dear Team,&rdquo;
          </p>
        )}
        {!form.smartGreeting && (
          <>
            {activeVariableField === "greeting" && (
              <VariableChips onInsert={(v) => insertVariable("greeting", v)} />
            )}
            <button
              className="mt-1.5 text-[11px] font-semibold text-orange-600 hover:text-orange-700"
              onClick={() => setActiveVariableField(activeVariableField === "greeting" ? null : "greeting")}
              type="button"
            >
              {activeVariableField === "greeting" ? "Hide variables" : "+ Insert variable"}
            </button>
          </>
        )}
      </Field>

      <Field>
        <Label htmlFor="tmpl-body">Body (HTML)</Label>
        <TextArea
          disabled={disabled}
          id="tmpl-body"
          onChange={(v) => onChange({ bodyHtml: v })}
          placeholder={"<p>Hello {{employeeName}},</p>\n<p>{{summary}}</p>"}
          rows={8}
          value={form.bodyHtml}
        />
        {activeVariableField === "body" && (
          <VariableChips onInsert={(v) => insertVariable("bodyHtml", v)} />
        )}
        <button
          className="mt-1.5 text-[11px] font-semibold text-orange-600 hover:text-orange-700"
          onClick={() => setActiveVariableField(activeVariableField === "body" ? null : "body")}
          type="button"
        >
          {activeVariableField === "body" ? "Hide variables" : "+ Insert variable"}
        </button>
        <p className="mt-1.5 text-xs text-slate-400">Use basic HTML tags: &lt;p&gt;, &lt;strong&gt;, &lt;em&gt;, &lt;br&gt;, &lt;ul&gt;, &lt;li&gt;. Variables are safe — no JS executed.</p>
      </Field>

      <Field>
        <Label htmlFor="tmpl-closing">Closing</Label>
        <TextInput
          disabled={disabled}
          id="tmpl-closing"
          onChange={(v) => onChange({ closing: v })}
          placeholder="e.g. Please review and take the required action."
          value={form.closing}
        />
      </Field>

      <Field>
        <Label htmlFor="tmpl-preview">Preview Text (shown in inbox)</Label>
        <TextInput
          disabled={disabled}
          id="tmpl-preview"
          onChange={(v) => onChange({ previewText: v })}
          placeholder="e.g. Job offer from Phoenix Workforce — please review."
          value={form.previewText}
        />
      </Field>

      <Field>
        <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <div>
            <p className="text-sm font-bold text-slate-900">Template Status</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {form.isActive ? "Active — emails of this type will be sent." : "Inactive — emails of this type will be suppressed."}
            </p>
          </div>
          <button
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-orange-400/30",
              form.isActive ? "bg-orange-500" : "bg-slate-200"
            )}
            onClick={() => onChange({ isActive: !form.isActive })}
            role="switch"
            aria-checked={form.isActive}
            disabled={disabled}
            type="button"
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform duration-200",
                form.isActive ? "translate-x-5" : "translate-x-0"
              )}
            />
          </button>
        </div>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recipients tab
// ---------------------------------------------------------------------------

type RecipientSlot = "to" | "cc" | "bcc";

function RoleCheckbox({
  label,
  toChecked,
  ccChecked,
  bccChecked,
  onToggle,
  disabled,
}: {
  label: string;
  toChecked: boolean;
  ccChecked: boolean;
  bccChecked: boolean;
  onToggle: (slot: RecipientSlot, checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-slate-100 last:border-b-0">
      <span className="flex-1 text-sm text-slate-700 font-medium">{label}</span>
      {(["to", "cc", "bcc"] as RecipientSlot[]).map((slot) => {
        const checked = slot === "to" ? toChecked : slot === "cc" ? ccChecked : bccChecked;
        return (
          <label
            className={cn(
              "flex items-center gap-1.5 cursor-pointer select-none rounded-lg px-2.5 py-1 text-xs font-bold transition",
              checked
                ? slot === "to"
                  ? "bg-orange-100 text-orange-700"
                  : slot === "cc"
                    ? "bg-sky-100 text-sky-700"
                    : "bg-violet-100 text-violet-700"
                : "bg-slate-50 text-slate-400 hover:bg-slate-100",
              disabled && "opacity-50 cursor-not-allowed"
            )}
            key={slot}
          >
            <input
              checked={checked}
              className="h-3 w-3"
              disabled={disabled}
              onChange={(e) => onToggle(slot, e.target.checked)}
              type="checkbox"
            />
            {slot.toUpperCase()}
          </label>
        );
      })}
    </div>
  );
}

function StaticEmailInput({
  slot,
  emails,
  onChange,
  disabled,
}: {
  slot: RecipientSlot;
  emails: string[];
  onChange: (emails: string[]) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const slotColor = slot === "to" ? "orange" : slot === "cc" ? "sky" : "violet";

  function addEmail() {
    const trimmed = draft.trim().toLowerCase();
    if (!trimmed || emails.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...emails, trimmed]);
    setDraft("");
  }

  function removeEmail(email: string) {
    onChange(emails.filter((e) => e !== email));
  }

  return (
    <div className="mb-4">
      <p className={cn("text-xs font-bold uppercase tracking-widest mb-2", `text-${slotColor}-700`)}>
        Static {slot.toUpperCase()} Emails
      </p>
      <div className="flex gap-2 mb-2">
        <input
          className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20 disabled:opacity-50 transition"
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addEmail())}
          placeholder="email@example.com"
          type="email"
          value={draft}
        />
        <button
          className="flex items-center gap-1 rounded-xl bg-orange-500 px-3 py-2 text-xs font-bold text-white hover:bg-orange-600 transition disabled:opacity-50"
          disabled={disabled || !draft.trim()}
          onClick={addEmail}
          type="button"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>
      {emails.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {emails.map((email) => (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-xs font-semibold",
                slot === "to"
                  ? "border-orange-200 bg-orange-50 text-orange-700"
                  : slot === "cc"
                    ? "border-sky-200 bg-sky-50 text-sky-700"
                    : "border-violet-200 bg-violet-50 text-violet-700"
              )}
              key={email}
            >
              {email}
              <button
                aria-label={`Remove ${email}`}
                className="ml-0.5 rounded-full hover:opacity-70"
                disabled={disabled}
                onClick={() => removeEmail(email)}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RecipientsTab({
  form,
  onChange,
  disabled,
}: {
  form: EmailTemplate;
  onChange: (patch: Partial<EmailTemplate>) => void;
  disabled: boolean;
}) {
  function toggleRole(role: EmailRecipientRole, slot: RecipientSlot, checked: boolean) {
    const field = slot === "to" ? "toRoles" : slot === "cc" ? "ccRoles" : "bccRoles";
    const current = form[field] as EmailRecipientRole[];
    const next = checked ? [...current, role] : current.filter((r) => r !== role);
    onChange({ [field]: Array.from(new Set(next)) });
  }

  return (
    <div>
      <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-black text-slate-900 tracking-tight">Role-based Recipients</p>
          <div className="flex items-center gap-3 text-[10px] font-black uppercase tracking-widest">
            <span className="text-orange-600">TO</span>
            <span className="text-sky-600">CC</span>
            <span className="text-violet-600">BCC</span>
          </div>
        </div>
        {RECIPIENT_ROLE_GROUPS.map((group) => (
          <div className="mb-4 last:mb-0" key={group.label}>
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400 mb-1 px-1">
              {group.label}
            </p>
            <div className="rounded-xl border border-slate-100 bg-slate-50/50 px-3">
              {group.roles.map((role) => (
                <RoleCheckbox
                  bccChecked={form.bccRoles.includes(role)}
                  ccChecked={form.ccRoles.includes(role)}
                  disabled={disabled}
                  key={role}
                  label={EMAIL_RECIPIENT_ROLE_LABELS[role]}
                  onToggle={(slot, checked) => toggleRole(role, slot, checked)}
                  toChecked={form.toRoles.includes(role)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Title & line selectors (shown only when title-based roles are selected) */}
      {(form.toRoles.includes("same_line_selected_titles") ||
        form.ccRoles.includes("same_line_selected_titles") ||
        form.toRoles.includes("all_lines_selected_titles") ||
        form.ccRoles.includes("all_lines_selected_titles") ||
        form.toRoles.includes("selected_lines_selected_titles") ||
        form.ccRoles.includes("selected_lines_selected_titles")) && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-black uppercase tracking-widest text-amber-700 mb-3">
            Target Configuration
          </p>
          <Field>
            <Label htmlFor="target-titles">Target Job Titles (comma-separated)</Label>
            <TextInput
              disabled={disabled}
              id="target-titles"
              onChange={(v) =>
                onChange({
                  targetTitles: v.split(",").map((t) => t.trim()).filter(Boolean),
                })
              }
              placeholder="e.g. Medical Rep, District Manager"
              value={form.targetTitles.join(", ")}
            />
          </Field>
          <Field className="mb-0">
            <Label htmlFor="target-lines">Target Lines (comma-separated)</Label>
            <TextInput
              disabled={disabled}
              id="target-lines"
              onChange={(v) =>
                onChange({
                  targetLines: v.split(",").map((t) => t.trim()).filter(Boolean),
                })
              }
              placeholder="e.g. Cairo North, Alexandria"
              value={form.targetLines.join(", ")}
            />
          </Field>
        </div>
      )}

      {/* Static emails */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-black text-slate-900 tracking-tight mb-4">
          Static Email Overrides
        </p>
        <StaticEmailInput
          disabled={disabled}
          emails={form.staticToEmails}
          onChange={(emails) => onChange({ staticToEmails: emails })}
          slot="to"
        />
        <StaticEmailInput
          disabled={disabled}
          emails={form.staticCcEmails}
          onChange={(emails) => onChange({ staticCcEmails: emails })}
          slot="cc"
        />
        <StaticEmailInput
          disabled={disabled}
          emails={form.staticBccEmails}
          onChange={(emails) => onChange({ staticBccEmails: emails })}
          slot="bcc"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

function PreviewPanel({ form }: { form: EmailTemplate }) {
  const html = useMemo(() => buildPreviewHtml(form), [form]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-3">
        <Eye className="h-4 w-4 text-slate-400" />
        <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">
          Live Preview
        </p>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-500">
          Sample data
        </span>
      </div>
      <div className="flex-1 overflow-hidden rounded-2xl border border-slate-200 shadow-xl bg-slate-100">
        <iframe
          className="w-full h-full border-0"
          sandbox="allow-same-origin"
          srcDoc={html}
          title="Email Preview"
          style={{ minHeight: "640px" }}
        />
      </div>
      <p className="mt-2 text-center text-[10px] text-slate-400">
        Preview uses sample data. Variables shown in{" "}
        <span className="text-orange-500 font-semibold">orange</span> if no sample value exists.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export type EmailTemplateManagerProps = {
  initialTemplates: EmailTemplate[];
};

export function EmailTemplateManager({ initialTemplates }: EmailTemplateManagerProps) {
  const [templates, setTemplates] = useState<EmailTemplate[]>(initialTemplates);
  const [selectedKey, setSelectedKey] = useState<EmailTemplateKey | "">("");
  const [form, setForm] = useState<EmailTemplate | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<"content" | "recipients">("content");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSelectTemplate(key: string) {
    if (isDirty) {
      if (!confirm("You have unsaved changes. Discard and switch template?")) return;
    }
    setSelectedKey(key as EmailTemplateKey | "");
    const tpl = templates.find((t) => t.templateKey === key);
    setForm(tpl ? { ...tpl } : null);
    setIsDirty(false);
    setSaveError(null);
    setSaveSuccess(false);
    setActiveTab("content");
  }

  const handleChange = useCallback((patch: Partial<EmailTemplate>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
    setIsDirty(true);
    setSaveSuccess(false);
  }, []);

  function handleSave() {
    if (!form || !selectedKey) return;
    setSaveError(null);
    setSaveSuccess(false);

    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/email-templates/${selectedKey}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateName: form.templateName,
            description: form.description,
            subject: form.subject,
            greeting: form.greeting,
            bodyHtml: form.bodyHtml,
            bodyText: form.bodyText,
            closing: form.closing,
            previewText: form.previewText,
            isActive: form.isActive,
            smartGreeting: form.smartGreeting,
            toRoles: form.toRoles,
            ccRoles: form.ccRoles,
            bccRoles: form.bccRoles,
            targetTitles: form.targetTitles,
            targetLines: form.targetLines,
            staticToEmails: form.staticToEmails,
            staticCcEmails: form.staticCcEmails,
            staticBccEmails: form.staticBccEmails,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error((data as { message?: string }).message ?? "Save failed");
        }

        const data = (await res.json()) as { template: EmailTemplate };
        const saved = data.template;

        // Update template list
        setTemplates((prev) =>
          prev.map((t) => (t.templateKey === saved.templateKey ? saved : t))
        );
        setForm({ ...saved });
        setIsDirty(false);
        setSaveSuccess(true);

        setTimeout(() => setSaveSuccess(false), 3000);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to save template.");
      }
    });
  }

  const isSaving = isPending;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-screen-xl px-4 py-8 sm:px-6 lg:px-8">

        {/* ── Page header ─────────────────────────────────────────────── */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[linear-gradient(180deg,#FF8A1C_0%,#F97316_100%)] shadow-[0_8px_16px_rgba(249,115,22,0.28)]">
              <Mail className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-[-0.02em] text-slate-900">
                Email Templates
              </h1>
              <p className="text-xs text-slate-500">
                Configure content and recipient rules for all system emails
              </p>
            </div>
          </div>
        </div>

        {/* ── Template selector ───────────────────────────────────────── */}
        <div className="mb-6 max-w-md">
          <label className="block text-xs font-black uppercase tracking-[0.18em] text-slate-500 mb-2">
            Select Email Template
          </label>
          <div className="relative">
            <select
              className="w-full appearance-none rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20 transition pr-10"
              onChange={(e) => handleSelectTemplate(e.target.value)}
              value={selectedKey}
            >
              <option value="">— Select an email type —</option>
              {EMAIL_TEMPLATE_KEYS.map((key) => {
                const tpl = templates.find((t) => t.templateKey === key);
                return (
                  <option key={key} value={key}>
                    {tpl?.templateName ?? EMAIL_TEMPLATE_LABELS[key]}
                    {tpl && !tpl.isActive ? " (inactive)" : ""}
                  </option>
                );
              })}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        {/* ── Empty state ─────────────────────────────────────────────── */}
        {!form && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white py-20 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-50">
              <Mail className="h-7 w-7 text-orange-400" />
            </div>
            <p className="text-base font-black text-slate-900 mb-1">
              Select a template to begin
            </p>
            <p className="text-sm text-slate-500 max-w-xs">
              Choose an email type from the dropdown above to view and edit its template and recipient rules.
            </p>
          </div>
        )}

        {/* ── Two-column editor layout ─────────────────────────────────── */}
        {form && selectedKey && (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr,480px]">

            {/* LEFT — Editor ─────────────────────────────────────────── */}
            <div>
              {/* Card header: template title + status badge */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-black tracking-tight text-slate-900">
                    {form.templateName}
                  </h2>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-bold",
                      form.isActive
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 bg-slate-50 text-slate-500"
                    )}
                  >
                    {form.isActive ? "Active" : "Inactive"}
                  </span>
                  {isDirty && (
                    <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-bold text-amber-700">
                      Unsaved
                    </span>
                  )}
                </div>

                {/* Save button */}
                <button
                  className={cn(
                    "flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-orange-400/30",
                    isDirty && !isSaving
                      ? "bg-orange-500 text-white hover:bg-orange-600 shadow-orange-200"
                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                  )}
                  disabled={!isDirty || isSaving}
                  onClick={handleSave}
                  type="button"
                >
                  {isSaving ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Saving…
                    </>
                  ) : saveSuccess ? (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      Saved
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4" />
                      Save Changes
                    </>
                  )}
                </button>
              </div>

              {/* Error banner */}
              {saveError && (
                <div className="mb-4 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{saveError}</span>
                  <button
                    aria-label="Dismiss error"
                    className="ml-auto shrink-0 hover:opacity-70"
                    onClick={() => setSaveError(null)}
                    type="button"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}

              {/* Success banner */}
              {saveSuccess && (
                <div className="mb-4 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  Template saved successfully.
                </div>
              )}

              {/* Tabs */}
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                <div className="flex border-b border-slate-200">
                  {(["content", "recipients"] as const).map((tab) => (
                    <button
                      className={cn(
                        "flex flex-1 items-center justify-center gap-2 px-5 py-3.5 text-sm font-bold transition",
                        activeTab === tab
                          ? "border-b-2 border-orange-500 text-orange-700 bg-orange-50/50"
                          : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                      )}
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      type="button"
                    >
                      {tab === "content" ? (
                        <><Settings2 className="h-4 w-4" /> Content</>
                      ) : (
                        <><Mail className="h-4 w-4" /> Recipients</>
                      )}
                    </button>
                  ))}
                </div>

                <div className="p-5">
                  {activeTab === "content" ? (
                    <ContentTab disabled={isSaving} form={form} onChange={handleChange} />
                  ) : (
                    <RecipientsTab disabled={isSaving} form={form} onChange={handleChange} />
                  )}
                </div>
              </div>

              {/* Bottom save bar (always visible) */}
              <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-xs text-slate-500">
                  {form.updatedBy ? (
                    <>Last saved by <strong className="text-slate-700">{form.updatedBy}</strong></>
                  ) : (
                    "Never saved — using default template"
                  )}
                </p>
                <button
                  className={cn(
                    "flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition-all",
                    isDirty && !isSaving
                      ? "bg-orange-500 text-white hover:bg-orange-600"
                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                  )}
                  disabled={!isDirty || isSaving}
                  onClick={handleSave}
                  type="button"
                >
                  <Save className="h-4 w-4" />
                  {isSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>

            {/* RIGHT — Preview ───────────────────────────────────────── */}
            <div className="xl:sticky xl:top-6 xl:self-start">
              <PreviewPanel form={form} />
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
