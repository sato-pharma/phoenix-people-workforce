"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import dynamic from "next/dynamic";

import { alarmGlowRef } from "@/components/layout/alarm-glow";
import type { InAppNotificationView, InAppNotificationsPanelProps } from "@/components/layout/in-app-notifications-panel";
import { preloadPanel, preloadWhenIdle, TopbarPanelLoadFailed, TopbarPanelLoading } from "@/components/layout/lazy-topbar-panel";
import { cn } from "@/lib/utils";
import { subscribePulseNotices } from "@/lib/session-pulse-store";
import { HEADER_PANEL_MAX_HEIGHT, placeAnchoredPanel, type PanelPlacement } from "@/lib/navigation/panel-position";
import { useDismissOnOutsideInteraction } from "@/hooks/use-dismiss-on-outside-interaction";
import { useRepositionOnViewportChange } from "@/hooks/use-reposition-on-viewport-change";

/**
 * The topbar bell: its button, its unread count, and the list behind both. The panel's body (the
 * header, the module filter and the rows) is in-app-notifications-panel.tsx, loaded the first time
 * it is needed and never with the page (lazy-topbar-panel.tsx says why and how). The list, the
 * count and the read / clear calls live HERE, so the badge is right from the first paint and
 * nothing is lost when the panel closes.
 */

type NotificationsResponse = {
  data?: InAppNotificationView[];
};

/** Panel width, and the breathing room kept either side of it on a phone. */
const NOTIFICATION_PANEL_WIDTH = 380;
const NOTIFICATION_PANEL_GUTTER = 12;

const loadNotificationsPanel = () => import("@/components/layout/in-app-notifications-panel");

/** A failed load (a tab left open across a deploy) shows inside the panel, never as a page error. */
function NotificationsPanelLoadFailed({ isAdminMode }: InAppNotificationsPanelProps) {
  return <TopbarPanelLoadFailed isAdminMode={isAdminMode} />;
}

const InAppNotificationsPanel = dynamic<InAppNotificationsPanelProps>(
  () =>
    loadNotificationsPanel()
      .then((mod) => mod.InAppNotificationsPanel)
      .catch(() => NotificationsPanelLoadFailed),
  { loading: () => <TopbarPanelLoading />, ssr: false },
);

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
    // The list rides the session pulse (src/lib/session-pulse-store.ts): the one 30 s request an open
    // tab sends for the sidebar badges, this list and the session heartbeat together, where the bell
    // used to run its own 60 s read (a full session lookup each time — 36,926 a day on production,
    // 23 Oct 2026). The pulse asks for the list when it is at least a minute old, skips a hidden tab,
    // and refetches a tab shown again unless it fetched moments ago — the rules this effect used to
    // hold itself. loadNotifications below stays for the refresh and try-again buttons.
    let active = true;
    const unsubscribe = subscribePulseNotices((notices) => {
      if (!active) return;
      if (Array.isArray(notices.data)) {
        setError(null);
        setNotifications(notices.data as InAppNotificationView[]);
      } else {
        setError("We couldn't load your notifications.");
        setNotifications([]);
      }
      setLoading(false);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useDismissOnOutsideInteraction(containerRef, open, setOpen);
  useRepositionOnViewportChange(open, repositionPanel);

  const unreadCount = notifications.filter((notification) => !notification.isRead).length;
  useEffect(() => {
    onUnreadChange?.(unreadCount);
  }, [unreadCount, onUnreadChange]);
  const closePanel = useCallback(() => {
    if (onClose) onClose();
    else setOpen(false);
  }, [onClose]);

  // The panel's code is fetched once the page is idle, and again on hover or focus of the bell, so
  // the first click almost always finds it already loaded.
  useEffect(() => preloadWhenIdle(loadNotificationsPanel), []);

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

  // The frame's own colours: the dropdown box, and the portal inbox's embedded wrapper.
  const frame = {
    border: isAdminMode ? "border-[#333333]" : "border-phx-line",
    bg: isAdminMode ? "bg-[#050505]" : "bg-white",
    title: isAdminMode ? "text-white" : "text-phx-ink",
  };

  const panelProps: InAppNotificationsPanelProps = {
    error,
    isAdminMode,
    loading,
    moduleFilter,
    notifications,
    onClearAll: clearAll,
    onFollow: closePanel,
    onMarkAllRead: markAllRead,
    onMarkRead: markRead,
    onModuleFilterChange: setModuleFilter,
    onRefresh: () => loadNotifications(),
    unreadCount,
  };

  // Embedded (portal unified inbox): just the panel body, always shown, no trigger or floating.
  if (embedded) {
    return <div className={cn("flex min-h-0 flex-col", frame.bg, frame.title)}><InAppNotificationsPanel {...panelProps} /></div>;
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
        onFocus={() => preloadPanel(loadNotificationsPanel)}
        onPointerEnter={() => preloadPanel(loadNotificationsPanel)}
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
            frame.border,
            frame.bg,
          )}
          style={{ marginLeft: placement.offsetLeft, maxHeight: HEADER_PANEL_MAX_HEIGHT, width: placement.width }}
        >
          <InAppNotificationsPanel {...panelProps} />
        </div>
      ) : null}
    </div>
  );
}
