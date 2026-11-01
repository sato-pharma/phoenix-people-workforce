"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Mail, RefreshCw, Search, Send, XCircle } from "lucide-react";

import { PersonalMailboxPanel, type PersonalMailboxOpenRequest } from "@/components/layout/personal-mailbox-panel";
import { systemUiText } from "@/config/system-settings";
import { HEADER_PANEL_MAX_HEIGHT, placeAnchoredPanel, type PanelPlacement } from "@/lib/navigation/panel-position";
import { unreadBadgeLabel } from "@/lib/personal-mailbox/rules";
import { subscribePulseNotices } from "@/lib/session-pulse-store";
import { cn } from "@/lib/utils";
import { useDismissOnOutsideInteraction } from "@/hooks/use-dismiss-on-outside-interaction";
import { askForDesktopMailAlerts, usePersonalMailboxAlerts } from "@/hooks/use-personal-mailbox-alerts";
import { useRepositionOnViewportChange } from "@/hooks/use-reposition-on-viewport-change";
import {
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

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

/**
 * Widest the two-column inbox wants to be; narrowed to fit whenever the viewport cannot hold it.
 *
 * The panel is placed with `left-0` + a measured `marginLeft`, never `right-0`. Right-anchoring a
 * panel on a trigger that sits near the right of a narrow toolbar opens it off the LEFT edge —
 * measured at -36 on 2026-09-02 — clipped rather than scrollable. The `w-[min(760px,100vw-2rem)]`
 * cap this replaced could not save it: the overflow comes from where the anchor sits, not the width.
 * Same failure, same fix, as the notifications bell beside it.
 */
const MESSAGES_PANEL_WIDTH = 760;
/** Breathing room kept at each edge — the `2rem` this panel always intended, split evenly. */
const MESSAGES_PANEL_GUTTER = 16;

export function InternalMessagesMenu({
  isAdminMode,
  embedded = false,
  mailboxConnected,
  onUnreadChange,
}: {
  isAdminMode: boolean;
  /** Portal only: render just the panel body (no trigger, no floating, always open) for the unified inbox. */
  embedded?: boolean;
  /**
   * Whether this person has "My email" connected, as the shell's render already knows it. False
   * stops the mailbox unread check before it starts (nothing to check); true or undefined keeps it.
   * The check used to run on every page view for everyone, five reads deep, to learn "not connected".
   */
  mailboxConnected?: boolean;
  /** Embedded: report unread (Phoenix + email) up, so the inbox trigger can show a combined badge. */
  onUnreadChange?: (count: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // "My email" is the person's own Turbify mailbox (personal-mailbox-panel.tsx). The panel only
  // mounts when chosen; the one thing that reads the mailbox in the background is the unread check
  // below (use-personal-mailbox-alerts.ts), and only for someone who connected it.
  const [tab, setTab] = useState<"internal" | "email">("internal");
  const [openRequest, setOpenRequest] = useState<PersonalMailboxOpenRequest | null>(null);
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
  const [placement, setPlacement] = useState<PanelPlacement>({
    offsetLeft: 0,
    width: MESSAGES_PANEL_WIDTH,
  });

  // Reusable so a viewport change can repeat it — see use-reposition-on-viewport-change.ts.
  const repositionPanel = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlacement(
      placeAnchoredPanel({
        align: "right",
        anchorLeft: rect.left,
        anchorRight: rect.right,
        gutter: MESSAGES_PANEL_GUTTER,
        preferredWidth: MESSAGES_PANEL_WIDTH,
        viewportWidth: document.documentElement.clientWidth,
      }),
    );
  }, []);
  // A new-mail pop-up's "Open": the envelope opens on My email with that email in the reader. Only
  // offered while the envelope is actually drawn; a page without it still shows the pop-up.
  const canOpenEmail = useCallback(() => (buttonRef.current?.getClientRects().length ?? 0) > 0, []);
  const openNonce = useRef(0);
  const openEmail = useCallback(
    (uid: number) => {
      openNonce.current += 1;
      repositionPanel();
      setTab("email");
      setOpen(true);
      setOpenRequest({ nonce: openNonce.current, uid });
    },
    [repositionPanel],
  );
  const { unread: emailUnread } = usePersonalMailboxAlerts({ canOpenEmail, enabled: mailboxConnected, onOpenEmail: openEmail });
  const badgeLabel = unreadBadgeLabel(unreadCount + (emailUnread ?? 0));
  const totalUnread = unreadCount + (emailUnread ?? 0);
  useEffect(() => {
    onUnreadChange?.(totalUnread);
  }, [totalUnread, onUnreadChange]);

  const inboxMessages = useMemo(() => messages.filter((message) => message.direction === "inbox"), [messages]);
  const sentMessages = useMemo(() => messages.filter((message) => message.direction === "sent"), [messages]);

  // Every inbox message is shown whole in the open panel — there is no separate "open a message"
  // step — so the panel being open on this tab IS the reading. Nothing ever called the read route
  // before, so an unread count, once it appeared, never went down again.
  const markInboxRead = useCallback(async (list: InternalMessageView[]) => {
    const unread = list.filter((message) => message.direction === "inbox" && !message.readAt);
    if (unread.length === 0) return;
    const results = await Promise.allSettled(
      unread.map(async (message) => {
        const response = await fetch(`/api/messages/${encodeURIComponent(message.id)}/read`, { method: "PATCH" });
        if (!response.ok) throw new Error("Message read failed.");
        return message.id;
      }),
    );
    const readIds = new Set(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
    if (readIds.size === 0) return;
    const readAt = new Date().toISOString();
    setMessages((current) => current.map((message) => (readIds.has(message.id) ? { ...message, readAt: message.readAt ?? readAt } : message)));
    setUnreadCount((count) => Math.max(0, count - readIds.size));
  }, []);

  const loadMessages = useCallback(async (options?: { markRead?: boolean }) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/messages", { headers: { Accept: "application/json" } });
      const payload = (await response.json().catch(() => ({}))) as MessagesResponse & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Messages failed to load.");
      setMessages(payload.messages ?? []);
      setUnreadCount(payload.unreadCount ?? 0);
      if (options?.markRead) void markInboxRead(payload.messages ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Messages failed to load.");
    } finally {
      setLoading(false);
    }
  }, [markInboxRead]);

  // The envelope's badge counts unread Phoenix messages BEFORE the panel is first opened — the only
  // unread signal on a phone. It used to fetch the whole list on mount for that one number, on every
  // page view; since 1 Nov 2026 the number rides the session pulse the bell already receives
  // (`unreadMessages`, read in the same statement as the notices), so a page view costs no request
  // here at all. A pulse that cannot say (null — the bundle RPC is not on this database yet) makes
  // the menu fetch its list once, as before, and the open panel still re-reads and marks read.
  const fetchedOnce = useRef(false);
  useEffect(() => {
    return subscribePulseNotices((notices) => {
      if (typeof notices.unreadMessages === "number") {
        setUnreadCount(notices.unreadMessages);
        return;
      }
      if (fetchedOnce.current) return;
      fetchedOnce.current = true;
      void loadMessages();
    });
  }, [loadMessages]);

  useEffect(() => {
    if (!open) return;
    const timeoutId = window.setTimeout(() => void loadMessages({ markRead: tab === "internal" }), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadMessages, open, tab]);

  useDismissOnOutsideInteraction(containerRef, open, setOpen);
  useRepositionOnViewportChange(open, repositionPanel);

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

  const panelInner = (
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
                  setTab(key);
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
                    className={cn(phxFieldClassName, "w-full", isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-phx-accent" : "border-phx-line bg-white text-phx-ink focus:border-phx-accent-line")}
                    onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))}
                    placeholder="Message subject"
                    value={form.subject}
                  />
                </label>

                <label className="block">
                  <span className={cn("mb-1 block text-phx-2xs font-black uppercase tracking-[0.12em]", isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft")}>Message</span>
                  <textarea
                    className={cn(phxTextareaClassName, "min-h-28 w-full leading-6", isAdminMode ? "border-[#333333] bg-[#0B0B0B] text-white focus:border-phx-accent" : "border-phx-line bg-white text-phx-ink focus:border-phx-accent-line")}
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
    </>
  );

  // Embedded (portal unified inbox): just the panel body, always shown, no trigger or floating.
  if (embedded) {
    return <div className={cn("flex min-h-0 flex-col", isAdminMode ? "bg-[#050505] text-white" : "bg-white text-phx-ink")}>{panelInner}</div>;
  }

  return (
    <div className="relative" ref={containerRef}>
      {/* Drawn at every width: on a phone it is the only place the unread counts show. Summed from
          the classes at 375px, both bars keep room for it — the admin bar's icons and account button
          come to about 262 of its 351px, and the portal's leave its title about 180px. */}
      <button
        aria-expanded={open}
        aria-label={badgeLabel ? `Messages, ${badgeLabel} unread` : "Messages"}
        className={`relative inline-flex h-9 w-9 items-center justify-center rounded ${
          isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink"
        }`}
        onClick={() => {
          repositionPanel();
          // Opened by hand, the mailbox shows its list — not the email an earlier pop-up opened.
          setOpenRequest(null);
          setOpen((current) => !current);
        }}
        ref={buttonRef}
        type="button"
      >
        <Mail className="h-[18px] w-[18px]" />
        {badgeLabel ? (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded bg-phx-accent px-1 text-phx-3xs font-black text-white">
            {badgeLabel}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className={cn(
            // The two columns stack below `xl`, so the panel is taller than the screen on a phone, a
            // tablet AND a 1024-1279px laptop, and it hangs from a header that does not scroll away:
            // past the screen's bottom it could never be reached. It stops at the screen — and above
            // the portal's phone bottom bar — and scrolls itself, at every width. It used to do so
            // only below `sm`, which left the Send button about 250px under a 1024x768 screen.
            "absolute left-0 top-full z-30 mt-1.5 overflow-x-hidden overflow-y-auto rounded border shadow-lg",
            isAdminMode ? "border-[#333333] bg-[#050505]" : "border-phx-line bg-white",
          )}
          style={{ marginLeft: placement.offsetLeft, maxHeight: HEADER_PANEL_MAX_HEIGHT, width: placement.width }}
        >
          {panelInner}
        </div>
      ) : null}
    </div>
  );
}
