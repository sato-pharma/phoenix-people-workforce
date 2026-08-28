"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Mail, RefreshCw, Search, Send, XCircle } from "lucide-react";

import { systemUiText } from "@/config/system-settings";
import { cn } from "@/lib/utils";
import { useDismissOnOutsideInteraction } from "@/hooks/use-dismiss-on-outside-interaction";

type InternalEmailStatus = "failed" | "not_requested" | "pending" | "sent" | "skipped";

type InternalMessageView = {
  body: string;
  createdAt: string;
  direction: "inbox" | "sent";
  emailError: string | null;
  emailProviderId: string | null;
  emailStatus: InternalEmailStatus;
  id: string;
  readAt: string | null;
  recipient: {
    email: string | null;
    hrId: string | null;
    loginId: string | null;
    name: string;
  };
  sender: {
    hrId: string | null;
    loginId: string | null;
    name: string;
  };
  subject: string;
};

type InternalRecipientView = {
  email: string | null;
  hrId: string | null;
  id: string;
  label: string;
  loginId: string | null;
  name: string;
  role: string | null;
};

type MessagesResponse = {
  messages?: InternalMessageView[];
  unreadCount?: number;
};

const emptyForm = {
  body: "",
  recipient: "",
  sendEmail: false,
  subject: "",
};

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Now";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(date);
}

function emailStatusText(status: InternalEmailStatus, error: string | null) {
  if (status === "sent") return "Email sent";
  if (status === "pending") return "Email pending";
  if (status === "skipped") return error || "Email skipped";
  if (status === "failed") return error || "Email failed";
  return "Internal only";
}

export function InternalMessagesMenu({ isAdminMode }: { isAdminMode: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<InternalMessageView[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [recipientQuery, setRecipientQuery] = useState("");
  const [recipients, setRecipients] = useState<InternalRecipientView[]>([]);
  const [recipientLoading, setRecipientLoading] = useState(false);
  const inboxMessages = useMemo(() => messages.filter((message) => message.direction === "inbox"), [messages]);
  const sentMessages = useMemo(() => messages.filter((message) => message.direction === "sent"), [messages]);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/messages", { headers: { Accept: "application/json" } });
      const payload = (await response.json().catch(() => ({}))) as MessagesResponse & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Messages failed to load.");
      setMessages(payload.messages ?? []);
      setUnreadCount(payload.unreadCount ?? 0);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Messages failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timeoutId = window.setTimeout(() => void loadMessages(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadMessages, open]);

  useDismissOnOutsideInteraction(containerRef, open, setOpen);

  useEffect(() => {
    if (!open || recipientQuery.trim().length < 2) {
      const timeoutId = window.setTimeout(() => setRecipients([]), 0);
      return () => window.clearTimeout(timeoutId);
    }

    let active = true;
    const timeoutId = window.setTimeout(async () => {
      setRecipientLoading(true);
      try {
        const response = await fetch(`/api/messages/recipients?q=${encodeURIComponent(recipientQuery)}`, {
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json().catch(() => ({}))) as { data?: InternalRecipientView[] };
        if (active) setRecipients(response.ok ? payload.data ?? [] : []);
      } catch {
        if (active) setRecipients([]);
      } finally {
        if (active) setRecipientLoading(false);
      }
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [open, recipientQuery]);

  function selectRecipient(recipient: InternalRecipientView) {
    setForm((current) => ({ ...current, recipient: recipient.hrId || recipient.loginId || recipient.email || recipient.id }));
    setRecipientQuery(recipient.label);
    setRecipients([]);
  }

  async function sendMessage() {
    setSending(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch("/api/messages", {
        body: JSON.stringify(form),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };

      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Message send failed.");
      }

      setForm(emptyForm);
      setRecipientQuery("");
      setSuccess("Message sent internally. Email delivery was attempted when configured.");
      await loadMessages();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Message send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-label="Messages"
        className={`relative hidden h-9 w-9 items-center justify-center rounded sm:inline-flex ${
          isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink"
        }`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Mail className="h-[18px] w-[18px]" />
        {unreadCount > 0 ? (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded bg-phx-accent px-1 text-phx-3xs font-black text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className={cn(
            "absolute right-0 top-full z-30 mt-1.5 grid w-[min(760px,calc(100vw-2rem))] overflow-hidden rounded border shadow-lg xl:grid-cols-[0.95fr_1.05fr]",
            isAdminMode ? "border-[#333333] bg-[#050505]" : "border-phx-line bg-white",
          )}
        >
          <section className={cn("border-r", isAdminMode ? "border-[#333333]" : "border-phx-line")}>
            <div className={cn("flex items-start justify-between gap-3 border-b px-4 py-3", isAdminMode ? "border-[#333333]" : "border-phx-line")}>
              <div>
                <p className={cn("text-sm font-black", isAdminMode ? "text-white" : "text-phx-ink")}>Internal Messages</p>
                <p className={cn("mt-1 text-xs", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>
                  Inbox and sent messages for this account.
                </p>
              </div>
              <button
                aria-label="Refresh messages"
                className={cn("flex h-8 w-8 items-center justify-center rounded", isAdminMode ? "text-phx-ink-faint hover:bg-[#111111]" : "text-phx-ink-soft hover:bg-phx-paper")}
                onClick={() => void loadMessages()}
                type="button"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </button>
            </div>

            <div className="max-h-[520px] overflow-auto p-3">
              {error ? (
                <div className="mb-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                  {error}
                </div>
              ) : null}
              {success ? (
                <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
                  {success}
                </div>
              ) : null}

              <div className="mb-2 flex items-center gap-2">
                <span className="rounded bg-phx-accent-soft px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-accent-press">
                  Inbox {inboxMessages.length}
                </span>
                <span className={cn("rounded px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.12em]", isAdminMode ? "bg-[#111111] text-phx-ink-faint" : "bg-phx-paper text-phx-ink-soft")}>
                  Sent {sentMessages.length}
                </span>
              </div>

              {messages.length === 0 ? (
                <div className={cn("rounded px-4 py-8 text-center text-sm", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>
                  {loading ? "Loading messages..." : "No internal messages yet."}
                </div>
              ) : (
                <div className="space-y-2">
                  {messages.map((message) => (
                    <article
                      className={cn(
                        "rounded border px-3 py-2.5",
                        isAdminMode ? "border-[#1f2937] bg-[#0B0B0B]" : "border-phx-line bg-[#FCFDFE]",
                      )}
                      key={message.id}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className={cn("whitespace-nowrap text-sm font-black", isAdminMode ? "text-white" : "text-phx-ink")}>{message.subject}</p>
                          <p className={cn("mt-1 text-xs", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>
                            {message.direction === "inbox" ? `From ${message.sender.name}` : `To ${message.recipient.name}`}
                          </p>
                        </div>
                        <span className="shrink-0 rounded bg-phx-accent-soft px-2 py-0.5 text-phx-2xs font-black uppercase text-phx-accent-press">
                          {message.direction}
                        </span>
                      </div>
                      <p className={cn("mt-2 line-clamp-2 text-xs leading-5", isAdminMode ? "text-phx-line-strong" : "text-phx-ink-2")}>{message.body}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-phx-xs">
                        <span className={isAdminMode ? "text-phx-ink-soft" : "text-phx-ink-faint"}>{formatMessageTime(message.createdAt)}</span>
                        <span className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 font-bold", message.emailStatus === "sent" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>
                          {message.emailStatus === "sent" ? <CheckCircle2 className="h-3 w-3" /> : message.emailStatus === "failed" ? <XCircle className="h-3 w-3" /> : null}
                          {emailStatusText(message.emailStatus, message.emailError)}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="p-4">
            <p className={cn("text-sm font-black", isAdminMode ? "text-white" : "text-phx-ink")}>Send Message</p>
            <p className={cn("mt-1 text-xs", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>
              {systemUiText.internalMessageComposerDescription}
            </p>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className={cn("mb-1 block text-phx-2xs font-black uppercase tracking-[0.12em]", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>Recipient</span>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-faint" />
                  <input
                    className={cn(
                      "h-10 w-full rounded border pl-9 pr-3 text-sm font-semibold outline-none",
                      isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-phx-accent" : "border-phx-line bg-white text-phx-ink focus:border-phx-accent-line",
                    )}
                    onChange={(event) => {
                      const value = event.target.value;
                      setRecipientQuery(value);
                      setForm((current) => ({ ...current, recipient: value }));
                    }}
                    placeholder="Search name, HR ID, login, or email"
                    value={recipientQuery}
                  />
                  {recipientLoading ? <Loader2 className="absolute right-3 top-3.5 h-4 w-4 animate-spin text-phx-accent" /> : null}
                </div>
                {recipients.length > 0 ? (
                  <div className={cn("mt-2 max-h-40 overflow-auto rounded border p-1", isAdminMode ? "border-[#333333] bg-[#0B0B0B]" : "border-phx-line bg-white")}>
                    {recipients.map((recipient) => (
                      <button
                        className={cn("block w-full rounded px-3 py-2 text-left text-xs font-semibold", isAdminMode ? "text-[#D4DDE8] hover:bg-[#111111]" : "text-phx-ink hover:bg-phx-paper")}
                        key={recipient.id}
                        onClick={() => selectRecipient(recipient)}
                        type="button"
                      >
                        {recipient.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </label>

              <label className="block">
                <span className={cn("mb-1 block text-phx-2xs font-black uppercase tracking-[0.12em]", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>Subject</span>
                <input
                  className={cn("h-10 w-full rounded border px-3 text-sm font-semibold outline-none", isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-phx-accent" : "border-phx-line bg-white text-phx-ink focus:border-phx-accent-line")}
                  onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))}
                  placeholder="Message subject"
                  value={form.subject}
                />
              </label>

              <label className="block">
                <span className={cn("mb-1 block text-phx-2xs font-black uppercase tracking-[0.12em]", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>Message</span>
                <textarea
                  className={cn("min-h-28 w-full resize-y rounded border px-3 py-2.5 text-sm font-medium leading-6 outline-none", isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-phx-accent" : "border-phx-line bg-white text-phx-ink focus:border-phx-accent-line")}
                  onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
                  placeholder="Write the internal message..."
                  value={form.body}
                />
              </label>

              <label className={cn("flex items-center gap-2 rounded border px-3 py-2 text-xs font-bold", isAdminMode ? "border-[#333333] text-[#D4DDE8]" : "border-phx-line text-phx-ink-2")}>
                <input
                  checked={form.sendEmail}
                  className="h-4 w-4 accent-phx-accent"
                  onChange={(event) => setForm((current) => ({ ...current, sendEmail: event.target.checked }))}
                  type="checkbox"
                />
                Also send as email when recipient email exists
              </label>

              <button
                className="inline-flex h-10 w-full items-center justify-center rounded bg-phx-accent px-4 text-sm font-black text-white transition hover:bg-phx-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                disabled={sending}
                onClick={() => void sendMessage()}
                type="button"
              >
                {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send Message
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
