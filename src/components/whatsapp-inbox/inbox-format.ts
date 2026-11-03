// WhatsApp Inbox — how times, sizes and ticks read on screen. Pure, so the test can pin them.

import { formatStableEnGb } from "@/lib/format/cairo-datetime";

const CAIRO = "Africa/Cairo";

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cairoDayKey(date: Date): string {
  return formatStableEnGb(date, { day: "2-digit", month: "2-digit", timeZone: CAIRO, year: "numeric" });
}

/** "14:05" today, "Yesterday", "12 Sept" this year, "12 Sept 2025" before — all in Cairo time. */
export function formatListTime(iso: string | null, now = new Date()): string {
  const date = parse(iso);
  if (!date) return "";
  if (cairoDayKey(date) === cairoDayKey(now)) {
    return formatStableEnGb(date, { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: CAIRO });
  }
  if (cairoDayKey(date) === cairoDayKey(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  const sameYear =
    formatStableEnGb(date, { timeZone: CAIRO, year: "numeric" }) === formatStableEnGb(now, { timeZone: CAIRO, year: "numeric" });
  return formatStableEnGb(date, {
    day: "numeric",
    month: "short",
    timeZone: CAIRO,
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** How long a chat has waited for a reply: "Waiting under an hour", "Waiting 5 hours", "Waiting 3 days". */
export function formatWaitingFor(iso: string | null, now = new Date()): string {
  const date = parse(iso);
  if (!date) return "";
  const hours = Math.floor((now.getTime() - date.getTime()) / 3_600_000);
  if (hours < 1) return "Waiting under an hour";
  if (hours < 24) return `Waiting ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `Waiting ${days} ${days === 1 ? "day" : "days"}`;
}

/** The time printed under one message bubble. */
export function formatMessageTime(iso: string | null): string {
  const date = parse(iso);
  if (!date) return "";
  return formatStableEnGb(date, { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: CAIRO });
}

/** The day divider between messages: "Monday 15 Sept 2026". */
export function formatDayDivider(iso: string | null): string {
  const date = parse(iso);
  if (!date) return "";
  return formatStableEnGb(date, { day: "numeric", month: "short", timeZone: CAIRO, weekday: "long", year: "numeric" });
}

/** Whether two messages fall on different Cairo days, so a divider belongs between them. */
export function isNewCairoDay(previousIso: string | null, currentIso: string | null): boolean {
  const previous = parse(previousIso);
  const current = parse(currentIso);
  if (!current) return false;
  if (!previous) return true;
  return cairoDayKey(previous) !== cairoDayKey(current);
}

/** "3 h 12 min left", "40 min left" — a duration, so no timezone applies. */
export function formatWindowLeft(closesAtIso: string | null, now = Date.now()): string | null {
  const closes = parse(closesAtIso);
  if (!closes) return null;
  const minutes = Math.floor((closes.getTime() - now) / 60_000);
  if (minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} h ${rest} min left` : `${rest} min left`;
}

/** Whether an open reply window closes within two hours — still open, but worth a warning colour. */
export function isWindowClosingSoon(closesAtIso: string | null, now = Date.now()): boolean {
  const closes = parse(closesAtIso);
  if (!closes) return false;
  const left = closes.getTime() - now;
  return left > 0 && left < 2 * 60 * 60 * 1000;
}

export function formatByteSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What an outbound message's delivery state says, in words. Inbound messages carry none. */
export function describeDeliveryStatus(status: string): string {
  switch (status) {
    case "accepted":
      return "Sending";
    case "sent":
      return "Sent";
    case "delivered":
      return "Delivered";
    case "read":
      return "Read";
    case "failed":
      return "Not delivered";
    default:
      return "";
  }
}

/** The name a chat goes by: their WhatsApp name, else their number, else their username. */
export function conversationTitle(conversation: {
  contactName: string | null;
  contactPhone: string | null;
  contactUsername: string | null;
}): string {
  return conversation.contactName?.trim() || conversation.contactPhone || (conversation.contactUsername ? `@${conversation.contactUsername}` : "Unknown contact");
}
