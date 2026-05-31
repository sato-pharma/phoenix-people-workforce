"use client";

import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clipboard, Copy, Loader2, Mail, Search, Send } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  adminPanelClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { PhoenixHrEmailTone } from "@/lib/email/phoenix-hr-reply-template";
import { cn } from "@/lib/utils";

type RecipientChannel = "bccSelections" | "ccSelections" | "toSelections";
type RecipientSelection =
  | { email: string; label?: string | null; type: "email" }
  | { hrId: string; label?: string | null; type: "employee" }
  | { key: "finance_team" | "hr_team" | "managers"; label?: string | null; type: "group" };

type EmployeeOption = {
  departmentName?: string | null;
  email?: string | null;
  hrId: string;
  label: string;
  lineName?: string | null;
  managerName?: string | null;
  title?: string | null;
};

type ComposerOptions = {
  allowedDomains: string[];
  analytics: {
    externalRecipients30d: number;
    failed30d: number;
    lastManualSendAt: string | null;
    providerEvents30d: Record<string, number>;
    recentManualSends: Array<{
      createdAt: string | null;
      externalCount: number;
      status: string;
      subject: string;
      templateKey: string | null;
      totalRecipients: number;
    }>;
    sent30d: number;
    skipped30d: number;
  };
  employeeOptions: EmployeeOption[];
  groups: Array<{ description: string; key: "finance_team" | "hr_team" | "managers"; label: string }>;
  maxRecipients: number;
  templates: Array<{ description: string; isActive: boolean; templateKey: string; templateName: string }>;
  tones: Array<{ label: string; value: PhoenixHrEmailTone }>;
  variables: Array<{ category: string; label: string; sampleValue: string; token: string }>;
};

type ComposerForm = {
  bcc: string;
  bccSelections: RecipientSelection[];
  cc: string;
  ccSelections: RecipientSelection[];
  clientRequestId: string;
  externalJustification: string;
  recipientName: string;
  replyMessage: string;
  senderName: string;
  subject: string;
  templateKey: string;
  to: string;
  toSelections: RecipientSelection[];
  tone: PhoenixHrEmailTone;
};

type PreviewState = {
  html: string;
  plainText: string;
  recipientPolicy: {
    externalRecipients: string[];
    issues: Array<{ code: string; message: string }>;
    maxRecipients: number;
    totalRecipients: number;
  };
  recipients: {
    bcc: Array<{ email: string; label: string; source: string }>;
    cc: Array<{ email: string; label: string; source: string }>;
    to: Array<{ email: string; label: string; source: string }>;
    totalRecipients: number;
  };
  signatureImageWarning?: string | null;
  subject: string;
  warnings: string[];
};

const steps = ["Choose Recipients", "Write Email", "Preview", "Confirm & Send"] as const;
const inputClassName = "h-11 w-full rounded-xl border border-[#D8E0EA] bg-white px-3 text-sm font-semibold text-[#0F172A] outline-none transition placeholder:text-[#94A3B8] focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";
const textareaClassName = "min-h-[190px] w-full resize-y rounded-xl border border-[#D8E0EA] bg-white px-3 py-3 text-sm font-medium leading-6 text-[#0F172A] outline-none transition placeholder:text-[#94A3B8] focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";

function newClientRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultForm(): ComposerForm {
  return {
    bcc: "",
    bccSelections: [],
    cc: "",
    ccSelections: [],
    clientRequestId: newClientRequestId(),
    externalJustification: "",
    recipientName: "",
    replyMessage: "Thank you for your email.\n\nWe reviewed your request and will proceed according to the HR process.",
    senderName: "Phoenix HR Team",
    subject: "Re: HR Request",
    templateKey: "",
    to: "",
    toSelections: [],
    tone: "professional",
  };
}

function htmlDocumentToCopyFragment(html: string) {
  const bodyMatch = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  const bodyAttributes = bodyMatch?.[1] ?? "";
  const bodyHtml = bodyMatch?.[2] ?? html;
  const bodyStyle = bodyAttributes.match(/style="([^"]*)"/i)?.[1] ?? "";
  const wrapperStyle = bodyStyle || "margin:0;background:#eef2f7;padding:28px 14px;font-family:Arial,Helvetica,sans-serif;color:#0f172a";

  return `<div style="${wrapperStyle}">${bodyHtml}</div>`;
}

export function EmailReplyComposer() {
  const [form, setForm] = useState<ComposerForm>(() => defaultForm());
  const [step, setStep] = useState(0);
  const [options, setOptions] = useState<ComposerOptions | null>(null);
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const richCopyRef = useRef<HTMLDivElement>(null);

  const externalRecipients = preview?.recipientPolicy.externalRecipients ?? [];
  const policyIssues = preview?.recipientPolicy.issues ?? [];
  const totalRecipients = preview?.recipientPolicy.totalRecipients ?? 0;
  const variablesAvailable = form.toSelections.some((selection) => selection.type === "employee") || form.to.trim().length > 0;

  useEffect(() => {
    void loadOptions();
  }, []);

  const filteredEmployees = useMemo(() => {
    const query = employeeQuery.trim().toLowerCase();
    const employees = options?.employeeOptions ?? [];
    if (!query) return employees.slice(0, 12);
    return employees.filter((employee) => `${employee.label} ${employee.email ?? ""} ${employee.departmentName ?? ""} ${employee.managerName ?? ""}`.toLowerCase().includes(query)).slice(0, 12);
  }, [employeeQuery, options?.employeeOptions]);

  function updateField<Key extends keyof ComposerForm>(key: Key, value: ComposerForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setPreview(null);
  }

  async function loadOptions(query = "") {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/email-composer/options${query ? `?q=${encodeURIComponent(query)}` : ""}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "Composer options failed to load.");
      setOptions(payload.options);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Composer options failed to load.");
    } finally {
      setLoading(false);
    }
  }

  function addSelection(channel: RecipientChannel, selection: RecipientSelection) {
    setForm((current) => {
      const exists = current[channel].some((item) => JSON.stringify(item) === JSON.stringify(selection));
      return exists ? current : { ...current, [channel]: [...current[channel], selection] };
    });
    setPreview(null);
  }

  function removeSelection(channel: RecipientChannel, index: number) {
    setForm((current) => ({ ...current, [channel]: current[channel].filter((_item, itemIndex) => itemIndex !== index) }));
    setPreview(null);
  }

  function insertVariable(token: string) {
    updateField("replyMessage", `${form.replyMessage}{{${token}}}`);
  }

  async function applyTemplate(templateKey: string) {
    updateField("templateKey", templateKey);
    if (!templateKey) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/email-templates/${encodeURIComponent(templateKey)}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "Template failed to load.");
      const template = payload.template;
      setForm((current) => ({
        ...current,
        replyMessage: template.bodyText || template.bodyHtml || current.replyMessage,
        subject: template.subject || current.subject,
        templateKey,
      }));
      setPreview(null);
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "Template failed to load.");
    } finally {
      setLoading(false);
    }
  }

  async function backendPreview() {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/email-composer/preview", {
        body: JSON.stringify(form),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "Email preview failed.");
      setPreview(payload.preview as PreviewState);
      setMessage("Backend preview and recipient checks are ready.");
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Email preview failed.");
    } finally {
      setLoading(false);
    }
  }

  async function sendEmail() {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/email-reply/send", {
        body: JSON.stringify(form),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "Email send failed.");
      if (payload.result?.skipped) {
        setError(payload.result.reason ?? "Email sending is not configured.");
        return;
      }
      setMessage(payload.result?.id ? `Email accepted by provider. Resend ID: ${payload.result.id}` : "Email accepted by provider.");
      setForm((current) => ({ ...current, clientRequestId: newClientRequestId() }));
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Email send failed.");
    } finally {
      setLoading(false);
    }
  }

  async function copyRichEmail() {
    if (!preview?.html) return;
    const html = preview.html;
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([preview.plainText], { type: "text/plain" }),
        }),
      ]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      return;
    }
    const node = richCopyRef.current;
    if (!node) return;
    node.innerHTML = htmlDocumentToCopyFragment(html);
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("copy");
    selection?.removeAllRanges();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <main className="min-h-screen bg-[#F3F6FA] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <AdminPageHero
          actions={
            <>
              <Button className="h-11 rounded-xl border border-[#D8E0EA] bg-white px-4 text-[#0F172A]" onClick={backendPreview} type="button" variant="secondary">
                <Clipboard className="mr-2 h-4 w-4" />
                Backend Preview
              </Button>
              <Button className="h-11 rounded-xl bg-[#F97316] px-4 text-white" disabled={loading || policyIssues.length > 0 || !preview} onClick={sendEmail} type="button">
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send Email
              </Button>
            </>
          }
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip tone="orange">Guided composer</AdminInsightChip>
              <AdminInsightChip>Backend recipient checks</AdminInsightChip>
              <AdminInsightChip tone="slate">{options?.maxRecipients ?? 25} recipient limit</AdminInsightChip>
            </div>
          }
          description="Create manual HR emails through a four-step flow. Recipients, external justification, preview, signature validation, idempotency, and audit are enforced by the backend."
          eyebrow="HR Communications"
          icon={<Mail className="h-3.5 w-3.5" />}
          title="Email Composer"
        />

        <div aria-hidden="true" className="pointer-events-none fixed left-[-10000px] top-0 z-[-1] w-[720px] overflow-hidden opacity-0" ref={richCopyRef} />
        {message ? <AdminCallout tone="success"><Check className="mt-0.5 h-4 w-4" />{message}</AdminCallout> : null}
        {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}

        <Card className={cn(adminPanelClassName, "p-4")}>
          <div className="grid gap-2 md:grid-cols-4">
            {steps.map((label, index) => (
              <button className={cn("rounded-lg border px-3 py-3 text-left text-sm font-black", step === index ? "border-[#F97316] bg-[#FFF7ED] text-[#9A3412]" : "border-[#E2E8F0] bg-white text-[#334155]")} key={label} onClick={() => setStep(index)} type="button">
                {index + 1}. {label}
              </button>
            ))}
          </div>
        </Card>

        <DeliveryAnalyticsPanel analytics={options?.analytics} />

        {step === 0 ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
              <AdminSectionHeader description="Search employees or add backend-resolved groups. Raw email fields remain available for transition." title="Choose recipients" />
              <div className="space-y-5 p-5">
                <div className="flex gap-2">
                  <input className={inputClassName} value={employeeQuery} onChange={(event) => setEmployeeQuery(event.target.value)} placeholder="Search name, HR ID, email, department, manager" />
                  <Button className="h-11 rounded-xl bg-[#0F172A] text-white" onClick={() => void loadOptions(employeeQuery)} type="button"><Search className="h-4 w-4" /></Button>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {filteredEmployees.map((employee) => (
                    <button className="rounded-xl border border-[#E2E8F0] bg-white p-3 text-left hover:border-[#FDBA74]" key={employee.hrId} onClick={() => addSelection("toSelections", { hrId: employee.hrId, label: employee.label, type: "employee" })} type="button">
                      <span className="block text-sm font-black text-[#0F172A]">{employee.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-[#64748B]">{employee.email} - {employee.title ?? "No title"}</span>
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  {(options?.groups ?? []).map((group) => (
                    <button className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-left hover:border-[#FDBA74]" key={group.key} onClick={() => addSelection("toSelections", { key: group.key, label: group.label, type: "group" })} type="button">
                      <span className="block text-sm font-black text-[#0F172A]">{group.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-[#64748B]">{group.description}</span>
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <RawEmailField label="Raw TO" value={form.to} onChange={(value) => updateField("to", value)} />
                  <RawEmailField label="Raw CC" value={form.cc} onChange={(value) => updateField("cc", value)} />
                  <RawEmailField label="Raw BCC" value={form.bcc} onChange={(value) => updateField("bcc", value)} />
                </div>
              </div>
            </Card>
            <SelectedRecipients form={form} onRemove={removeSelection} />
          </div>
        ) : null}

        {step === 1 ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
              <AdminSectionHeader description="Write in plain language. Optional variables are inserted as backend tokens and resolved by the server." title="Write email" />
              <div className="space-y-5 p-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Use template">
                    <select className={inputClassName} value={form.templateKey} onChange={(event) => void applyTemplate(event.target.value)}>
                      <option value="">No template</option>
                      {(options?.templates ?? []).map((template) => <option key={template.templateKey} value={template.templateKey}>{template.templateName}</option>)}
                    </select>
                  </Field>
                  <Field label="Recipient greeting name"><input className={inputClassName} value={form.recipientName} onChange={(event) => updateField("recipientName", event.target.value)} placeholder="Optional" /></Field>
                </div>
                <Field label="Subject"><input className={inputClassName} value={form.subject} onChange={(event) => updateField("subject", event.target.value)} placeholder="Email subject" /></Field>
                <Field label="Message"><textarea className={textareaClassName} value={form.replyMessage} onChange={(event) => updateField("replyMessage", event.target.value)} placeholder="Write the email body here" /></Field>
                <div>
                  <FieldLabel>Tone</FieldLabel>
                  <div className="grid gap-2 md:grid-cols-4">
                    {(options?.tones ?? [
                      { label: "Formal", value: "professional" as PhoenixHrEmailTone },
                      { label: "Friendly", value: "warm" as PhoenixHrEmailTone },
                      { label: "Short", value: "concise" as PhoenixHrEmailTone },
                      { label: "Detailed", value: "firm" as PhoenixHrEmailTone },
                    ]).map((tone) => (
                      <button className={cn("rounded-xl border px-3 py-3 text-sm font-black", form.tone === tone.value ? "border-[#FDBA74] bg-[#FFF7ED] text-[#9A3412]" : "border-[#E2E8F0] bg-white text-[#334155]")} key={tone.value} onClick={() => updateField("tone", tone.value)} type="button">
                        {tone.label}
                      </button>
                    ))}
                  </div>
                </div>
                {externalRecipients.length > 0 || policyIssues.some((issue) => issue.code === "external_justification_required") ? (
                  <Field label="External recipient justification"><textarea className="min-h-[96px] w-full rounded-xl border border-[#D8E0EA] px-3 py-3 text-sm" value={form.externalJustification} onChange={(event) => updateField("externalJustification", event.target.value)} placeholder="Example: Candidate offer communication approved by HR." /></Field>
                ) : null}
              </div>
            </Card>
            <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Variables</p>
              {variablesAvailable ? (
                <div className="flex max-h-[620px] flex-wrap gap-2 overflow-auto">
                  {(options?.variables ?? []).map((variable) => (
                    <button className="rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1.5 text-xs font-black text-[#C2410C]" key={variable.token} onClick={() => insertVariable(variable.token)} title={`Stores {{${variable.token}}}. Example: ${variable.sampleValue}`} type="button">
                      {variable.label}
                    </button>
                  ))}
                </div>
              ) : <p className="text-sm leading-6 text-[#64748B]">Choose an employee or recipient first so backend context can resolve variables.</p>}
            </Card>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
              <AdminSectionHeader action={<Button className="rounded-xl bg-[#0F172A] text-white" onClick={backendPreview} type="button">Render</Button>} description="This is the backend-rendered email body, not a browser-only preview." title="Preview" />
              <div className="bg-[#EEF2F7] p-4">
                {preview?.html ? <iframe className="h-[720px] w-full rounded-xl border border-[#CBD5E1] bg-white" sandbox="" srcDoc={preview.html} title="Backend email preview" /> : <div className="flex h-[720px] items-center justify-center text-sm text-[#64748B]">Run backend preview to inspect the final email.</div>}
              </div>
            </Card>
            <PreviewChecklist preview={preview} />
          </div>
        ) : null}

        {step === 3 ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
              <AdminSectionHeader action={<Button className="rounded-xl border border-[#D8E0EA] bg-white text-[#0F172A]" disabled={!preview} onClick={() => void copyRichEmail()} type="button" variant="secondary">{copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}Copy</Button>} description="Final confirmation uses backend recipient and policy results." title="Confirm & Send" />
              <div className="space-y-4 p-5">
                {!preview ? <AdminCallout tone="warning"><AlertTriangle className="mt-0.5 h-4 w-4" />Run backend preview before sending.</AdminCallout> : null}
                {externalRecipients.length > 0 ? (
                  <Field label="External recipient justification"><textarea className="min-h-[96px] w-full rounded-xl border border-[#D8E0EA] px-3 py-3 text-sm" value={form.externalJustification} onChange={(event) => updateField("externalJustification", event.target.value)} placeholder="Required for external recipients" /></Field>
                ) : null}
                <div className={cn(adminSoftPanelClassName, "grid gap-3 p-4 md:grid-cols-3")}>
                  <Metric label="Internal/external" value={`${Math.max(0, totalRecipients - externalRecipients.length)} / ${externalRecipients.length}`} />
                  <Metric label="Total recipients" value={String(totalRecipients)} />
                  <Metric label="Limit" value={String(options?.maxRecipients ?? 25)} />
                </div>
                <Button className="h-12 w-full rounded-xl bg-[#F97316] text-white" disabled={loading || !preview || policyIssues.length > 0} onClick={sendEmail} type="button">
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  Send Email
                </Button>
              </div>
            </Card>
            <PreviewChecklist preview={preview} />
          </div>
        ) : null}

        <div className="flex justify-between">
          <Button className="rounded-xl border border-[#CBD5E1] bg-white text-[#0F172A]" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))} type="button" variant="secondary"><ChevronLeft className="mr-2 h-4 w-4" />Back</Button>
          <Button className="rounded-xl bg-[#0F172A] text-white" disabled={step === steps.length - 1} onClick={() => setStep((current) => Math.min(steps.length - 1, current + 1))} type="button">Next<ChevronRight className="ml-2 h-4 w-4" /></Button>
        </div>
      </div>
    </main>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </label>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1.5 block text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">{children}</span>;
}

function RawEmailField({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <Field label={label}>
      <textarea className="min-h-[88px] w-full rounded-xl border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#0F172A]" onChange={(event) => onChange(event.target.value)} placeholder="email@satopharma.com" value={value} />
    </Field>
  );
}

function SelectedRecipients({ form, onRemove }: { form: ComposerForm; onRemove: (channel: RecipientChannel, index: number) => void }) {
  return (
    <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
      <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Selected chips</p>
      {([
        ["toSelections", "TO"],
        ["ccSelections", "CC"],
        ["bccSelections", "BCC"],
      ] as Array<[RecipientChannel, string]>).map(([channel, label]) => (
        <div key={channel}>
          <p className="mb-2 text-xs font-black text-[#64748B]">{label}</p>
          <div className="flex flex-wrap gap-2">
            {form[channel].length > 0 ? form[channel].map((selection, index) => (
              <button className="rounded-full border border-[#CBD5E1] bg-white px-3 py-1.5 text-xs font-black text-[#0F172A]" key={`${channel}-${index}`} onClick={() => onRemove(channel, index)} type="button">
                {selection.label ?? ("hrId" in selection ? selection.hrId : "key" in selection ? selection.key : selection.email)} x
              </button>
            )) : <span className="text-sm text-[#94A3B8]">No chips selected.</span>}
          </div>
        </div>
      ))}
    </Card>
  );
}

function PreviewChecklist({ preview }: { preview: PreviewState | null }) {
  return (
    <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
      <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Backend checks</p>
      {preview ? (
        <>
          <Metric label="Recipients" value={String(preview.recipientPolicy.totalRecipients)} />
          <Metric label="External" value={String(preview.recipientPolicy.externalRecipients.length)} />
          {preview.warnings.length > 0 ? preview.warnings.map((warning) => (
            <div className="rounded-xl border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-sm font-semibold text-[#9A3412]" key={warning}>{warning}</div>
          )) : <div className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-sm font-semibold text-[#166534]">Ready after backend checks.</div>}
          <RecipientBucket label="TO" recipients={preview.recipients.to} />
          <RecipientBucket label="CC" recipients={preview.recipients.cc} />
          <RecipientBucket label="BCC" recipients={preview.recipients.bcc} />
        </>
      ) : <p className="text-sm leading-6 text-[#64748B]">Run preview to see recipient count, external warnings, signature image status, and final subject.</p>}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">{label}</p>
      <p className="mt-1 text-lg font-black text-[#0F172A]">{value}</p>
    </div>
  );
}

function DeliveryAnalyticsPanel({ analytics }: { analytics: ComposerOptions["analytics"] | undefined }) {
  if (!analytics) return null;
  return (
    <Card className={cn(adminPanelClassName, "p-4")}>
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Sent 30d" value={String(analytics.sent30d)} />
        <Metric label="Skipped 30d" value={String(analytics.skipped30d)} />
        <Metric label="Failed 30d" value={String(analytics.failed30d)} />
        <Metric label="External 30d" value={String(analytics.externalRecipients30d)} />
      </div>
      <div className="mt-4 grid gap-2 lg:grid-cols-4">
        {analytics.recentManualSends.length > 0 ? analytics.recentManualSends.slice(0, 4).map((send, index) => (
          <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3" key={`${send.createdAt ?? index}-${send.subject}`}>
            <p className="truncate text-sm font-black text-[#0F172A]">{send.subject}</p>
            <p className="mt-1 text-xs font-bold text-[#64748B]">{send.status} - {send.totalRecipients} recipient(s)</p>
          </div>
        )) : <p className="text-sm font-semibold text-[#64748B]">No manual sends recorded in the last 30 days.</p>}
      </div>
    </Card>
  );
}

function RecipientBucket({ label, recipients }: { label: string; recipients: Array<{ email: string; label: string; source: string }> }) {
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">{label} ({recipients.length})</p>
      <div className="mt-2 space-y-2">
        {recipients.length > 0 ? recipients.map((recipient) => (
          <div className="rounded-lg bg-[#F8FAFC] px-2.5 py-2" key={`${label}-${recipient.email}`}>
            <p className="truncate text-sm font-bold text-[#0F172A]">{recipient.email}</p>
            <p className="truncate text-xs font-semibold text-[#64748B]">{recipient.source}</p>
          </div>
        )) : <p className="text-sm font-semibold text-[#94A3B8]">None</p>}
      </div>
    </div>
  );
}
