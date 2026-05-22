"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Bell, CalendarDays, CheckCircle2, ClipboardList, Clock3, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";

import type { InAppNotificationView } from "@/lib/notifications/in-app";
import { cn } from "@/lib/utils";

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
    year: "numeric",
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
    timeZone: "Africa/Cairo",
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

function NotificationGroup({
  emptyMessage,
  icon,
  items,
  onOpen,
  title,
}: {
  emptyMessage: string;
  icon: ReactNode;
  items: InAppNotificationView[];
  onOpen: (notification: InAppNotificationView) => void;
  title: string;
}) {
  return (
    <section className="overflow-hidden rounded-[22px] border border-white/80 bg-white/90 shadow-[0_18px_46px_rgba(15,23,42,0.07)] ring-1 ring-slate-200/70 backdrop-blur">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-[14px] bg-orange-50 text-orange-600 ring-1 ring-orange-100">
            {icon}
          </span>
          <div>
            <h2 className="text-base font-black text-slate-950">{title}</h2>
            <p className="text-xs font-semibold text-slate-500">{items.length} notifications</p>
          </div>
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {items.length === 0 ? (
          <div className="px-5 py-8 text-sm font-semibold text-slate-500">{emptyMessage}</div>
        ) : (
          items.map((notification) => (
            <button
              className="block w-full px-5 py-4 text-left transition hover:bg-orange-50/40"
              key={notification.id}
              onClick={() => onOpen(notification)}
              type="button"
            >
              <div className="flex items-start gap-4">
                <span
                  className={cn(
                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xs font-black uppercase ring-1",
                    notification.isRead
                      ? "bg-slate-100 text-slate-500 ring-slate-200"
                      : "bg-orange-50 text-orange-700 ring-orange-100",
                  )}
                >
                  {(notification.summary.requestType ?? notification.category).slice(0, 2)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-black text-slate-950">{notification.title}</p>
                    <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-orange-700">
                      {notification.category.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-semibold text-slate-500">{notification.summaryLine}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{notification.message}</p>
                  {summaryItems(notification).length ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      {summaryItems(notification).map((detail) => (
                        <span
                          className="grid min-w-0 grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded-[14px] border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600"
                          key={`${notification.id}-summary-${detail.label}`}
                        >
                          <detail.icon className="mt-0.5 h-3.5 w-3.5 text-orange-600" />
                          <span className="min-w-0">
                            <span className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{detail.label}</span>
                            <span className="block truncate font-semibold text-slate-700">{detail.value}</span>
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <p className="mt-3 text-xs font-semibold text-slate-400">
                    {formatNotificationTime(notification.sentAt ?? notification.scheduledFor ?? notification.createdAt)}
                  </p>
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

export function NotificationsHistory({ initialNotifications }: { initialNotifications: InAppNotificationView[] }) {
  const router = useRouter();
  const [notifications, setNotifications] = useState(initialNotifications);
  const groups = useMemo(() => ({
    read: notifications.filter((notification) => notification.isRead),
    unread: notifications.filter((notification) => !notification.isRead),
  }), [notifications]);

  async function openNotification(notification: InAppNotificationView) {
    setNotifications((current) => current.map((item) =>
      item.id === notification.id
        ? { ...item, isRead: true, readAt: item.readAt ?? new Date().toISOString() }
        : item,
    ));

    await fetch(`/api/notifications/in-app/${encodeURIComponent(notification.id)}/read`, {
      method: "POST",
    }).catch(() => null);

    if (notification.href) {
      router.push(notification.href);
    }
  }

  return (
    <div className="space-y-5">
      <NotificationGroup
        emptyMessage="No unread notifications."
        icon={<Bell className="h-4 w-4" />}
        items={groups.unread}
        onOpen={(notification) => void openNotification(notification)}
        title="Unread"
      />
      <NotificationGroup
        emptyMessage="No read notifications yet."
        icon={<CheckCircle2 className="h-4 w-4" />}
        items={groups.read}
        onOpen={(notification) => void openNotification(notification)}
        title="Read"
      />
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-400">
        <Clock3 className="h-3.5 w-3.5" />
        Newest notifications are shown first in each group.
      </div>
    </div>
  );
}
