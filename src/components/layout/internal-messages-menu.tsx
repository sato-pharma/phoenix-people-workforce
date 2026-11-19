"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mail } from "lucide-react";
import dynamic from "next/dynamic";

import type {
  InternalMessageForm,
  InternalMessagesPanelProps,
  InternalMessagesTab,
  InternalMessageView,
  InternalRecipientView,
} from "@/components/layout/internal-messages-panel";
import { preloadPanel, preloadWhenIdle, TopbarPanelLoadFailed, TopbarPanelLoading } from "@/components/layout/lazy-topbar-panel";
import type { PersonalMailboxOpenRequest } from "@/components/layout/personal-mailbox-panel";
import { HEADER_PANEL_MAX_HEIGHT, placeAnchoredPanel, type PanelPlacement } from "@/lib/navigation/panel-position";
import { unreadBadgeLabel } from "@/lib/personal-mailbox/rules";
import { subscribePulseNotices } from "@/lib/session-pulse-store";
import { cn } from "@/lib/utils";
import { useDismissOnOutsideInteraction } from "@/hooks/use-dismiss-on-outside-interaction";
import { usePersonalMailboxAlerts } from "@/hooks/use-personal-mailbox-alerts";
import { useRepositionOnViewportChange } from "@/hooks/use-reposition-on-viewport-change";

/**
 * The topbar envelope: its button, its unread count, and the state behind the messages panel. The
 * panel's body (the two tabs, the inbox and the composer, with "My email") is
 * internal-messages-panel.tsx, loaded the first time it is needed and never with the page
 * (lazy-topbar-panel.tsx says why and how). The counts, the list, a half-typed message and the
 * calls live HERE, so the badge is right from the first paint and closing the panel loses nothing.
 */

type MessagesResponse = {
  messages?: InternalMessageView[];
  unreadCount?: number;
};

const emptyForm: InternalMessageForm = {
  body: "",
  recipient: "",
  sendEmail: false,
  subject: "",
};

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

const loadMessagesPanel = () => import("@/components/layout/internal-messages-panel");

/** A failed load (a tab left open across a deploy) shows inside the panel, never as a page error. */
function MessagesPanelLoadFailed({ isAdminMode }: InternalMessagesPanelProps) {
  return <TopbarPanelLoadFailed isAdminMode={isAdminMode} />;
}

const InternalMessagesPanel = dynamic<InternalMessagesPanelProps>(
  () =>
    loadMessagesPanel()
      .then((mod) => mod.InternalMessagesPanel)
      .catch(() => MessagesPanelLoadFailed),
  { loading: () => <TopbarPanelLoading />, ssr: false },
);

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
  const [tab, setTab] = useState<InternalMessagesTab>("internal");
  const [openRequest, setOpenRequest] = useState<PersonalMailboxOpenRequest | null>(null);
  const [messages, setMessages] = useState<InternalMessageView[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<InternalMessageForm>(emptyForm);
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

  // The panel's code is fetched once the page is idle, and again on hover or focus of the envelope,
  // so the first click almost always finds it already loaded.
  useEffect(() => preloadWhenIdle(loadMessagesPanel), []);

  const panelProps: InternalMessagesPanelProps = {
    emailUnread,
    error,
    form,
    isAdminMode,
    loading,
    messages,
    onFormChange: setForm,
    onRecipientQueryChange: setRecipientQuery,
    onRefresh: () => loadMessages(),
    onSelectRecipient: selectRecipient,
    onSend: sendMessage,
    onTabChange: setTab,
    openRequest,
    recipientLoading,
    recipientQuery,
    recipients,
    sending,
    success,
    tab,
  };

  // Embedded (portal unified inbox): just the panel body, always shown, no trigger or floating.
  if (embedded) {
    return <div className={cn("flex min-h-0 flex-col", isAdminMode ? "bg-[#050505] text-white" : "bg-white text-phx-ink")}><InternalMessagesPanel {...panelProps} /></div>;
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
        onFocus={() => preloadPanel(loadMessagesPanel)}
        onPointerEnter={() => preloadPanel(loadMessagesPanel)}
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
          <InternalMessagesPanel {...panelProps} />
        </div>
      ) : null}
    </div>
  );
}
