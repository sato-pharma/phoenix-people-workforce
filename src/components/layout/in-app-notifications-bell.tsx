"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, ChevronRight, Loader2, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";

import { alarmGlowRef } from "@/components/layout/alarm-glow";
import { systemUiText } from "@/config/system-settings";
import { cn } from "@/lib/utils";
import { HEADER_PANEL_MAX_HEIGHT, placeAnchoredPanel, type PanelPlacement } from "@/lib/navigation/panel-position";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useDismissOnOutsideInteraction } from "@/hooks/use-dismiss-on-outside-interaction";
import { useRepositionOnViewportChange } from "@/hooks/use-reposition-on-viewport-change";


type InAppNotificationView = {
  actionLabel?: string;
  category: string;
  details?: Array<{ label: string; value: string }>;
  href: string | null;
  id: string;
  isRead?: boolean;
  message: string;
  module?: string | null;
  primaryText?: string;
  priority?: string;
  readAt?: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  status: string;
  statusLabel?: string;
  title: string;
};

type NotificationsResponse = {
  data?: InAppNotificationView[];
};

const pendingStatuses = new Set(["pending", "scheduled", "awaiting", "action_required"]);

/** Panel width, and the breathing room kept either side of it on a phone. */
const NOTIFICATION_PANEL_WIDTH = 380;
const NOTIFICATION_PANEL_GUTTER = 12;

/** Cairo wall-clock, whatever zone the device is on — the instant is one this app stamped. */
function formatNotificationTime(value: string | null) {
  if (!value) return "Now";
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

const NOTIFICATION_CODE_ACRONYMS = new Set(["crm", "hr", "kpi", "roi", "sos"]);

/**
 * A module or category CODE as a name: `phoenix_crm` → "Phoenix CRM", `direct_order_request` →
 * "Direct Order Request". The filter printed the code with its underscores swapped for spaces —
 * "phoenix crm", "crm account setup" — which is a code, not a name.
 */
function notificationCodeLabel(code: string) {
  return code
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) =>
      NOTIFICATION_CODE_ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

/** A notification needs action when it has an action, links somewhere, or is pending. */
function isActionRequired(notification: InAppNotificationView) {
  return (
    Boolean(notification.actionLabel) ||
    Boolean(notification.href) ||
    pendingStatuses.has(String(notification.status ?? "").toLowerCase())
  );
}

export function InAppNotificationsBell({
  isAdminMode,
  embedded = false,
  onClose,
  onUnreadChange,
}: {
  isAdminMode: boolean;
  /** Portal only: render just the panel body (no trigger, no floating, always open) for the unified inbox. */
  embedded?: boolean;
  /** Embedded: close the inbox popover that hosts this panel (a row was followed). */
  onClose?: () => void;
  /** Embedded: report the unread count up, so the inbox trigger can show a combined badge. */
  onUnreadChange?: (count: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<InAppNotificationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moduleFilter, setModuleFilter] = useState("all");
  // Measured from the bell's own rect when it is pressed. The panel prefers to hang from the bell's
  // RIGHT edge, which is correct on desktop and ran 50px off the LEFT of a 375px screen — see
  // panel-position.ts. Not an effect: setState inside useEffect is a lint error in this repo.
  const [placement, setPlacement] = useState<PanelPlacement>({
    offsetLeft: 0,
    width: NOTIFICATION_PANEL_WIDTH,
  });

  // The same measurement the click handler runs, reusable so a viewport change can repeat it: a
  // rotation while the panel is open would otherwise leave it wearing the old viewport's placement.
  const repositionPanel = useCallback(() => {
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!anchor) return;
    setPlacement(
      placeAnchoredPanel({
        align: "right",
        anchorLeft: anchor.left,
        anchorRight: anchor.right,
        gutter: NOTIFICATION_PANEL_GUTTER,
        preferredWidth: NOTIFICATION_PANEL_WIDTH,
        viewportWidth: document.documentElement.clientWidth,
      }),
    );
  }, []);

  const loadNotifications = useCallback(async (signal?: { aborted: boolean }) => {
    try {
      if (!signal?.aborted) setLoading(true);
      const response = await fetch("/api/notifications/in-app", {
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json().catch(() => ({}))) as NotificationsResponse;
      if (!response.ok) throw new Error("Notifications failed to load.");
      if (!signal?.aborted) {
        setError(null);
        setNotifications(payload.data ?? []);
      }
    } catch {
      if (!signal?.aborted) {
        setError("We couldn't load your notifications.");
        setNotifications([]);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const signal = { aborted: false };
    // Defer the first load so we don't call setState synchronously inside the effect.
    const initial = window.setTimeout(() => void loadNotifications(signal), 0);
    const interval = window.setInterval(() => void loadNotifications(signal), 60_000);
    return () => {
      signal.aborted = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [loadNotifications]);

  useDismissOnOutsideInteraction(containerRef, open, setOpen);
  useRepositionOnViewportChange(open, repositionPanel);

  const hasNotifications = notifications.length > 0;
  const moduleOptions = Array.from(new Set(notifications.map((notification) => notification.module || notification.category).filter(Boolean))).sort();
  const visibleNotifications = moduleFilter === "all"
    ? notifications
    : notifications.filter((notification) => (notification.module || notification.category) === moduleFilter);
  const hasVisibleNotifications = visibleNotifications.length > 0;
  const unreadCount = notifications.filter((notification) => !notification.isRead).length;
  useEffect(() => {
    onUnreadChange?.(unreadCount);
  }, [unreadCount, onUnreadChange]);
  const closePanel = useCallback(() => {
    if (onClose) onClose();
    else setOpen(false);
  }, [onClose]);
  const actionRequiredCount = visibleNotifications.filter((notification) => !notification.isRead && isActionRequired(notification)).length;

  async function markRead(id: string) {
    setNotifications((current) => current.map((notification) => notification.id === id ? { ...notification, isRead: true, readAt: new Date().toISOString() } : notification));
    await fetch("/api/notifications/in-app", {
      body: JSON.stringify({ id }),
      headers: { "Content-Type": "application/json" },
      // A notification row is a Link: the tap that fires this also navigates, and when that
      // navigation becomes a full document load (e.g. the client build is older than the server's)
      // WebKit aborts any in-flight fetch with "TypeError: Load failed". keepalive lets it finish.
      keepalive: true,
      method: "PATCH",
    }).catch(() => undefined);
  }

  async function markAllRead() {
    setNotifications((current) => current.map((notification) => ({ ...notification, isRead: true, readAt: notification.readAt ?? new Date().toISOString() })));
    await fetch("/api/notifications/in-app", {
      body: JSON.stringify({ markAll: true }),
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      method: "PATCH",
    }).catch(() => undefined);
  }

  async function clearAll() {
    setNotifications([]);
    await fetch("/api/notifications/in-app", {
      body: JSON.stringify({ clearAll: true }),
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      method: "PATCH",
    }).catch(() => undefined);
  }

  const panelText = {
    border: isAdminMode ? "border-[#333333]" : "border-phx-line",
    bg: isAdminMode ? "bg-[#050505]" : "bg-white",
    title: isAdminMode ? "text-white" : "text-phx-ink",
    muted: isAdminMode ? "text-phx-ink-faint" : "text-phx-ink-soft",
    body: isAdminMode ? "text-phx-line-strong" : "text-phx-ink-2",
    rowHover: isAdminMode ? "hover:bg-[#111111]" : "hover:bg-phx-paper",
    // Carded rows, matching InternalMessagesMenu's own `rounded border px-3 py-2.5` treatment. The
    // bell used borderless hover strips, which is why the two menus never read as one system.
    card: isAdminMode ? "border-[#1f2937] bg-[#0B0B0B]" : "border-phx-line bg-[#FCFDFE]",
    chip: isAdminMode ? "bg-[#111111] text-phx-line-strong" : "bg-phx-paper text-phx-ink-2",
    skeleton: isAdminMode ? "bg-[#1a1a1a]" : "bg-[#EEF2F7]",
  };

  const panelInner = (
    <>
          <div className={cn("border-b px-4 py-3", panelText.border)}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={cn("text-sm font-black", panelText.title)}>Notifications</p>
                <p className={cn("mt-0.5 text-xs", panelText.muted)}>{systemUiText.notificationsSubtitle}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  aria-label="Mark all notifications as read"
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-lg border transition disabled:opacity-40",
                    panelText.border,
                    isAdminMode ? "hover:bg-[#111111]" : "hover:bg-phx-paper",
                  )}
                  disabled={unreadCount === 0}
                  onClick={() => void markAllRead()}
                  type="button"
                >
                  <CheckCheck className={cn("h-4 w-4", isAdminMode ? "text-phx-ink-soft" : "text-phx-ink-faint")} />
                </button>
                <button
                  aria-label="Clear all notifications"
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-lg border transition disabled:opacity-40",
                    panelText.border,
                    isAdminMode ? "hover:bg-[#111111]" : "hover:bg-phx-paper",
                  )}
                  disabled={!hasNotifications}
                  onClick={() => void clearAll()}
                  type="button"
                >
                  <Trash2 className={cn("h-4 w-4", isAdminMode ? "text-phx-ink-soft" : "text-phx-ink-faint")} />
                </button>
                <button
                  aria-label="Refresh notifications"
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-lg border transition",
                    panelText.border,
                    isAdminMode ? "hover:bg-[#111111]" : "hover:bg-phx-paper",
                  )}
                  onClick={() => void loadNotifications()}
                  type="button"
                >
                  {loading ? (
                    <Loader2 className={cn("h-4 w-4 animate-spin", isAdminMode ? "text-[#F8B56B]" : "text-phx-accent")} />
                  ) : (
                    <RefreshCw className={cn("h-4 w-4", isAdminMode ? "text-phx-ink-soft" : "text-phx-ink-faint")} />
                  )}
                </button>
              </div>
            </div>
            {actionRequiredCount > 0 ? (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-phx-accent-soft px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-accent-press">
                {actionRequiredCount} action{actionRequiredCount === 1 ? "" : "s"} required
              </span>
            ) : null}
            {unreadCount > 0 ? (
              <span className="ml-2 mt-2 inline-flex items-center gap-1 rounded-full bg-phx-paper px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
                {unreadCount} unread
              </span>
            ) : null}
            {moduleOptions.length > 1 ? (
              <SearchableSelect
                className={cn(
                  "mt-2 block w-full px-2 py-1.5 text-xs font-semibold",
                  panelText.border,
                  isAdminMode ? "bg-[#050505] text-white" : "bg-white text-slate-700",
                )}
                onChange={(event) => setModuleFilter(event.target.value)}
                value={moduleFilter}
              >
                <option value="all">All modules</option>
                {moduleOptions.map((moduleName) => (
                  <option key={moduleName} value={moduleName}>
                    {notificationCodeLabel(moduleName)}
                  </option>
                ))}
              </SearchableSelect>
            ) : null}
          </div>

          {/* space-y-2 because the rows are cards now and would otherwise touch. */}
          <div className="max-h-[420px] space-y-2 overflow-auto p-2">
            {loading && !hasNotifications ? (
              <div className="space-y-2 p-1.5" aria-hidden="true">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="rounded-lg px-3 py-2.5">
                    <div className={cn("h-3 w-1/2 animate-pulse rounded", panelText.skeleton)} />
                    <div className={cn("mt-2 h-2.5 w-4/5 animate-pulse rounded", panelText.skeleton)} />
                    <div className={cn("mt-2 h-2.5 w-1/3 animate-pulse rounded", panelText.skeleton)} />
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="rounded-lg px-3 py-6 text-center">
                <p className={cn("text-sm font-bold", isAdminMode ? "text-[#FCA5A5]" : "text-[#B91C1C]")}>{error}</p>
                <button
                  className={cn(
                    "mt-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold transition",
                    panelText.border,
                    isAdminMode ? "text-[#F8B56B] hover:bg-[#111111]" : "text-phx-accent-press hover:bg-phx-accent-soft",
                  )}
                  onClick={() => void loadNotifications()}
                  type="button"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Try again
                </button>
              </div>
            ) : !hasNotifications || !hasVisibleNotifications ? (
              <div className="px-3 py-8 text-center">
                <Bell className={cn("mx-auto h-6 w-6", panelText.muted)} />
                <p className={cn("mt-2 text-sm font-bold", panelText.title)}>You&rsquo;re all caught up.</p>
                <p className={cn("mt-1 text-xs", panelText.muted)}>New updates assigned to you will appear here.</p>
              </div>
            ) : (
              visibleNotifications.map((notification) => {
                const actionRequired = isActionRequired(notification);
                const content = (
                  // Read rows are marked by a muted border and the dot losing its accent — NOT by
                  // opacity, which dimmed the text itself and made an already-read notification
                  // harder to actually read. Nothing here hides content.
                  <div
                    className={cn(
                      "rounded border px-3 py-2.5 transition",
                      panelText.card,
                      panelText.rowHover,
                      notification.isRead ? "" : "border-l-2 border-l-phx-accent",
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", notification.isRead ? "bg-slate-300" : "bg-phx-accent")} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          {notification.primaryText ? (
                            <div className="min-w-0">
                              {/* Wraps, never truncates — the owner's standing no-ellipsis rule.
                                  Vertical space is free here; the panel already scrolls. */}
                              <p className={cn("break-words text-sm font-black", panelText.title)}>
                                {notification.primaryText}
                              </p>
                              <p className={cn("mt-0.5 text-xs font-bold leading-5", panelText.body)}>
                                {notification.title}
                              </p>
                            </div>
                          ) : (
                            <p className={cn("text-sm font-black", panelText.title)}>{notification.title}</p>
                          )}
                          {notification.href ? (
                            <ChevronRight className={cn("mt-0.5 h-4 w-4 shrink-0", panelText.muted)} />
                          ) : null}
                        </div>
                        <p className={cn("mt-0.5 text-xs leading-5", panelText.body)}>{notification.message}</p>
                        {notification.details?.length ? (
                          <div className="mt-2 grid gap-1">
                            {notification.details.slice(0, 6).map((detail) => (
                              <div
                                className={cn(
                                  "flex items-start justify-between gap-3 rounded px-2 py-1 text-phx-xs",
                                  panelText.chip,
                                )}
                                key={`${notification.id}-${detail.label}`}
                              >
                                <span className="shrink-0 font-black uppercase tracking-[0.10em] text-phx-accent">
                                  {detail.label}
                                </span>
                                <span className="min-w-0 break-words text-right font-semibold">{detail.value}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="rounded bg-phx-accent-soft px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-accent-press">
                            {notificationCodeLabel(notification.category)}
                          </span>
                          {notification.priority ? (
                            <span className={cn("rounded px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em]", panelText.chip)}>
                              {notification.priority}
                            </span>
                          ) : null}
                          {notification.statusLabel ? (
                            <span className={cn("rounded px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em]", panelText.chip)}>
                              {notification.statusLabel}
                            </span>
                          ) : null}
                          {actionRequired ? (
                            <span className="rounded bg-[#FEF2F2] px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-[#B91C1C]">
                              Action required
                            </span>
                          ) : null}
                          <span className={cn("text-phx-xs", panelText.muted)}>
                            {formatNotificationTime(notification.sentAt ?? notification.scheduledFor)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );

                return notification.href ? (
                  <Link href={notification.href} key={notification.id} onClick={() => {
                    void markRead(notification.id);
                    closePanel();
                  }}>
                    {content}
                  </Link>
                ) : (
                  <div key={notification.id}>{content}</div>
                );
              })
            )}
          </div>
    </>
  );

  // Embedded (portal unified inbox): just the panel body, always shown, no trigger or floating.
  if (embedded) {
    return <div className={cn("flex min-h-0 flex-col", panelText.bg, panelText.title)}>{panelInner}</div>;
  }

  return (
    <div className="relative block" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-label="Notifications"
        className={cn(
          "relative inline-flex h-9 w-9 items-center justify-center rounded",
          isAdminMode
            ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]"
            : "text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink",
        )}
        onClick={() => {
          repositionPanel();
          setOpen((current) => !current);
        }}
        ref={buttonRef}
        type="button"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unreadCount > 0 ? (
          // A COUNT, not a bare dot — matching InternalMessagesMenu, which sits immediately to the
          // right of this button and has always shown its number. The two were the same control
          // wearing different clothes; the bell was the one hiding how much was waiting.
          // Deliberately a plain string, not cn(): tailwind-merge silently drops `text-phx-*` sizes
          // when it sees another `text-` class beside them, and nothing here needs merging.
          <span
            aria-label={`${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`}
            className="nav-badge-alarm absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded bg-phx-accent px-1 text-phx-3xs font-black text-white"
            ref={alarmGlowRef}
            role="status"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          // `left-0` + a measured marginLeft, not `right-0`: the placement is computed against the
          // viewport (see panel-position.ts), and it is the same mechanism the nav row's "+" uses.
          // `rounded` rather than `rounded-xl` — the house radius, and what the messages menu beside
          // it already uses.
          // Capped to the screen (and above the portal's phone bottom bar) and scrolling itself: it
          // hangs from a header that never scrolls away, and at 320x568 its header plus a 420px list
          // ran about 110px past the bottom, where nothing could reach it. HEADER_PANEL_MAX_HEIGHT.
          className={cn(
            "absolute left-0 top-full z-30 mt-1.5 overflow-x-hidden overflow-y-auto rounded border shadow-lg",
            panelText.border,
            panelText.bg,
          )}
          style={{ marginLeft: placement.offsetLeft, maxHeight: HEADER_PANEL_MAX_HEIGHT, width: placement.width }}
        >
          {panelInner}
        </div>
      ) : null}
    </div>
  );
}
