"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Mail, RefreshCw, Search, Send, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

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
  sendEmail: true,
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
    <div className="relative">
      <button
        aria-expanded={open}
        aria-label="Messages"
        className={`relative inline-flex h-10 w-10 items-center justify-center rounded-lg ${
          isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
        }`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Mail className="h-5 w-5" />
        {unreadCount > 0 ? (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#F97316] px-1 text-[9px] font-black text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className={cn(
            "absolute right-0 top-full z-30 mt-2 grid w-[min(760px,calc(100vw-2rem))] overflow-hidden rounded-[20px] border shadow-2xl xl:grid-cols-[0.95fr_1.05fr]",
            isAdminMode ? "border-[#333333] bg-[#050505]" : "border-[#E2E8F0] bg-white",
          )}
        >
          <section className={cn("border-r", isAdminMode ? "border-[#333333]" : "border-[#E2E8F0]")}>
            <div className={cn("flex items-start justify-between gap-3 border-b px-4 py-3", isAdminMode ? "border-[#333333]" : "border-[#E2E8F0]")}>
              <div>
                <p className={cn("text-sm font-black", isAdminMode ? "text-white" : "text-[#0F172A]")}>Internal Messages</p>
                <p className={cn("mt-1 text-xs", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
                  Inbox and sent messages for this account.
                </p>
              </div>
              <button
                aria-label="Refresh messages"
                className={cn("flex h-8 w-8 items-center justify-center rounded-lg", isAdminMode ? "text-[#94A3B8] hover:bg-[#111111]" : "text-[#64748B] hover:bg-[#F8FAFC]")}
                onClick={() => void loadMessages()}
                type="button"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </button>
            </div>

            <div className="max-h-[520px] overflow-auto p-3">
              {error ? (
                <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                  {error}
                </div>
              ) : null}
              {success ? (
                <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
                  {success}
                </div>
              ) : null}

              <div className="mb-2 flex items-center gap-2">
                <span className="rounded-full bg-[#FFF7ED] px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-[#C2410C]">
                  Inbox {inboxMessages.length}
                </span>
                <span className={cn("rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em]", isAdminMode ? "bg-[#111111] text-[#94A3B8]" : "bg-[#F8FAFC] text-[#64748B]")}>
                  Sent {sentMessages.length}
                </span>
              </div>

              {messages.length === 0 ? (
                <div className={cn("rounded-xl px-4 py-8 text-center text-sm", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
                  {loading ? "Loading messages..." : "No internal messages yet."}
                </div>
              ) : (
                <div className="space-y-2">
                  {messages.map((message) => (
                    <article
                      className={cn(
                        "rounded-2xl border px-3 py-3",
                        isAdminMode ? "border-[#1f2937] bg-[#0B0B0B]" : "border-[#E2E8F0] bg-[#FCFDFE]",
                      )}
                      key={message.id}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className={cn("truncate text-sm font-black", isAdminMode ? "text-white" : "text-[#0F172A]")}>{message.subject}</p>
                          <p className={cn("mt-1 text-xs", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
                            {message.direction === "inbox" ? `From ${message.sender.name}` : `To ${message.recipient.name}`}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-[#FFF7ED] px-2 py-0.5 text-[10px] font-black uppercase text-[#C2410C]">
                          {message.direction}
                        </span>
                      </div>
                      <p className={cn("mt-2 line-clamp-2 text-xs leading-5", isAdminMode ? "text-[#CBD5E1]" : "text-[#475569]")}>{message.body}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                        <span className={isAdminMode ? "text-[#64748B]" : "text-[#94A3B8]"}>{formatMessageTime(message.createdAt)}</span>
                        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-bold", message.emailStatus === "sent" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>
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
            <p className={cn("text-sm font-black", isAdminMode ? "text-white" : "text-[#0F172A]")}>Send Message</p>
            <p className={cn("mt-1 text-xs", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
              Send inside Phoenix Workforce and optionally email the recipient.
            </p>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className={cn("mb-1 block text-[10px] font-black uppercase tracking-[0.12em]", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>Recipient</span>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" />
                  <input
                    className={cn(
                      "h-11 w-full rounded-xl border pl-9 pr-3 text-sm font-semibold outline-none",
                      isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-[#F97316]" : "border-[#E2E8F0] bg-white text-[#0F172A] focus:border-[#FDBA74]",
                    )}
                    onChange={(event) => {
                      const value = event.target.value;
                      setRecipientQuery(value);
                      setForm((current) => ({ ...current, recipient: value }));
                    }}
                    placeholder="Search name, HR ID, login, or email"
                    value={recipientQuery}
                  />
                  {recipientLoading ? <Loader2 className="absolute right-3 top-3.5 h-4 w-4 animate-spin text-[#F97316]" /> : null}
                </div>
                {recipients.length > 0 ? (
                  <div className={cn("mt-2 max-h-40 overflow-auto rounded-xl border p-1", isAdminMode ? "border-[#333333] bg-[#0B0B0B]" : "border-[#E2E8F0] bg-white")}>
                    {recipients.map((recipient) => (
                      <button
                        className={cn("block w-full rounded-lg px-3 py-2 text-left text-xs font-semibold", isAdminMode ? "text-[#D4DDE8] hover:bg-[#111111]" : "text-[#0F172A] hover:bg-[#F8FAFC]")}
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
                <span className={cn("mb-1 block text-[10px] font-black uppercase tracking-[0.12em]", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>Subject</span>
                <input
                  className={cn("h-11 w-full rounded-xl border px-3 text-sm font-semibold outline-none", isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-[#F97316]" : "border-[#E2E8F0] bg-white text-[#0F172A] focus:border-[#FDBA74]")}
                  onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))}
                  placeholder="Message subject"
                  value={form.subject}
                />
              </label>

              <label className="block">
                <span className={cn("mb-1 block text-[10px] font-black uppercase tracking-[0.12em]", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>Message</span>
                <textarea
                  className={cn("min-h-32 w-full resize-y rounded-xl border px-3 py-3 text-sm font-medium leading-6 outline-none", isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-[#F97316]" : "border-[#E2E8F0] bg-white text-[#0F172A] focus:border-[#FDBA74]")}
                  onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
                  placeholder="Write the internal message..."
                  value={form.body}
                />
              </label>

              <label className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold", isAdminMode ? "border-[#333333] text-[#D4DDE8]" : "border-[#E2E8F0] text-[#475569]")}>
                <input
                  checked={form.sendEmail}
                  className="h-4 w-4 accent-[#F97316]"
                  onChange={(event) => setForm((current) => ({ ...current, sendEmail: event.target.checked }))}
                  type="checkbox"
                />
                Also send as email when recipient email exists
              </label>

              <button
                className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-[#F97316] px-4 text-sm font-black text-white transition hover:bg-[#EA580C] disabled:cursor-not-allowed disabled:opacity-60"
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
