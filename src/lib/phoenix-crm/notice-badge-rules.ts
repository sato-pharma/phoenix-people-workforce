/**
 * Phoenix CRM — which unread notices make a module's card PULSE, and which module a notice belongs to.
 *
 * Owner, 2026-10-08: "I want to show pumping badges beside the thing that has a notification. I want
 * the people to be alerted." The module already tells people in-app, by Telegram, on the phone and (for
 * every person-to-person step) by email; what it did NOT do was SHOW, inside Phoenix CRM, that something
 * new had arrived — the only badge was a static "N waiting" on Team/Reports, counting decisions rather
 * than notices, and nothing at all for a rep whose plan had just been approved or returned.
 *
 * This file is pure: no database, no React. The server half (`server/unread-notices.ts`) reads the
 * viewer's own unread notices and hands them here; the screens only draw what comes back.
 *
 * 🔴 THE FEEDS NEVER PULSE. The activity mirror, the hourly rollup, the 06:55 digest and the fraud scan
 * are high-volume reading material for the widest readers; a card that pulsed for them would pulse
 * permanently and teach every manager to ignore it. They stay in the bell and on Telegram, as before.
 *
 * 🔴 AND THE REP'S SIDE STAYS EASY AND BLIND (Golden Rule #1). A badge says "new" and names the notice
 * the rep was already sent in his bell — nothing is added to his day and nothing new is said about him.
 */

import { isPhoenixCrmModuleKey, phoenixCrmModuleForSlug, type PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";

/** How far back an unread notice still pulses. Older ones stay in the bell and no longer shout. */
export const PHOENIX_CRM_BADGE_WINDOW_DAYS = 14;

/**
 * The reading-material feeds — in the bell and on Telegram, never a pulse. Kept here, beside the rule
 * that uses it, so adding a feed means deciding in one place whether it should shout.
 */
export const PHOENIX_CRM_NOTICES_THAT_NEVER_PULSE: readonly string[] = [
  "activity_mirror",
  "crm_visit_rollup",
  "crm_daily_digest",
  "crm_fraud_scan",
];

export type PhoenixCrmUnreadNotice = {
  actionUrl: string | null;
  createdAt: string;
  eventType: string;
  id: string;
  /** The territory the notice was raised about, when it names one. Null for a notice that is not about a territory. */
  seatId?: string | null;
  title: string;
};

/** What the screens draw: the unread notices of one module, newest first, and how many in all. */
export type PhoenixCrmModuleNotices = {
  count: number;
  notices: PhoenixCrmUnreadNotice[];
};

export type PhoenixCrmUnreadByModule = Partial<Record<PhoenixCrmModuleKey, PhoenixCrmModuleNotices>>;

/** How many notices a module's "new for you" strip names; the badge still counts every one. */
export const PHOENIX_CRM_NOTICE_STRIP_LIMIT = 4;

/**
 * The module a notice opens, read from its own link: `?tab=<module>` (the form every sender writes) or
 * `/field-crm/<slug>` (the form the reminder writes). A link to anywhere else — the admin shell's place
 * check — belongs to no module of the rep's app and so pulses nothing here.
 */
export function phoenixCrmModuleOfNotice(actionUrl: string | null | undefined): PhoenixCrmModuleKey | null {
  const raw = String(actionUrl ?? "").trim();
  if (!raw) return null;
  const queryAt = raw.indexOf("?");
  const path = (queryAt === -1 ? raw : raw.slice(0, queryAt)).replace(/#.*$/, "");
  const marker = "/field-crm/";
  const at = path.indexOf(marker);
  if (at !== -1 && path.startsWith("/employee-portals")) {
    const slug = path.slice(at + marker.length).split("/")[0];
    return phoenixCrmModuleForSlug(slug)?.key ?? null;
  }
  if (queryAt === -1 || !path.endsWith("/field-crm") || !path.startsWith("/employee-portals")) return null;
  const tab = new URLSearchParams(raw.slice(queryAt + 1).replace(/#.*$/, "")).get("tab");
  return isPhoenixCrmModuleKey(tab) ? tab : null;
}

/** Whether this notice is one that pulses at all. */
export function phoenixCrmNoticePulses(eventType: string | null | undefined): boolean {
  return !PHOENIX_CRM_NOTICES_THAT_NEVER_PULSE.includes(String(eventType ?? "").trim().toLowerCase());
}

/** Group a viewer's unread notices by the module each opens. Newest first within a module. */
export function groupUnreadByModule(notices: readonly PhoenixCrmUnreadNotice[]): PhoenixCrmUnreadByModule {
  const grouped: PhoenixCrmUnreadByModule = {};
  const ordered = [...notices].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const notice of ordered) {
    if (!phoenixCrmNoticePulses(notice.eventType)) continue;
    const key = phoenixCrmModuleOfNotice(notice.actionUrl);
    if (!key) continue;
    const entry = (grouped[key] ??= { count: 0, notices: [] });
    entry.count += 1;
    if (entry.notices.length < PHOENIX_CRM_NOTICE_STRIP_LIMIT) entry.notices.push(notice);
  }
  return grouped;
}

/** "3 new", never "99+ new" — the number is a reason to look, not a figure to read. */
export function newBadgeText(count: number): string {
  return `${count > 99 ? "99+" : count} new`;
}
