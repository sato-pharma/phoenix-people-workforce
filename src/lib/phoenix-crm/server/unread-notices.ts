/**
 * Phoenix CRM — the viewer's unread notices, for the pulsing badges (owner, 2026-10-08).
 *
 * The rows come from the notifications module (`@/lib/notifications/unread` — the same rows and the same
 * fences as the bell); what this file adds is the module each notice opens (`notice-badge-rules.ts`), so
 * a card can say "3 new" and a module page can name them.
 *
 * Never throws: a badge that cannot be read is a card without a pulse, not a broken page. The one thing
 * that must not happen is a failed read being drawn as "nothing new", so a failure returns `null`, which
 * the screens treat as "draw no badge" — and which is NOT the same as an empty result.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { listUnreadModuleNotices, markNoticesReadForViewer } from "@/lib/notifications/unread";
import { seatIdIsInLiveTeam } from "@/lib/phoenix-crm/live-team-rules";
import type { PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";
import { loadLiveTeamSeatIdsForDisplay } from "@/lib/phoenix-crm/server/live-teams";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import {
  groupUnreadByModule,
  phoenixCrmModuleOfNotice,
  phoenixCrmNoticePulses,
  PHOENIX_CRM_BADGE_WINDOW_DAYS,
  type PhoenixCrmUnreadByModule,
  type PhoenixCrmUnreadNotice,
} from "@/lib/phoenix-crm/notice-badge-rules";

// The notifier's module name, written out so this reader does not pull the whole notifier in for a string.
const PHOENIX_CRM_NOTIFICATION_MODULE = "phoenix_crm";

/** More than this many unread in the window and the badge already says "99+"; nothing is gained by more. */
const MAX_ROWS = 300;

async function loadUnread(access: AccessContext): Promise<PhoenixCrmUnreadNotice[]> {
  const rows = await listUnreadModuleNotices(access, {
    limit: MAX_ROWS,
    module: PHOENIX_CRM_NOTIFICATION_MODULE,
    sinceDays: PHOENIX_CRM_BADGE_WINDOW_DAYS,
  });
  const pulsing = rows.filter((row) => phoenixCrmNoticePulses(row.eventType));
  // A notice about a team that is not live never pulses (owner, 2026-10-08) — including one written
  // before the team was held back. Read only when something is unread; an unreadable gate fails open.
  // The badges are asked every minute by every open screen and only FILTER notices already written, so
  // they take the live teams from the minute-long display copy that a Start or Stop clears at once.
  if (!pulsing.some((row) => row.seatId)) return pulsing;
  const [live, org] = await Promise.all([loadLiveTeamSeatIdsForDisplay(), loadPhoenixCrmOrg()]);
  if (!live) return pulsing;
  return pulsing.filter((row) => !row.seatId || seatIdIsInLiveTeam(org.seats, row.seatId, live));
}

/**
 * The viewer's unread notices grouped by the module each opens, or `null` when they could not be read.
 * A test persona reads only its own world's notices (the same fence as the bell), so a Super Admin
 * playing a rep sees that rep's test pulses and no real ones.
 */
export async function loadPhoenixCrmUnreadByModule(access: AccessContext): Promise<PhoenixCrmUnreadByModule | null> {
  try {
    return groupUnreadByModule(await loadUnread(access));
  } catch (error) {
    logError("phoenix_crm.unread_notices_failed", { labels: { event: "phoenix_crm_unread_notices_failed" }, error });
    return null;
  }
}

/**
 * Mark every unread notice that opens `moduleKey` as read, for the viewer only. Called once the module
 * page is on his screen (never from a server render, which a link prefetch also runs).
 */
export async function markPhoenixCrmModuleNoticesRead(access: AccessContext, moduleKey: PhoenixCrmModuleKey): Promise<{ marked: number }> {
  try {
    const unread = (await loadUnread(access)).filter((notice) => phoenixCrmModuleOfNotice(notice.actionUrl) === moduleKey);
    return { marked: await markNoticesReadForViewer(access, unread.map((notice) => notice.id)) };
  } catch (error) {
    logError("phoenix_crm.unread_notices_mark_failed", { labels: { event: "phoenix_crm_unread_notices_mark_failed" }, error });
    return { marked: 0 };
  }
}
