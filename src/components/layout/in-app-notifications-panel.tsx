"use client";

import { Bell, CheckCheck, ChevronRight, Loader2, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";

import { SearchableSelect } from "@/components/ui/searchable-select";
import { systemUiText } from "@/config/system-settings";
import { cn } from "@/lib/utils";

/**
 * The notifications panel's BODY: the header with its three actions, the module filter and the
 * list. It is loaded the first time the bell is needed, never with the page (lazy-topbar-panel.tsx
 * says why). Everything that must work before that stays in in-app-notifications-bell.tsx: the
 * list itself, the unread count on the bell's badge, the session pulse that keeps both fresh, and
 * the read, clear and refresh calls. The bell hands them to this component as props, so nothing is
 * lost when the panel closes.
 */

export type InAppNotificationView = {
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

const pendingStatuses = new Set(["pending", "scheduled", "awaiting", "action_required"]);

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

export type InAppNotificationsPanelProps = {
  error: string | null;
  isAdminMode: boolean;
  loading: boolean;
  moduleFilter: string;
  notifications: InAppNotificationView[];
  onClearAll: () => Promise<void>;
  /** A row was followed: close whatever holds the panel (the bell's dropdown, or the portal inbox). */
  onFollow: () => void;
  onMarkAllRead: () => Promise<void>;
  onMarkRead: (id: string) => Promise<void>;
  onModuleFilterChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  unreadCount: number;
};

export function InAppNotificationsPanel({
  error,
  isAdminMode,
  loading,
  moduleFilter,
  notifications,
  onClearAll,
  onFollow,
  onMarkAllRead,
  onMarkRead,
  onModuleFilterChange,
  onRefresh,
  unreadCount,
}: InAppNotificationsPanelProps) {
  const hasNotifications = notifications.length > 0;
  const moduleOptions = Array.from(new Set(notifications.map((notification) => notification.module || notification.category).filter(Boolean))).sort();
  const visibleNotifications = moduleFilter === "all"
    ? notifications
    : notifications.filter((notification) => (notification.module || notification.category) === moduleFilter);
  const hasVisibleNotifications = visibleNotifications.length > 0;
  const actionRequiredCount = visibleNotifications.filter((notification) => !notification.isRead && isActionRequired(notification)).length;

  const panelText = {
    border: isAdminMode ? "border-[#333333]" : "border-phx-line",
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

  return (
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
              onClick={() => void onMarkAllRead()}
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
              onClick={() => void onClearAll()}
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
              onClick={() => void onRefresh()}
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
            onChange={(event) => onModuleFilterChange(event.target.value)}
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
              onClick={() => void onRefresh()}
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
                void onMarkRead(notification.id);
                onFollow();
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
}
