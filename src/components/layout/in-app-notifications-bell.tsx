"use client";

import { useEffect, useState } from "react";
import { Bell, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";

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

export function InAppNotificationsBell({ isAdminMode }: { isAdminMode: boolean }) {
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

  const hasNotifications = notifications.length > 0;

  return (
    <div className="relative hidden sm:block">
      <button
        aria-label="Notifications"
        className={`relative inline-flex h-9 w-9 items-center justify-center rounded ${
          isAdminMode ? "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-[#F8B56B]" : "text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
        }`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Bell className="h-[18px] w-[18px]" />
        {hasNotifications ? (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[#F97316] ring-2 ring-white" />
        ) : null}
      </button>

      {open ? (
        <div className={cn(
          "absolute right-0 top-full z-30 mt-1.5 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded border shadow-lg",
          isAdminMode ? "border-[#333333] bg-[#050505]" : "border-[#E2E8F0] bg-white",
        )}>
          <div className={cn("border-b px-3.5 py-2.5", isAdminMode ? "border-[#333333]" : "border-[#E2E8F0]")}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className={cn("text-sm font-black", isAdminMode ? "text-white" : "text-[#0F172A]")}>Notifications</p>
                <p className={cn("mt-0.5 text-xs", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
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
              <div className={cn("rounded px-3 py-4 text-sm", isAdminMode ? "text-[#FCA5A5]" : "text-[#B91C1C]")}>
                {error}
              </div>
            ) : notifications.length === 0 ? (
              <div className={cn("rounded px-3 py-4 text-sm", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
                {loading ? "Loading notifications..." : "No notifications yet."}
              </div>
            ) : (
              notifications.map((notification) => {
                const content = (
                  <div className={cn(
                    "rounded px-3 py-2.5 transition",
                    isAdminMode ? "hover:bg-[#111111]" : "hover:bg-[#F8FAFC]",
                  )}>
                    <div className="flex items-start gap-2.5">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#F97316]" />
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-sm font-black", isAdminMode ? "text-white" : "text-[#0F172A]")}>
                          {notification.title}
                        </p>
                        <p className={cn("mt-0.5 text-xs leading-5", isAdminMode ? "text-[#CBD5E1]" : "text-[#475569]")}>
                          {notification.message}
                        </p>
                        {notification.details?.length ? (
                          <div className="mt-2 grid gap-1">
                            {notification.details.slice(0, 4).map((detail) => (
                              <div
                                className={cn(
                                  "flex items-center justify-between gap-3 rounded px-2 py-1 text-[11px]",
                                  isAdminMode ? "bg-[#111111] text-[#CBD5E1]" : "bg-[#F8FAFC] text-[#475569]",
                                )}
                                key={`${notification.id}-${detail.label}`}
                              >
                                <span className="shrink-0 font-black uppercase tracking-[0.10em] text-[#F97316]">{detail.label}</span>
                                <span className="min-w-0 font-semibold">{detail.value}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="rounded bg-[#FFF7ED] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-[#C2410C]">
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
