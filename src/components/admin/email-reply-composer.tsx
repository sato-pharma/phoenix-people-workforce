"use client";

import { AlertTriangle, Check, ChevronDown, Copy, Eye, Loader2, Mail, Send, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  adminPanelClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-system";
import {
  EmailBodyEditor,
  htmlToPlainText,
  type EmailBodyEditorHandle,
} from "@/components/admin/email-body-editor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PhoenixHrEmailTone } from "@/lib/email/phoenix-hr-reply-template";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


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

type GroupOption = { description: string; key: "finance_team" | "hr_team" | "managers"; label: string };

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
  groups: GroupOption[];
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
  replyMessageHtml: string;
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

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const defaultBodyHtml = "<p>Thank you for your email.</p><p>We reviewed your request and will proceed according to the HR process.</p>";

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
    replyMessage: htmlToPlainText(defaultBodyHtml),
    replyMessageHtml: defaultBodyHtml,
    senderName: "Phoenix HR Team",
    subject: "Re: HR Request",
    templateKey: "",
    to: "",
    toSelections: [],
    tone: "professional",
  };
}

function textToParagraphHtml(text: string) {
  const escape = (value: string) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function htmlDocumentToCopyFragment(html: string) {
  const bodyMatch = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  const bodyAttributes = bodyMatch?.[1] ?? "";
  const bodyHtml = bodyMatch?.[2] ?? html;
  const bodyStyle = bodyAttributes.match(/style="([^"]*)"/i)?.[1] ?? "";
  const wrapperStyle = bodyStyle || "margin:0;background:#eef2f7;padding:28px 14px;font-family:Arial,Helvetica,sans-serif;color:#0f172a";

  return `<div style="${wrapperStyle}">${bodyHtml}</div>`;
}

function selectionDisplayLabel(selection: RecipientSelection) {
  return selection.label ?? ("hrId" in selection ? selection.hrId : "key" in selection ? selection.key : selection.email);
}

export function EmailReplyComposer() {
  const [form, setForm] = useState<ComposerForm>(() => defaultForm());
  const [options, setOptions] = useState<ComposerOptions | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const richCopyRef = useRef<HTMLDivElement>(null);
  const bodyEditorRef = useRef<EmailBodyEditorHandle | null>(null);
  // The editor pulls external values only when they did not originate from typing; bump
  // this key when a template or AI draft replaces the whole body so the canvas rebuilds.
  const [bodyVersion, setBodyVersion] = useState(0);

  const externalRecipients = preview?.recipientPolicy.externalRecipients ?? [];
  const policyIssues = preview?.recipientPolicy.issues ?? [];
  const busy = loading || aiBusy;
  // Variables only resolve when the backend can find an employee context (matches the
  // server's firstSelectedEmployee lookup across all channels + raw TO).
  const variablesAvailable =
    [...form.toSelections, ...form.ccSelections, ...form.bccSelections].some((selection) => selection.type === "employee") ||
    form.to.trim().length > 0;

  const editorVariables = useMemo(
    () => (options?.variables ?? []).map((variable) => ({
      label: variable.label,
      sampleValue: variable.sampleValue,
      token: variable.token,
    })),
    [options?.variables],
  );

  useEffect(() => {
    void loadOptions();
  }, []);

  function updateField<Key extends keyof ComposerForm>(key: Key, value: ComposerForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setPreview(null);
  }

  function updateBody(html: string) {
    setForm((current) => ({ ...current, replyMessage: htmlToPlainText(html), replyMessageHtml: html }));
    setPreview(null);
  }

  async function loadOptions(query = "") {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/email-composer/options${query ? `?q=${encodeURIComponent(query)}` : ""}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "Composer options failed to load.");
      setOptions((previous) => {
        const next = payload.options as ComposerOptions;
        if (!previous) return next;
        // Union the employee pools across searches: each row's typeahead filters locally,
        // so a Cc search must not shrink the To row's choices, and clearing the input
        // must still find the originally loaded page.
        const seen = new Set(next.employeeOptions.map((employee) => employee.hrId));
        return {
          ...next,
          employeeOptions: [...next.employeeOptions, ...previous.employeeOptions.filter((employee) => !seen.has(employee.hrId))],
        };
      });
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
    bodyEditorRef.current?.insertToken(token);
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
      const html = String(template.bodyHtml ?? "").trim() || textToParagraphHtml(String(template.bodyText ?? ""));
      // The text/html pair must be replaced or kept TOGETHER - a template whose body
      // text-extracts to empty counts as "no body change" for both representations, so
      // the multipart parts never desynchronize.
      const plain = htmlToPlainText(html);
      setForm((current) => ({
        ...current,
        replyMessage: plain || current.replyMessage,
        replyMessageHtml: plain ? html : current.replyMessageHtml,
        subject: template.subject || current.subject,
        templateKey,
      }));
      setBodyVersion((current) => current + 1);
      setPreview(null);
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "Template failed to load.");
    } finally {
      setLoading(false);
    }
  }

  async function runAiAssist(quickAction?: string) {
    if (aiBusy || loading) return;
    const instruction = [aiInstruction.trim(), quickAction].filter(Boolean).join(" - ");
    if (!instruction) {
      setError("Tell the AI what you want first (English or Arabic).");
      return;
    }
    setError(null);
    setMessage(null);
    setAiBusy(true);
    try {
      const response = await fetch("/api/admin/email-ai/draft", {
        body: JSON.stringify({
          current: {
            bodyHtml: form.replyMessageHtml,
            closingText: "",
            greeting: form.recipientName ? `Dear ${form.recipientName},` : "",
            previewText: "",
            subject: form.subject,
          },
          instruction,
          mode: "composer",
          templateKey: "",
          templateName: "Manual HR email",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "AI draft failed.");
        return;
      }
      const aiDraft = payload?.result?.draft as { bodyHtml: string; subject: string } | undefined;
      if (!aiDraft?.bodyHtml) {
        setError("The AI returned an empty draft. Try again.");
        return;
      }
      const warnings: string[] = payload?.result?.warnings ?? [];
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setForm((current) => ({
        ...current,
        replyMessage: htmlToPlainText(aiDraft.bodyHtml),
        replyMessageHtml: aiDraft.bodyHtml,
        subject: aiDraft.subject?.trim() ? aiDraft.subject : current.subject,
      }));
      setBodyVersion((current) => current + 1);
      setPreview(null);
      setMessage(
        warnings.length > 0
          ? `AI draft applied. ${warnings.join(" ")}`
          : "AI draft applied - review the email, then run Preview & Check before sending.",
      );
    } catch {
      setError("Could not reach the AI assistant. Check your connection and try again.");
    } finally {
      setAiBusy(false);
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

  const needsJustification = externalRecipients.length > 0 || policyIssues.some((issue) => issue.code === "external_justification_required");

  return (
    <main className="min-h-screen bg-[#F3F6FA] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <AdminPageHero
          actions={
            <>
              <Button className="h-11 rounded-xl border border-[#D8E0EA] bg-white px-4 text-[#0F172A]" disabled={busy} onClick={backendPreview} type="button" variant="secondary">
                <Eye className="mr-2 h-4 w-4" />
                Preview &amp; Check
              </Button>
              <Button className="h-11 rounded-xl bg-[#F97316] px-4 text-white" disabled={busy || policyIssues.length > 0 || !preview} onClick={sendEmail} type="button">
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send Email
              </Button>
            </>
          }
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip tone="orange">Gmail-style composer</AdminInsightChip>
              <AdminInsightChip>Backend recipient checks</AdminInsightChip>
              <AdminInsightChip tone="slate">{options?.maxRecipients ?? 25} recipient limit</AdminInsightChip>
            </div>
          }
          description="Write the email exactly as it will look. Recipients, external justification, preview, signature validation, idempotency, and audit stay enforced by the backend."
          eyebrow="HR Communications"
          icon={<Mail className="h-3.5 w-3.5" />}
          title="Email Composer"
        />

        <div aria-hidden="true" className="pointer-events-none fixed left-[-10000px] top-0 z-[-1] w-[720px] overflow-hidden opacity-0" ref={richCopyRef} />
        {message ? <AdminCallout tone="success"><Check className="mt-0.5 h-4 w-4" />{message}</AdminCallout> : null}
        {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
            <div className="flex items-center justify-between bg-[#070b12] px-5 py-3.5">
              <p className="text-sm font-black text-white">New HR Email</p>
              <p className="text-xs font-bold text-[#94A3B8]">From: {form.senderName}</p>
            </div>

            <div className="border-b border-[#E8EDF3] px-5">
              <RecipientRow
                chips={form.toSelections}
                employees={options?.employeeOptions ?? []}
                extras={
                  <div className="flex shrink-0 gap-2 text-xs font-black text-[#64748B]">
                    {!showCc ? <button className="hover:text-[#0F172A]" onClick={() => setShowCc(true)} type="button">Cc</button> : null}
                    {!showBcc ? <button className="hover:text-[#0F172A]" onClick={() => setShowBcc(true)} type="button">Bcc</button> : null}
                  </div>
                }
                groups={options?.groups ?? []}
                label="To"
                onAdd={(selection) => addSelection("toSelections", selection)}
                onRemove={(index) => removeSelection("toSelections", index)}
                onSearch={(query) => void loadOptions(query)}
              />
              {showCc || form.ccSelections.length > 0 ? (
                <RecipientRow
                  chips={form.ccSelections}
                  employees={options?.employeeOptions ?? []}
                  groups={options?.groups ?? []}
                  label="Cc"
                  onAdd={(selection) => addSelection("ccSelections", selection)}
                  onRemove={(index) => removeSelection("ccSelections", index)}
                  onSearch={(query) => void loadOptions(query)}
                />
              ) : null}
              {showBcc || form.bccSelections.length > 0 ? (
                <RecipientRow
                  chips={form.bccSelections}
                  employees={options?.employeeOptions ?? []}
                  groups={options?.groups ?? []}
                  label="Bcc"
                  onAdd={(selection) => addSelection("bccSelections", selection)}
                  onRemove={(index) => removeSelection("bccSelections", index)}
                  onSearch={(query) => void loadOptions(query)}
                />
              ) : null}
            </div>

            <div className="flex items-center gap-3 border-b border-[#E8EDF3] px-5 py-1.5">
              <input
                className="h-10 w-full border-0 bg-transparent text-[15px] font-black text-[#0F172A] outline-none placeholder:font-semibold placeholder:text-[#94A3B8]"
                onChange={(event) => updateField("subject", event.target.value)}
                placeholder="Subject"
                value={form.subject}
              />
              <SearchableSelect
                className="h-9 shrink-0 rounded-lg border border-[#E2E8F0] bg-white px-2 text-xs font-black text-[#334155]"
                onChange={(event) => void applyTemplate(event.target.value)}
                value={form.templateKey}
              >
                <option value="">No template</option>
                {(options?.templates ?? []).map((template) => (
                  <option key={template.templateKey} value={template.templateKey}>{template.templateName}</option>
                ))}
              </SearchableSelect>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-b border-[#E8EDF3] px-5 py-2 text-sm">
              <span className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">Greeting</span>
              <span className="font-semibold text-[#334155]">Dear</span>
              <input
                className="h-8 w-48 rounded-lg border border-[#E2E8F0] bg-white px-2 text-sm font-bold text-[#0F172A] outline-none placeholder:text-[#94A3B8] focus:border-[#FDBA74]"
                onChange={(event) => updateField("recipientName", event.target.value)}
                placeholder="auto from recipient"
                value={form.recipientName}
              />
              <span className="font-semibold text-[#334155]">,</span>
            </div>

            <div className="border-b border-[#E8EDF3] bg-[#FFFBF7] px-5 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[#C2410C]" />
                <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">AI Assist</p>
              </div>
              <div className="mt-2 flex flex-col gap-2 md:flex-row">
                <Input
                  onChange={(event) => setAiInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runAiAssist();
                  }}
                  placeholder='e.g. "Reply that the vacation request is approved starting Sunday" or any Arabic instruction'
                  value={aiInstruction}
                />
                <Button className="shrink-0 bg-[#0F172A] text-white" disabled={busy} onClick={() => void runAiAssist()} type="button">
                  <Sparkles className="mr-2 h-4 w-4" />
                  {aiBusy ? "Thinking..." : "Draft with AI"}
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {["Translate to Arabic", "Make it shorter", "More formal", "More friendly"].map((quickAction) => (
                  <button
                    className="border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-bold text-[#334155] hover:border-[#FED7AA] hover:bg-[#FFF7ED] disabled:opacity-50"
                    disabled={busy}
                    key={quickAction}
                    onClick={() => void runAiAssist(quickAction)}
                    type="button"
                  >
                    {quickAction}
                  </button>
                ))}
              </div>
            </div>

            <EmailBodyEditor
              hiddenActions={["Action button"]}
              key={bodyVersion}
              onChange={updateBody}
              ref={bodyEditorRef}
              value={form.replyMessageHtml}
              variables={editorVariables}
            />

            {needsJustification ? (
              <div className="border-t border-[#E8EDF3] px-5 py-3">
                <Field label="External recipient justification">
                  <textarea
                    className="min-h-[80px] w-full rounded-xl border border-[#D8E0EA] px-3 py-2.5 text-sm"
                    onChange={(event) => updateField("externalJustification", event.target.value)}
                    placeholder="Example: Candidate offer communication approved by HR."
                    value={form.externalJustification}
                  />
                </Field>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E8EDF3] bg-[#F8FAFC] px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button className="h-10 rounded-xl bg-[#F97316] px-4 text-white" disabled={busy || policyIssues.length > 0 || !preview} onClick={sendEmail} type="button">
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  Send
                </Button>
                <Button className="h-10 rounded-xl border border-[#D8E0EA] bg-white px-3 text-[#0F172A]" disabled={busy} onClick={backendPreview} type="button" variant="secondary">
                  <Eye className="mr-2 h-4 w-4" />
                  Preview &amp; Check
                </Button>
                {!preview ? <span className="text-xs font-bold text-[#94A3B8]">Preview is required before sending.</span> : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">Tone</span>
                {(options?.tones ?? [
                  { label: "Formal", value: "professional" as PhoenixHrEmailTone },
                  { label: "Friendly", value: "warm" as PhoenixHrEmailTone },
                  { label: "Short", value: "concise" as PhoenixHrEmailTone },
                  { label: "Detailed", value: "firm" as PhoenixHrEmailTone },
                ]).map((tone) => (
                  <button
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-black",
                      form.tone === tone.value ? "border-[#FDBA74] bg-[#FFF7ED] text-[#9A3412]" : "border-[#E2E8F0] bg-white text-[#334155]",
                    )}
                    key={tone.value}
                    onClick={() => updateField("tone", tone.value)}
                    type="button"
                  >
                    {tone.label}
                  </button>
                ))}
              </div>
            </div>

            <details className="border-t border-[#E8EDF3] px-5 py-3">
              <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
                More options - sender name &amp; raw email lists
              </summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <Field label="Sender name">
                  <input
                    className="h-10 w-full rounded-xl border border-[#D8E0EA] bg-white px-3 text-sm font-semibold text-[#0F172A]"
                    onChange={(event) => updateField("senderName", event.target.value)}
                    value={form.senderName}
                  />
                </Field>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <RawEmailField label="Raw TO" onChange={(value) => updateField("to", value)} value={form.to} />
                <RawEmailField label="Raw CC" onChange={(value) => updateField("cc", value)} value={form.cc} />
                <RawEmailField label="Raw BCC" onChange={(value) => updateField("bcc", value)} value={form.bcc} />
              </div>
            </details>
          </Card>

          <div className="space-y-5">
            <Card className={cn(adminPanelClassName, "space-y-3 p-5")}>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Variables</p>
              {variablesAvailable ? (
                <>
                  <p className="text-xs leading-5 text-[#64748B]">Click to insert at the cursor. The backend fills values from the first selected employee.</p>
                  <div className="flex max-h-[260px] flex-wrap gap-2 overflow-auto">
                    {(options?.variables ?? []).map((variable) => (
                      <button
                        className="rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1.5 text-xs font-black text-[#C2410C]"
                        key={variable.token}
                        onClick={() => insertVariable(variable.token)}
                        title={`Stores {{${variable.token}}}. Example: ${variable.sampleValue}`}
                        type="button"
                      >
                        {variable.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm leading-6 text-[#64748B]">Choose an employee recipient first so the backend can fill variable values.</p>
              )}
            </Card>
            <PreviewChecklist preview={preview} />
          </div>
        </div>

        {preview?.html ? (
          <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
            <AdminSectionHeader
              action={
                <Button className="rounded-xl border border-[#D8E0EA] bg-white text-[#0F172A]" onClick={() => void copyRichEmail()} type="button" variant="secondary">
                  {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                  Copy
                </Button>
              }
              description="This is the backend-rendered email, exactly as recipients will see it."
              title="Final preview"
            />
            <div className="bg-[#EEF2F7] p-4">
              <iframe className="h-[680px] w-full rounded-xl border border-[#CBD5E1] bg-white" sandbox="" srcDoc={preview.html} title="Backend email preview" />
            </div>
          </Card>
        ) : null}

        <DeliveryAnalyticsPanel analytics={options?.analytics} />
      </div>
    </main>
  );
}

type RecipientSuggestion =
  | { description: string; kind: "email"; selection: RecipientSelection; title: string }
  | { description: string; kind: "employee"; selection: RecipientSelection; title: string }
  | { description: string; kind: "group"; selection: RecipientSelection; title: string };

function RecipientRow({
  chips,
  employees,
  extras,
  groups,
  label,
  onAdd,
  onRemove,
  onSearch,
}: {
  chips: RecipientSelection[];
  employees: EmployeeOption[];
  extras?: ReactNode;
  groups: GroupOption[];
  label: string;
  onAdd: (selection: RecipientSelection) => void;
  onRemove: (index: number) => void;
  onSearch: (query: string) => void;
}) {
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchTimerRef = useRef<number | null>(null);
  const blurTimerRef = useRef<number | null>(null);
  const listId = useId();

  const query = input.trim().toLowerCase();
  const suggestions = useMemo<RecipientSuggestion[]>(() => {
    if (!query) return [];
    const employeeItems = employees
      .filter((employee) => `${employee.label} ${employee.hrId} ${employee.email ?? ""} ${employee.departmentName ?? ""} ${employee.title ?? ""}`.toLowerCase().includes(query))
      .slice(0, 7)
      .map<RecipientSuggestion>((employee) => ({
        description: `${employee.email ?? "no email"} - ${employee.title ?? "No title"}`,
        kind: "employee",
        selection: { hrId: employee.hrId, label: employee.label, type: "employee" },
        title: employee.label,
      }));
    const groupItems = groups
      .filter((group) => `${group.label} ${group.description}`.toLowerCase().includes(query))
      .slice(0, 3)
      .map<RecipientSuggestion>((group) => ({
        description: group.description,
        kind: "group",
        selection: { key: group.key, label: group.label, type: "group" },
        title: `${group.label} (group)`,
      }));
    const emailCandidate = emailPattern.test(input.trim()) ? input.trim().toLowerCase() : null;
    const emailItems: RecipientSuggestion[] = emailCandidate
      ? [{
          description: "Send to this exact address",
          kind: "email",
          selection: { email: emailCandidate, label: emailCandidate, type: "email" },
          title: `Add email: ${emailCandidate}`,
        }]
      : [];
    return [...employeeItems, ...groupItems, ...emailItems];
  }, [employees, groups, input, query]);
  const showDropdown = focused && query.length > 0;
  const clampedActiveIndex = Math.min(activeIndex, Math.max(0, suggestions.length - 1));

  function add(selection: RecipientSelection) {
    onAdd(selection);
    setInput("");
    setActiveIndex(0);
  }

  function handleInput(value: string) {
    setInput(value);
    setActiveIndex(0);
    // Local filtering is instant; a debounced server search widens the employee pool
    // beyond the initially loaded page when the admin keeps typing.
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
      searchTimerRef.current = window.setTimeout(() => onSearch(trimmed), 350);
    }
  }

  return (
    <div className="relative flex min-h-[46px] flex-wrap items-center gap-1.5 border-b border-[#F1F5F9] py-2 last:border-b-0">
      <span className="w-8 shrink-0 text-xs font-black uppercase tracking-[0.14em] text-[#64748B]" id={`${listId}-label`}>{label}</span>
      {chips.map((selection, index) => (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-black",
            selection.type === "group" ? "border-[#C7D2FE] bg-[#EEF2FF] text-[#3730A3]" : "border-[#CBD5E1] bg-white text-[#0F172A]",
          )}
          key={`${label}-${index}`}
        >
          {selectionDisplayLabel(selection)}
          <button aria-label={`Remove ${selectionDisplayLabel(selection)}`} className="text-[#94A3B8] hover:text-[#DC2626]" onClick={() => onRemove(index)} type="button">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        aria-activedescendant={showDropdown && suggestions.length > 0 ? `${listId}-option-${clampedActiveIndex}` : undefined}
        aria-controls={listId}
        aria-expanded={showDropdown}
        aria-labelledby={`${listId}-label`}
        className="h-8 min-w-[180px] flex-1 border-0 bg-transparent text-sm font-semibold text-[#0F172A] outline-none placeholder:text-[#94A3B8]"
        onBlur={() => {
          blurTimerRef.current = window.setTimeout(() => setFocused(false), 150);
        }}
        onChange={(event) => handleInput(event.target.value)}
        onFocus={() => {
          // A pending close from a just-blurred state must not hide the dropdown the
          // admin re-focused into.
          if (blurTimerRef.current) window.clearTimeout(blurTimerRef.current);
          setFocused(true);
        }}
        onKeyDown={(event) => {
          // Mid-IME-composition Enter/arrow keys commit the composition, not the chip.
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" && suggestions.length > 0) {
            event.preventDefault();
            setActiveIndex((current) => Math.min(current + 1, suggestions.length - 1));
            return;
          }
          if (event.key === "ArrowUp" && suggestions.length > 0) {
            event.preventDefault();
            setActiveIndex((current) => Math.max(current - 1, 0));
            return;
          }
          if (event.key === "Escape") {
            setFocused(false);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const target = suggestions[clampedActiveIndex];
            if (target) add(target.selection);
            return;
          }
          if (event.key === "Backspace" && input.length === 0 && chips.length > 0) onRemove(chips.length - 1);
        }}
        placeholder={chips.length === 0 ? "Type a name, HR ID, group, or email address" : ""}
        role="combobox"
        value={input}
      />
      {extras}
      {showDropdown ? (
        <div className="absolute left-8 top-full z-20 mt-1 w-[min(420px,90%)] overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-lg" id={listId} role="listbox">
          {suggestions.map((suggestion, index) => (
            <button
              aria-selected={index === clampedActiveIndex}
              className={cn(
                "block w-full px-3 py-2 text-left",
                suggestion.kind === "group" ? "hover:bg-[#EEF2FF]" : suggestion.kind === "email" ? "hover:bg-[#F0FDF4]" : "hover:bg-[#FFF7ED]",
                index === clampedActiveIndex ? "bg-[#F8FAFC]" : "",
              )}
              id={`${listId}-option-${index}`}
              key={`${suggestion.kind}-${suggestion.title}`}
              onClick={() => add(suggestion.selection)}
              onMouseDown={(event) => event.preventDefault()}
              role="option"
              type="button"
            >
              <span className={cn(
                "block text-sm font-black",
                suggestion.kind === "group" ? "text-[#3730A3]" : suggestion.kind === "email" ? "text-[#166534]" : "text-[#0F172A]",
              )}>
                {suggestion.title}
              </span>
              <span className="block text-xs text-[#64748B]">{suggestion.description}</span>
            </button>
          ))}
          {suggestions.length === 0 ? (
            <p className="px-3 py-2 text-sm text-[#94A3B8]">No matches. Type a full email address to add it directly.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">{label}</span>
      {children}
    </label>
  );
}

function RawEmailField({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <Field label={label}>
      <textarea
        className="min-h-[72px] w-full rounded-xl border border-[#D8E0EA] bg-white px-3 py-2 text-sm text-[#0F172A]"
        onChange={(event) => onChange(event.target.value)}
        placeholder="email@satopharma.com"
        value={value}
      />
    </Field>
  );
}

function PreviewChecklist({ preview }: { preview: PreviewState | null }) {
  return (
    <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
      <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Backend checks</p>
      {preview ? (
        <>
          <div className={cn(adminSoftPanelClassName, "grid gap-3 p-3 md:grid-cols-2")}>
            <Metric label="Recipients" value={String(preview.recipientPolicy.totalRecipients)} />
            <Metric label="External" value={String(preview.recipientPolicy.externalRecipients.length)} />
          </div>
          {preview.warnings.length > 0 ? preview.warnings.map((warning) => (
            <div className="rounded-xl border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-sm font-semibold text-[#9A3412]" key={warning}>
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              {warning}
            </div>
          )) : <div className="rounded-xl border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-sm font-semibold text-[#166534]">All backend checks passed. Ready to send.</div>}
          <RecipientBucket label="TO" recipients={preview.recipients.to} />
          <RecipientBucket label="CC" recipients={preview.recipients.cc} />
          <RecipientBucket label="BCC" recipients={preview.recipients.bcc} />
        </>
      ) : (
        <p className="text-sm leading-6 text-[#64748B]">
          Run <strong>Preview &amp; Check</strong> to resolve recipients, validate the policy, and render the final email exactly as it will be sent.
        </p>
      )}
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
    <details className="group">
      <summary className="flex cursor-pointer items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
        <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
        Delivery analytics - last 30 days
      </summary>
      <Card className={cn(adminPanelClassName, "mt-3 p-4")}>
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
    </details>
  );
}

function RecipientBucket({ label, recipients }: { label: string; recipients: Array<{ email: string; label: string; source: string }> }) {
  if (recipients.length === 0) return null;
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">{label} ({recipients.length})</p>
      <div className="mt-2 space-y-2">
        {recipients.map((recipient) => (
          <div className="rounded-lg bg-[#F8FAFC] px-2.5 py-2" key={`${label}-${recipient.email}`}>
            <p className="truncate text-sm font-bold text-[#0F172A]">{recipient.email}</p>
            <p className="truncate text-xs font-semibold text-[#64748B]">{recipient.source}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
