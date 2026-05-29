"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";

import { systemUiText } from "@/config/system-settings";
import { cn } from "@/lib/utils";

type InAppNotificationView = {
  category: string;
  details?: Array<{ label: string; value: string }>;
  href: string | null;
  id: string;
  message: string;
  scheduledFor: string | null;
  sentAt: string | null;
  status: string;
  title: string;
};

type NotificationsResponse = {
  data?: InAppNotificationView[];
};

const pendingStatuses = new Set(["pending", "scheduled", "awaiting", "action_required"]);

function formatNotificationTime(value: string | null) {
  if (!value) return "Now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Now";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(date);
}

/** A notification needs action when it links somewhere actionable or is pending. */
function isActionRequired(notification: InAppNotificationView) {
  return Boolean(notification.href) || pendingStatuses.has(String(notification.status ?? "").toLowerCase());
}

export function InAppNotificationsBell({ isAdminMode }: { isAdminMode: boolean }) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<InAppNotificationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const hasNotifications = notifications.length > 0;
  const actionRequiredCount = notifications.filter(isActionRequired).length;

  const panelText = {
    border: isAdminMode ? "border-[#333333]" : "border-[#E2E8F0]",
    bg: isAdminMode ? "bg-[#050505]" : "bg-white",
    title: isAdminMode ? "text-white" : "text-[#0F172A]",
    muted: isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]",
    body: isAdminMode ? "text-[#CBD5E1]" : "text-[#475569]",
    rowHover: isAdminMode ? "hover:bg-[#111111]" : "hover:bg-[#F8FAFC]",
    chip: isAdminMode ? "bg-[#111111] text-[#CBD5E1]" : "bg-[#F8FAFC] text-[#475569]",
    skeleton: isAdminMode ? "bg-[#1a1a1a]" : "bg-[#EEF2F7]",
  };

  return (
    <div className="relative block">
      <button
        aria-label="Notifications"
        className={cn(
          "relative inline-flex h-9 w-9 items-center justify-center rounded",
          isAdminMode
            ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]"
            : "text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]",
        )}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Bell className="h-[18px] w-[18px]" />
        {hasNotifications ? (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[#F97316] ring-2 ring-white" />
        ) : null}
      </button>

      {open ? (
        <div
          className={cn(
            "absolute right-0 top-full z-30 mt-1.5 w-[min(380px,calc(100vw-1.5rem))] overflow-hidden rounded-xl border shadow-lg",
            panelText.border,
            panelText.bg,
          )}
        >
          <div className={cn("border-b px-4 py-3", panelText.border)}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={cn("text-sm font-black", panelText.title)}>Notifications</p>
                <p className={cn("mt-0.5 text-xs", panelText.muted)}>{systemUiText.notificationsSubtitle}</p>
              </div>
              <button
                aria-label="Refresh notifications"
                className={cn(
                  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition",
                  panelText.border,
                  isAdminMode ? "hover:bg-[#111111]" : "hover:bg-[#F8FAFC]",
                )}
                onClick={() => void loadNotifications()}
                type="button"
              >
                {loading ? (
                  <Loader2 className={cn("h-4 w-4 animate-spin", isAdminMode ? "text-[#F8B56B]" : "text-[#F97316]")} />
                ) : (
                  <RefreshCw className={cn("h-4 w-4", isAdminMode ? "text-[#64748B]" : "text-[#94A3B8]")} />
                )}
              </button>
            </div>
            {actionRequiredCount > 0 ? (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-[#FFF7ED] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-[#C2410C]">
                {actionRequiredCount} action{actionRequiredCount === 1 ? "" : "s"} required
              </span>
            ) : null}
          </div>

          <div className="max-h-[360px] overflow-auto p-2">
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
                    isAdminMode ? "text-[#F8B56B] hover:bg-[#111111]" : "text-[#C2410C] hover:bg-[#FFF7ED]",
                  )}
                  onClick={() => void loadNotifications()}
                  type="button"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Try again
                </button>
              </div>
            ) : !hasNotifications ? (
              <div className="px-3 py-8 text-center">
                <Bell className={cn("mx-auto h-6 w-6", panelText.muted)} />
                <p className={cn("mt-2 text-sm font-bold", panelText.title)}>You&rsquo;re all caught up.</p>
                <p className={cn("mt-1 text-xs", panelText.muted)}>New updates assigned to you will appear here.</p>
              </div>
            ) : (
              notifications.map((notification) => {
                const actionRequired = isActionRequired(notification);
                const content = (
                  <div className={cn("rounded-lg px-3 py-2.5 transition", panelText.rowHover)}>
                    <div className="flex items-start gap-2.5">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#F97316]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className={cn("text-sm font-black", panelText.title)}>{notification.title}</p>
                          {notification.href ? (
                            <ChevronRight className={cn("mt-0.5 h-4 w-4 shrink-0", panelText.muted)} />
                          ) : null}
                        </div>
                        <p className={cn("mt-0.5 text-xs leading-5", panelText.body)}>{notification.message}</p>
                        {notification.details?.length ? (
                          <div className="mt-2 grid gap-1">
                            {notification.details.slice(0, 4).map((detail) => (
                              <div
                                className={cn(
                                  "flex items-center justify-between gap-3 rounded px-2 py-1 text-[11px]",
                                  panelText.chip,
                                )}
                                key={`${notification.id}-${detail.label}`}
                              >
                                <span className="shrink-0 font-black uppercase tracking-[0.10em] text-[#F97316]">
                                  {detail.label}
                                </span>
                                <span className="min-w-0 truncate font-semibold">{detail.value}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="rounded bg-[#FFF7ED] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-[#C2410C]">
                            {notification.category.replace(/_/g, " ")}
                          </span>
                          {actionRequired ? (
                            <span className="rounded bg-[#FEF2F2] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-[#B91C1C]">
                              Action required
                            </span>
                          ) : null}
                          <span className={cn("text-[11px]", panelText.muted)}>
                            {formatNotificationTime(notification.sentAt ?? notification.scheduledFor)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );

                return notification.href ? (
                  <Link href={notification.href} key={notification.id} onClick={() => setOpen(false)}>
                    {content}
                  </Link>
                ) : (
                  <div key={notification.id}>{content}</div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
