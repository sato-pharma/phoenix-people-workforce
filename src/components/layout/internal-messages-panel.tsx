"use client";

import { useMemo, type Dispatch, type SetStateAction } from "react";
import { CheckCircle2, Loader2, RefreshCw, Search, Send, XCircle } from "lucide-react";

import { PersonalMailboxPanel, type PersonalMailboxOpenRequest } from "@/components/layout/personal-mailbox-panel";
import { phxFieldClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { systemUiText } from "@/config/system-settings";
import { askForDesktopMailAlerts } from "@/hooks/use-personal-mailbox-alerts";
import { cn } from "@/lib/utils";

/**
 * The messages panel's BODY: the "Phoenix messages" and "My email" tabs, the inbox list and the
 * composer. It is loaded the first time the envelope is needed, never with the page
 * (lazy-topbar-panel.tsx says why), and "My email" (personal-mailbox-panel.tsx) comes with it.
 * Everything that must work before that stays in internal-messages-menu.tsx: the unread count on
 * the envelope, the mailbox unread watch, the message list, the half-typed message and the send
 * call. The menu hands them to this component as props, so closing the panel loses nothing.
 */

export type InternalEmailStatus = "failed" | "not_requested" | "pending" | "sent" | "skipped";

export type InternalMessageView = {
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

export type InternalRecipientView = {
  email: string | null;
  hrId: string | null;
  id: string;
  label: string;
  loginId: string | null;
  name: string;
  role: string | null;
};

export type InternalMessageForm = {
  body: string;
  recipient: string;
  sendEmail: boolean;
  subject: string;
};

export type InternalMessagesTab = "internal" | "email";

/**
 * Cairo wall-clock, whatever zone the reader's device is set to. `createdAt` is an instant this app
 * stamped, so Africa/Cairo is its true local time; without `timeZone` it printed in the device's own
 * zone, and a laptop left on another zone read every message hours off.
 */
function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Now";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
  }).format(date);
}

function emailStatusText(status: InternalEmailStatus, error: string | null) {
  if (status === "sent") return "Email sent";
  if (status === "pending") return "Email pending";
  if (status === "skipped") return error || "Email skipped";
  if (status === "failed") return error || "Email failed";
  return "Internal only";
}

export type InternalMessagesPanelProps = {
  /** Unread in the person's own mailbox; null until the watch has answered, or with none connected. */
  emailUnread: number | null;
  error: string | null;
  form: InternalMessageForm;
  isAdminMode: boolean;
  loading: boolean;
  messages: InternalMessageView[];
  onFormChange: Dispatch<SetStateAction<InternalMessageForm>>;
  onRecipientQueryChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onSelectRecipient: (recipient: InternalRecipientView) => void;
  onSend: () => Promise<void>;
  onTabChange: (tab: InternalMessagesTab) => void;
  openRequest: PersonalMailboxOpenRequest | null;
  recipientLoading: boolean;
  recipientQuery: string;
  recipients: InternalRecipientView[];
  sending: boolean;
  success: string | null;
  tab: InternalMessagesTab;
};

export function InternalMessagesPanel({
  emailUnread,
  error,
  form,
  isAdminMode,
  loading,
  messages,
  onFormChange,
  onRecipientQueryChange,
  onRefresh,
  onSelectRecipient,
  onSend,
  onTabChange,
  openRequest,
  recipientLoading,
  recipientQuery,
  recipients,
  sending,
  success,
  tab,
}: InternalMessagesPanelProps) {
  const inboxMessages = useMemo(() => messages.filter((message) => message.direction === "inbox"), [messages]);
  const sentMessages = useMemo(() => messages.filter((message) => message.direction === "sent"), [messages]);

  return (
    <>
      <div className={cn("flex border-b", isAdminMode ? "border-[#333333]" : "border-phx-line")} role="tablist">
        {([
          ["internal", "Phoenix messages"],
          ["email", "My email"],
        ] as const).map(([key, label]) => (
          <button
            aria-selected={tab === key}
            className={cn(
              "flex-1 border-b-2 px-4 py-2.5 text-xs font-black uppercase tracking-[0.12em]",
              tab === key
                ? "border-phx-accent text-phx-accent-press"
                : cn("border-transparent", isAdminMode ? "text-phx-ink-faint hover:bg-[#111111]" : "text-phx-ink-soft hover:bg-phx-paper"),
            )}
            key={key}
            onClick={() => {
              // A click is the one moment a browser will show its "allow notifications" prompt.
              if (key === "email") askForDesktopMailAlerts();
              onTabChange(key);
            }}
            role="tab"
            type="button"
          >
            {label}
            {key === "email" && emailUnread ? (
              <span className="ml-2 inline-flex items-center bg-phx-accent px-1.5 py-0.5 align-middle text-phx-3xs font-black tracking-normal text-white">
                {emailUnread.toLocaleString("en-US")}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "email" ? <PersonalMailboxPanel isAdminMode={isAdminMode} openRequest={openRequest} /> : null}

      <div className={cn("grid xl:grid-cols-[0.95fr_1.05fr]", tab === "internal" ? null : "hidden")}>
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
              onClick={() => void onRefresh()}
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
                        {/* Wraps, never `whitespace-nowrap`: this list scrolls, so an unwrapped
                            long subject slid the whole list sideways — on a phone's narrow
                            column, most subjects. */}
                        <p className={cn("break-words text-sm font-black", isAdminMode ? "text-white" : "text-phx-ink")}>{message.subject}</p>
                        <p className={cn("mt-1 text-xs", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>
                          {message.direction === "inbox" ? `From ${message.sender.name}` : `To ${message.recipient.name}`}
                        </p>
                      </div>
                      <span className="shrink-0 rounded bg-phx-accent-soft px-2 py-0.5 text-phx-2xs font-black uppercase text-phx-accent-press">
                        {message.direction}
                      </span>
                    </div>
                    {/* The whole body, wrapped — never clamped to two lines behind an ellipsis. */}
                    <p className={cn("mt-2 break-words text-xs leading-5", isAdminMode ? "text-phx-line-strong" : "text-phx-ink-2")}>{message.body}</p>
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
                    phxFieldClassName, "w-full pl-9",
                    isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-phx-accent" : "border-phx-line bg-white text-phx-ink focus:border-phx-accent-line",
                  )}
                  onChange={(event) => {
                    const value = event.target.value;
                    onRecipientQueryChange(value);
                    onFormChange((current) => ({ ...current, recipient: value }));
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
                      onClick={() => onSelectRecipient(recipient)}
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
                className={cn(phxFieldClassName, "w-full", isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-phx-accent" : "border-phx-line bg-white text-phx-ink focus:border-phx-accent-line")}
                onChange={(event) => onFormChange((current) => ({ ...current, subject: event.target.value }))}
                placeholder="Message subject"
                value={form.subject}
              />
            </label>

            <label className="block">
              <span className={cn("mb-1 block text-phx-2xs font-black uppercase tracking-[0.12em]", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>Message</span>
              <textarea
                className={cn(phxTextareaClassName, "min-h-28 w-full leading-6", isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-phx-accent" : "border-phx-line bg-white text-phx-ink focus:border-phx-accent-line")}
                onChange={(event) => onFormChange((current) => ({ ...current, body: event.target.value }))}
                placeholder="Write the internal message..."
                value={form.body}
              />
            </label>

            <label className={cn("flex items-center gap-2 rounded border px-3 py-2 text-xs font-bold", isAdminMode ? "border-[#333333] text-[#D4DDE8]" : "border-phx-line text-phx-ink-2")}>
              <input
                checked={form.sendEmail}
                className="h-4 w-4 accent-phx-accent"
                onChange={(event) => onFormChange((current) => ({ ...current, sendEmail: event.target.checked }))}
                type="checkbox"
              />
              Also send as email when recipient email exists
            </label>

            <button
              className="inline-flex h-10 w-full items-center justify-center rounded bg-phx-accent px-4 text-sm font-black text-white transition hover:bg-phx-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
              disabled={sending}
              onClick={() => void onSend()}
              type="button"
            >
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Send Message
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
