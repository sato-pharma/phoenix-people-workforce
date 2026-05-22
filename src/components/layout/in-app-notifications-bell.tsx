"use client";

import { useEffect, useState } from "react";
import { Bell, CalendarDays, ClipboardList, Loader2, RefreshCw, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";

type InAppNotificationView = {
  category: string;
  createdAt: string | null;
  details?: Array<{ label: string; value: string }>;
  href: string | null;
  id: string;
  isRead: boolean;
  message: string;
  readAt: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  status: string;
  summary: {
    name: string | null;
    reference: string | null;
    requestDate: string | null;
    requestType: string | null;
    status: string | null;
  };
  summaryLine: string;
  title: string;
};

type NotificationsResponse = {
  data?: InAppNotificationView[];
};

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

function formatSummaryDate(value: string | null): string | null {
  if (!value) return null;
  const range = value.split(/\s+to\s+/i);
  if (range.length === 2) {
    const start = formatSummaryDate(range[0]);
    const end = formatSummaryDate(range[1]);
    return start && end ? `${start} to ${end}` : value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function summaryItems(notification: InAppNotificationView) {
  return [
    { icon: UserRound, label: "Name", value: notification.summary.name },
    { icon: CalendarDays, label: "Date", value: formatSummaryDate(notification.summary.requestDate) },
    { icon: ClipboardList, label: "Type", value: notification.summary.requestType },
  ].filter((item): item is { icon: typeof UserRound; label: string; value: string } => Boolean(item.value));
}

export function InAppNotificationsBell({ isAdminMode }: { isAdminMode: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<InAppNotificationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadNotifications() {
      try {
        if (mounted) setLoading(true);
        const response = await fetch("/api/notifications/in-app", {
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({})) as NotificationsResponse;
        if (!response.ok) throw new Error("Notifications failed to load.");
        if (mounted) {
          setError(null);
          setNotifications(payload.data ?? []);
        }
      } catch {
        if (mounted) {
          setError("Unable to load notifications.");
          setNotifications([]);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadNotifications();
    const interval = window.setInterval(() => void loadNotifications(), 60_000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const hasUnreadNotifications = notifications.some((notification) => !notification.isRead);

  async function markNotificationRead(notificationId: string) {
    setNotifications((current) => current.map((notification) =>
      notification.id === notificationId
        ? { ...notification, isRead: true, readAt: notification.readAt ?? new Date().toISOString() }
        : notification,
    ));

    await fetch(`/api/notifications/in-app/${encodeURIComponent(notificationId)}/read`, {
      method: "POST",
    }).catch(() => null);
  }

  async function openNotification(notification: InAppNotificationView) {
    await markNotificationRead(notification.id);
    setOpen(false);
    if (notification.href) {
      router.push(notification.href);
    }
  }

  return (
    <div className="relative hidden sm:block">
      <button
        aria-label="Notifications"
        className={`relative inline-flex h-10 w-10 items-center justify-center rounded-lg ${
          isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
        }`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Bell className="h-5 w-5" />
        {hasUnreadNotifications ? (
          <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-[#F97316] ring-2 ring-white" />
        ) : null}
      </button>

      {open ? (
        <div className={cn(
          "absolute right-0 top-full z-30 mt-2 w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-[18px] border shadow-xl",
          isAdminMode ? "border-[#333333] bg-[#050505]" : "border-[#E2E8F0] bg-white",
        )}>
          <div className={cn("border-b px-4 py-3", isAdminMode ? "border-[#333333]" : "border-[#E2E8F0]")}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className={cn("text-sm font-black", isAdminMode ? "text-white" : "text-[#0F172A]")}>Notifications</p>
                <p className={cn("mt-1 text-xs", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
                  Latest Phoenix Workforce updates.
                </p>
              </div>
              {loading ? (
                <Loader2 className={cn("h-4 w-4 animate-spin", isAdminMode ? "text-[#F8B56B]" : "text-[#F97316]")} />
              ) : (
                <RefreshCw className={cn("h-4 w-4", isAdminMode ? "text-[#64748B]" : "text-[#94A3B8]")} />
              )}
            </div>
          </div>

          <div className="max-h-[340px] overflow-auto p-2">
            {error ? (
              <div className={cn("rounded-xl px-4 py-5 text-sm", isAdminMode ? "text-[#FCA5A5]" : "text-[#B91C1C]")}>
                {error}
              </div>
            ) : notifications.length === 0 ? (
              <div className={cn("rounded-xl px-4 py-5 text-sm", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
                {loading ? "Loading notifications..." : "No notifications yet."}
              </div>
            ) : (
              notifications.map((notification) => {
                const content = (
                  <div className={cn(
                    "rounded-xl border px-3 py-3 text-left transition",
                    notification.isRead ? "opacity-75" : "opacity-100",
                    isAdminMode ? "border-[#1f1f1f] bg-[#090909] hover:bg-[#111111]" : "border-[#E2E8F0] bg-white hover:bg-[#F8FAFC]",
                  )}>
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-black uppercase ring-1",
                          isAdminMode
                            ? "bg-[#151515] text-[#F8B56B] ring-[#2a2a2a]"
                            : "bg-[#FFF7ED] text-[#C2410C] ring-[#FED7AA]",
                        )}
                      >
                        {(notification.summary.requestType ?? notification.category).slice(0, 2)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className={cn("truncate text-sm font-black", isAdminMode ? "text-white" : "text-[#0F172A]")}>
                              {notification.title}
                            </p>
                            <p className={cn("mt-1 line-clamp-1 text-[11px] font-semibold", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
                              {notification.summaryLine}
                            </p>
                          </div>
                          {!notification.isRead ? (
                            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[#F97316]" />
                          ) : null}
                        </div>
                        <p className={cn("mt-1 line-clamp-2 text-xs leading-5", isAdminMode ? "text-[#CBD5E1]" : "text-[#475569]")}>
                          {notification.message}
                        </p>
                        {summaryItems(notification).length ? (
                          <div className="mt-3 grid gap-1.5">
                            {summaryItems(notification).map((detail) => (
                              <div
                                className={cn(
                                  "grid grid-cols-[auto_52px_1fr] items-center gap-2 rounded-lg px-2 py-1.5 text-[11px]",
                                  isAdminMode ? "bg-[#111111] text-[#CBD5E1]" : "bg-[#F8FAFC] text-[#475569]",
                                )}
                                key={`${notification.id}-summary-${detail.label}`}
                              >
                                <detail.icon className="h-3.5 w-3.5 shrink-0 text-[#F97316]" />
                                <span className="shrink-0 font-black uppercase tracking-[0.10em] text-[#F97316]">{detail.label}</span>
                                <span className="min-w-0 truncate font-semibold">{detail.value}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-[#FFF7ED] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-[#C2410C]">
                            {notification.category.replace(/_/g, " ")}
                          </span>
                          <span className={cn("text-[11px]", isAdminMode ? "text-[#64748B]" : "text-[#94A3B8]")}>
                            {formatNotificationTime(notification.sentAt ?? notification.scheduledFor)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );

                return (
                  <button
                    className="block w-full"
                    key={notification.id}
                    onClick={() => void openNotification(notification)}
                    type="button"
                  >
                    {content}
                  </button>
                );
              })
            )}
          </div>

          <div className={cn("border-t p-2", isAdminMode ? "border-[#333333]" : "border-[#E2E8F0]")}>
            <Link
              className={cn(
                "block rounded-xl px-3 py-2 text-center text-xs font-black transition",
                isAdminMode ? "text-[#F8B56B] hover:bg-[#111111]" : "text-[#EA580C] hover:bg-[#FFF7ED]",
              )}
              href="/notifications"
              onClick={() => setOpen(false)}
            >
              View all
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
