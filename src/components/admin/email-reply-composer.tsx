"use client";

import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, Clipboard, Code2, Copy, Loader2, Mail, Send, Sparkles } from "lucide-react";

import {
  AdminInsightChip,
  AdminPageHero,
  AdminSectionHeader,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { systemIdentity } from "@/config/system-settings";
import {
  buildPhoenixHrReplyEmail,
  type PhoenixHrEmailTone,
} from "@/lib/email/phoenix-hr-reply-template";
import { cn } from "@/lib/utils";

type CopyTarget = "html" | "plain" | "rich";

type ComposerState = {
  bcc: string;
  cc: string;
  recipientName: string;
  replyMessage: string;
  senderName: string;
  subject: string;
  to: string;
  tone: PhoenixHrEmailTone;
};

const defaultComposerState: ComposerState = {
  bcc: "",
  cc: "",
  recipientName: "Omar",
  replyMessage:
    "Thank you for your email.\n\nWe have reviewed your request and will proceed according to the HR process. Please share any missing details or supporting documents if required.",
  senderName: systemIdentity.hrSignatureName,
  subject: "Re: HR Request",
  to: "omar.anwar@satopharma.com",
  tone: "professional",
};

const inputClassName =
  "h-11 w-full rounded-xl border border-[#D8E0EA] bg-white px-3 text-sm font-semibold text-[#0F172A] outline-none transition placeholder:text-[#94A3B8] focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";

const textareaClassName =
  "min-h-[190px] w-full resize-y rounded-xl border border-[#D8E0EA] bg-white px-3 py-3 text-sm font-medium leading-6 text-[#0F172A] outline-none transition placeholder:text-[#94A3B8] focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";

const toneOptions: Array<{
  description: string;
  label: string;
  value: PhoenixHrEmailTone;
}> = [
  {
    description: "Balanced HR response for most internal or external cases.",
    label: "Professional",
    value: "professional",
  },
  {
    description: "Softer wording for support, follow-up, and employee care.",
    label: "Warm",
    value: "warm",
  },
  {
    description: "Clearer official wording for deadlines and policy matters.",
    label: "Firm",
    value: "firm",
  },
  {
    description: "Short reply with minimal supporting language.",
    label: "Concise",
    value: "concise",
  },
];

function htmlDocumentToCopyFragment(html: string) {
  const bodyMatch = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  const bodyAttributes = bodyMatch?.[1] ?? "";
  const bodyHtml = bodyMatch?.[2] ?? html;
  const bodyStyle = bodyAttributes.match(/style="([^"]*)"/i)?.[1] ?? "";
  const wrapperStyle =
    bodyStyle ||
    "margin:0;background:#eef2f7;padding:28px 14px;font-family:Arial,Helvetica,sans-serif;color:#0f172a";

  return `<div style="${wrapperStyle}">${bodyHtml}</div>`;
}

function FieldLabel({
  children,
  optional,
}: {
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <span className="mb-1.5 flex items-center justify-between gap-3 text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
      <span>{children}</span>
      {optional ? <span className="text-[10px] tracking-[0.12em] text-[#94A3B8]">Optional</span> : null}
    </span>
  );
}

function splitEmailList(value: string) {
  return value
    .split(/[;,\n\r]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

export function EmailReplyComposer() {
  const [form, setForm] = useState<ComposerState>(defaultComposerState);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const richCopyRef = useRef<HTMLDivElement>(null);
  const generated = useMemo(() => buildPhoenixHrReplyEmail(form), [form]);
  const previewHtml = generated.html;
  const richCopyHtml = useMemo(() => htmlDocumentToCopyFragment(previewHtml), [previewHtml]);
  const toCount = splitEmailList(form.to).length;
  const ccCount = splitEmailList(form.cc).length;
  const bccCount = splitEmailList(form.bcc).length;

  function updateField<Key extends keyof ComposerState>(key: Key, value: ComposerState[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function htmlForCopy() {
    return generated.html;
  }

  async function copyRichRenderedEmail() {
    const html = htmlForCopy();

    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([generated.plainText], { type: "text/plain" }),
        }),
      ]);
      return;
    }

    const copyNode = richCopyRef.current;

    if (!copyNode) {
      throw new Error("The rendered email is not ready to copy.");
    }

    copyNode.innerHTML = htmlDocumentToCopyFragment(html);

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(copyNode);
    selection?.removeAllRanges();
    selection?.addRange(range);

    try {
      const copiedFromDom = document.execCommand("copy");
      if (copiedFromDom) return;
      throw new Error("Rich email copy is not available in this browser.");
    } finally {
      selection?.removeAllRanges();
    }
  }

  async function copyToClipboard(target: CopyTarget) {
    try {
      if (target === "rich") {
        await copyRichRenderedEmail();
        setCopyError(null);
        setCopied(target);
        window.setTimeout(() => setCopied(null), 1800);
        return;
      }

      const html = target === "plain" ? generated.html : htmlForCopy();

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(target === "plain" ? generated.plainText : html);
      } else {
        throw new Error("Clipboard access is not available in this browser.");
      }

      setCopyError(null);
      setCopied(target);
      window.setTimeout(() => setCopied(null), 1800);
    } catch (error) {
      setCopied(null);
      setCopyError(error instanceof Error ? error.message : "Copy failed.");
    }
  }

  async function sendEmail() {
    setSending(true);
    setSendError(null);
    setSendResult(null);

    try {
      const response = await fetch("/api/admin/email-reply/send", {
        body: JSON.stringify(form),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        message?: string;
        result?: { id?: string; reason?: string; skipped?: boolean };
      } | null;

      if (!response.ok) {
        throw new Error(payload?.message ?? "Email send failed.");
      }

      if (payload?.result?.skipped) {
        setSendError(payload.result.reason ?? "Email sending is not configured.");
        return;
      }

      setSendResult(
        payload?.result?.id
          ? `Email accepted by provider. Resend ID: ${payload.result.id}`
          : "Email accepted by provider.",
      );
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Email send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={
          <>
            <Button
              className="h-11 rounded-xl bg-[#0F172A] px-4 text-white hover:bg-[#111827]"
              onClick={() => void copyToClipboard("rich")}
            >
              {copied === "rich" ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
              Copy Rich Email
            </Button>
            <Button
              className="h-11 rounded-xl bg-[#F97316] px-4 text-white hover:bg-[#EA580C]"
              disabled={sending}
              onClick={() => void sendEmail()}
            >
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Send Email
            </Button>
            <Button
              className="h-11 rounded-xl border border-[#D8E0EA] bg-white px-4 text-[#0F172A] hover:bg-[#F8FAFC]"
              onClick={() => void copyToClipboard("html")}
              variant="secondary"
            >
              {copied === "html" ? <Check className="mr-2 h-4 w-4" /> : <Code2 className="mr-2 h-4 w-4" />}
              Copy HTML
            </Button>
          </>
        }
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip tone="orange">Phoenix HR template</AdminInsightChip>
            <AdminInsightChip>Direct send enabled</AdminInsightChip>
            <AdminInsightChip tone="slate">Copy-ready HTML</AdminInsightChip>
          </div>
        }
        description="Write the reply once, wrap it in the Phoenix HR email template, then copy it into Outlook, Gmail, or any email client."
        eyebrow="HR Communications"
        icon={<Mail className="h-3.5 w-3.5" />}
        title="Email Reply Composer"
      />

      <div
        aria-hidden="true"
        className="pointer-events-none fixed left-[-10000px] top-0 z-[-1] w-[720px] overflow-hidden opacity-0"
        dangerouslySetInnerHTML={{ __html: richCopyHtml }}
        ref={richCopyRef}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(420px,0.82fr)_minmax(520px,1fr)]">
        <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
          <AdminSectionHeader
            description="Fill the recipients and reply message. Use commas, semicolons, or new lines for multiple To/CC/BCC addresses."
            title="Composer"
          />

          <div className="space-y-5 p-5">
            <div className="grid gap-4 xl:grid-cols-3">
              <label className="block">
                <FieldLabel>To</FieldLabel>
                <input
                  className={inputClassName}
                  onChange={(event) => updateField("to", event.target.value)}
                  placeholder="person1@company.com, person2@company.com"
                  type="text"
                  value={form.to}
                />
                <span className="mt-1.5 block text-xs font-semibold text-[#64748B]">
                  {toCount > 0 ? `${toCount} recipient${toCount === 1 ? "" : "s"}` : "Add one or more recipients."}
                </span>
              </label>

              <label className="block">
                <FieldLabel optional>CC</FieldLabel>
                <input
                  className={inputClassName}
                  onChange={(event) => updateField("cc", event.target.value)}
                  placeholder="cc1@company.com; cc2@company.com"
                  type="text"
                  value={form.cc}
                />
                <span className="mt-1.5 block text-xs font-semibold text-[#64748B]">
                  {ccCount > 0 ? `${ccCount} copied recipient${ccCount === 1 ? "" : "s"}` : "Optional copied recipients."}
                </span>
              </label>

              <label className="block">
                <FieldLabel optional>BCC</FieldLabel>
                <input
                  className={inputClassName}
                  onChange={(event) => updateField("bcc", event.target.value)}
                  placeholder="hidden1@company.com, hidden2@company.com"
                  type="text"
                  value={form.bcc}
                />
                <span className="mt-1.5 block text-xs font-semibold text-[#64748B]">
                  {bccCount > 0
                    ? `${bccCount} blind copied recipient${bccCount === 1 ? "" : "s"}`
                    : "Optional hidden recipients."}
                </span>
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <FieldLabel optional>Recipient name</FieldLabel>
                <input
                  className={inputClassName}
                  onChange={(event) => updateField("recipientName", event.target.value)}
                  placeholder="Omar"
                  type="text"
                  value={form.recipientName}
                />
              </label>

              <label className="block">
                <FieldLabel optional>Signature name</FieldLabel>
                <input
                  className={inputClassName}
                  onChange={(event) => updateField("senderName", event.target.value)}
                  placeholder={systemIdentity.hrSignatureName}
                  type="text"
                  value={form.senderName}
                />
              </label>
            </div>

            <label className="block">
              <FieldLabel>Subject</FieldLabel>
              <input
                className={inputClassName}
                onChange={(event) => updateField("subject", event.target.value)}
                placeholder="Re: HR Request"
                type="text"
                value={form.subject}
              />
            </label>

            <label className="block">
              <FieldLabel>Reply message</FieldLabel>
              <textarea
                className={textareaClassName}
                onChange={(event) => updateField("replyMessage", event.target.value)}
                placeholder="Write or paste the reply body here..."
                value={form.replyMessage}
              />
            </label>

            <div>
              <FieldLabel>Tone</FieldLabel>
              <div className="grid gap-2 md:grid-cols-2">
                {toneOptions.map((tone) => {
                  const active = form.tone === tone.value;

                  return (
                    <button
                      className={cn(
                        "rounded-xl border px-3 py-3 text-left transition",
                        active
                          ? "border-[#FDBA74] bg-[#FFF7ED] shadow-[0_8px_18px_rgba(249,115,22,0.10)]"
                          : "border-[#E2E8F0] bg-white hover:border-[#FDBA74] hover:bg-[#FFF7ED]/45",
                      )}
                      key={tone.value}
                      onClick={() => updateField("tone", tone.value)}
                      type="button"
                    >
                      <span className="block text-sm font-black text-[#0F172A]">{tone.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-[#64748B]">{tone.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>

        <div className="space-y-6">
          <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
            <AdminSectionHeader
              action={
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="h-10 rounded-xl bg-[#F97316] px-4 text-white hover:bg-[#EA580C]"
                    onClick={() => void copyToClipboard("rich")}
                  >
                    {copied === "rich" ? <Check className="mr-2 h-4 w-4" /> : <Clipboard className="mr-2 h-4 w-4" />}
                    Copy for Email
                  </Button>
                  <Button
                    className="h-10 rounded-xl border border-[#D8E0EA] bg-white px-4 text-[#0F172A] hover:bg-[#F8FAFC]"
                    onClick={() => void copyToClipboard("plain")}
                    variant="secondary"
                  >
                    {copied === "plain" ? <Check className="mr-2 h-4 w-4" /> : <Send className="mr-2 h-4 w-4" />}
                    Copy Text
                  </Button>
                </div>
              }
              description="This preview is the email body that will be copied. Paste it into a reply window and send from the mailbox."
              title="Live Preview"
            />
            <div className="bg-[#EEF2F7] p-4">
              {copyError ? (
                <div className="mb-3 rounded-xl border border-[#FCA5A5] bg-[#FEF2F2] px-4 py-3 text-sm font-semibold text-[#B91C1C]">
                  {copyError}
                </div>
              ) : null}
              {sendError ? (
                <div className="mb-3 rounded-xl border border-[#FCA5A5] bg-[#FEF2F2] px-4 py-3 text-sm font-semibold text-[#B91C1C]">
                  {sendError}
                </div>
              ) : null}
              {sendResult ? (
                <div className="mb-3 rounded-xl border border-[#86EFAC] bg-[#F0FDF4] px-4 py-3 text-sm font-semibold text-[#166534]">
                  {sendResult}
                </div>
              ) : null}
              <iframe
                className="h-[720px] w-full rounded-[18px] border border-[#CBD5E1] bg-white shadow-[0_18px_42px_rgba(15,23,42,0.10)]"
                sandbox="allow-same-origin"
                srcDoc={previewHtml}
                title="Phoenix HR email preview"
              />
            </div>
          </Card>

          <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
            <AdminSectionHeader
              description="Raw email-safe HTML for systems that accept HTML templates."
              title="Generated HTML"
            />
            <div className="border-t border-[#E2E8F0] bg-[#0B1120] p-4">
              <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[#020617] p-4 text-xs leading-5 text-[#D4DDE8]">
                {generated.html}
              </pre>
            </div>
          </Card>

          <Card className={cn(adminPanelClassName, "p-5")}>
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#FFF7ED] text-[#F97316]">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-black text-[#0F172A]">Practical workflow</p>
                <p className="mt-1 text-sm leading-6 text-[#64748B]">
                  Use Send Email for the most reliable layout. Copy/paste still depends on how Gmail or Outlook cleans pasted HTML.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
