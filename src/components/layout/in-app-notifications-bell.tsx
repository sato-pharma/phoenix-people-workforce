"use client";

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

type InAppNotificationView = {
  category: string;
  actionLabel: string | null;
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

  useEffect(() => {
    let mounted = true;

    async function loadNotifications() {
      try {
        const response = await fetch("/api/notifications/in-app", {
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({})) as NotificationsResponse;
        if (mounted) setNotifications(payload.data ?? []);
      } catch {
        if (mounted) setNotifications([]);
      }
    }

    void loadNotifications();

    return () => {
      mounted = false;
    };
  }, []);

  const hasNotifications = notifications.length > 0;

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
        {hasNotifications ? (
          <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-[#F97316] ring-2 ring-white" />
        ) : null}
      </button>

      {open ? (
        <div className={cn(
          "absolute right-0 top-full z-30 mt-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-[18px] border shadow-xl",
          isAdminMode ? "border-[#333333] bg-[#050505]" : "border-[#E2E8F0] bg-white",
        )}>
          <div className={cn("border-b px-4 py-3", isAdminMode ? "border-[#333333]" : "border-[#E2E8F0]")}>
            <p className={cn("text-sm font-black", isAdminMode ? "text-white" : "text-[#0F172A]")}>Notifications</p>
            <p className={cn("mt-1 text-xs", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
              Latest Phoenix Workforce updates.
            </p>
          </div>

          <div className="max-h-[340px] overflow-auto p-2">
            {notifications.length === 0 ? (
              <div className={cn("rounded-xl px-4 py-5 text-sm", isAdminMode ? "text-[#94A3B8]" : "text-[#64748B]")}>
                No notifications yet.
              </div>
            ) : (
              notifications.map((notification) => {
                const content = (
                  <div className={cn(
                    "rounded-xl px-3 py-3 transition",
                    isAdminMode ? "hover:bg-[#111111]" : "hover:bg-[#F8FAFC]",
                  )}>
                    <div className="flex items-start gap-3">
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[#F97316]" />
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-sm font-black", isAdminMode ? "text-white" : "text-[#0F172A]")}>
                          {notification.title}
                        </p>
                        <p className={cn("mt-1 line-clamp-2 text-xs leading-5", isAdminMode ? "text-[#CBD5E1]" : "text-[#475569]")}>
                          {notification.message}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-[#FFF7ED] px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-[#C2410C]">
                            {notification.category.replace(/_/g, " ")}
                          </span>
                          {notification.href ? (
                            <span className={cn(
                              "rounded-full border border-[#E2E8F0] bg-white px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em]",
                              isAdminMode ? "border-[#334155] text-[#CBD5E1]" : "text-[#0F172A]",
                            )}>
                              {notification.actionLabel || "See details"}
                            </span>
                          ) : null}
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
