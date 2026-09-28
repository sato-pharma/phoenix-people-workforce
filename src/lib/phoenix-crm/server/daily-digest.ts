/**
 * Phoenix CRM — the 06:55 digest, sent.
 *
 * The I/O half of `src/lib/phoenix-crm/digest-rules.ts`. Owner, 2026-09-26: **the District Manager,
 * at 06:55 Cairo, about the previous field day** — he is in the car or at breakfast, he has a phone,
 * and the one thing worth his attention before the day starts is which of his reps needs a call this
 * morning.
 *
 * 🔴 A CLEAN MANAGER IS TOLD NOTHING. Not "all good", not a daily tick. A digest that arrives every
 * morning whatever happened is muted within a week, and a muted digest is worse than none because
 * everybody believes it is working.
 *
 * 🔴 AND A TERRITORY NOBODY HAS STARTED IS NOT AN EXCEPTION (owner, 2026-09-28). On the first
 * morning this fired, every manager in the company was messaged about every territory beneath him
 * because no rep had used Phoenix CRM yet. A territory now joins the digest the first time real work
 * appears on it — see `seatsWithRealActivity` — so the digest is quiet during the rollout and turns
 * itself on, territory by territory, as the field moves across. The BOARD still shows everything.
 *
 * ## It judges nothing of its own
 *
 * Every row comes from `gatherExceptions`, the same call the board makes, so the digest and the
 * screen can never disagree about a territory on the same morning. The one difference is the window,
 * and it is deliberate: the board reads six field days because he opens it wanting the trend, the
 * digest reads ONE because at 06:55 he wants yesterday.
 *
 * ## Channels
 *
 * In-app and Telegram. Email cannot escape: `enforcePhoenixCrmEmailBlock` filters on the MODULE key,
 * not on any call site, so this file could ask for email and still not get it. Nothing here is ever
 * run from a laptop — it is a production cron, and a hand-run would spend the idempotency key for
 * the day and silence the real one.
 */

import { currentCairoDateOnlyIso, formatPhoenixLongDate } from "@/lib/i18n/format";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { planPhoenixCrmDigest, type DigestRecipient, type PhoenixCrmDigest } from "@/lib/phoenix-crm/digest-rules";
import { lastFinishedFieldDay } from "@/lib/phoenix-crm/exceptions";
import {
  PHOENIX_CRM_NOTIFICATION_CATEGORY,
  PHOENIX_CRM_NOTIFICATION_MODULE,
  PHOENIX_CRM_PORTAL_PATH,
} from "@/lib/phoenix-crm/server/notifications";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { gatherExceptions } from "@/lib/phoenix-crm/server/exceptions";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPhoenixCrmConfig, openLineCodes } from "@/lib/phoenix-crm/server/settings";
import { isManagerTier, territoriesBelow, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The digest reads the single previous field day — see the header. */
const DIGEST_WINDOW_FIELD_DAYS = 1;

/**
 * Every manager who holds territories, with the seats beneath him.
 *
 * A manager seat with no occupant is skipped: there is nobody to tell, and the vacancy is itself a
 * row on somebody else's digest. A manager holding no territory is skipped too — `planPhoenixCrmDigest`
 * would drop him anyway, but not asking for his name saves a read.
 */
export function digestRecipientsFrom(org: OrgIndex, names: (hrId: string) => string): DigestRecipient[] {
  const byPerson = new Map<string, Set<string>>();
  for (const seat of org.seats.values()) {
    if (!isManagerTier(seat.tier) || !seat.occupantHrId) continue;
    const below = territoriesBelow(org, [seat.seatId]);
    if (below.length === 0) continue;
    const held = byPerson.get(seat.occupantHrId) ?? new Set<string>();
    for (const territory of below) held.add(territory.seatId);
    byPerson.set(seat.occupantHrId, held);
  }
  return [...byPerson]
    .map(([hrId, seatIds]) => ({ hrId, name: names(hrId), seatIds: [...seatIds] }))
    .sort((left, right) => left.hrId.localeCompare(right.hrId));
}

/**
 * The territories that have EVER carried real Phoenix CRM work, out of the ones asked about.
 *
 * "Started" is deliberately the widest, cheapest signal — a visit, a captured place, a plan of either
 * kind, a recorded day, or a list request. Any one of them means a human opened the app and did
 * something on that territory, which is all this gate needs to know; a narrower test (say, a visit
 * only) would keep a rep who is planning but not yet visiting out of his manager's digest.
 *
 * 🔴 REAL ROWS ONLY. Every query filters `is_test`, or a Super Admin's try-out — or a test login's,
 * which carries the mirrored rep's own HR id (src/lib/auth/test-persona.ts) — would switch a real
 * manager's 06:55 message on for a territory nobody has really touched.
 *
 * Errors are not swallowed: a failed read here would silently empty the digest for everybody, which
 * looks exactly like a quiet morning. The cron route reports the throw instead.
 */
export async function seatsWithRealActivity(seatIds: ReadonlyArray<string>): Promise<Set<string>> {
  const started = new Set<string>();
  if (seatIds.length === 0) return started;
  const supabase = getSupabaseAdmin();
  const tables = [
    "phoenix_crm_visits",
    "phoenix_crm_places",
    "phoenix_crm_plans",
    "phoenix_crm_monthly_plans",
    "phoenix_crm_day_activities",
    "phoenix_crm_list_requests",
  ] as const;

  for (const part of chunk([...seatIds], 200)) {
    const reads = await Promise.all(
      tables.map((table) => supabase.from(table).select("seat_id").eq("is_test", false).in("seat_id", part)),
    );
    for (const read of reads) {
      throwIfError(read.error);
      for (const row of (read.data ?? []) as Array<{ seat_id?: string | null }>) {
        if (row.seat_id) started.add(String(row.seat_id));
      }
    }
  }
  return started;
}

export type PhoenixCrmDigestRun = {
  day: string;
  territories: number;
  needingAttention: number;
  recipients: number;
  delivered: number;
  failed: number;
  /**
   * Territories in an open line whose rep has not started yet, and which the digest therefore did
   * not read. Reported so a silent morning can be told apart from a broken one: while the rollout is
   * young this is most of them, and the day it reaches zero the digest is watching the whole field.
   */
  waitingForFirstUse: number;
};

async function deliver(digest: PhoenixCrmDigest): Promise<void> {
  const actionUrl = `${PHOENIX_CRM_PORTAL_PATH}?tab=reports&section=exceptions`;
  await createSystemNotificationForRecipients(
    {
      actionUrl,
      category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
      // In-app and Telegram. The module's guard strips email whatever is asked for here.
      channels: ["in_app", "telegram"],
      eventType: "crm_daily_digest",
      message: digest.message,
      metadata: { idempotencyKey: digest.idempotencyKey },
      module: PHOENIX_CRM_NOTIFICATION_MODULE,
      priority: "normal",
      subjectHrId: digest.hrId,
      telegram: { ctaLabel: "Open the board", ctaUrl: actionUrl },
      title: digest.title,
    },
    [digest.hrId],
  );
}

/**
 * One pass of the digest. Never throws for a single failed delivery: one manager whose Telegram is
 * unlinked must not cost the other eleven their morning message.
 */
export async function runPhoenixCrmDailyDigest(
  send: (digest: PhoenixCrmDigest) => Promise<void> = deliver,
): Promise<PhoenixCrmDigestRun> {
  const cairoToday = currentCairoDateOnlyIso();
  const [org, config] = await Promise.all([loadPhoenixCrmOrg(), loadPhoenixCrmConfig()]);
  const openLines = openLineCodes(config.lineRollout, cairoToday);
  // Open lines only. A territory whose line has not opened has nothing to report and its rep has no
  // app to have used — putting it on a manager's 06:55 message would be an accusation about a
  // decision that is the owner's, not the rep's.
  const openSeats: OrgSeat[] = org.territories.filter((seat) => Boolean(seat.lineCode && openLines.has(seat.lineCode)));
  const day = lastFinishedFieldDay(cairoToday);

  // 🔴 AND ONLY THE TERRITORIES WHOSE REP HAS ACTUALLY STARTED (owner, 2026-09-28).
  //
  // The line opening is the owner's decision; a rep beginning to use the app is not, and on the
  // first morning it fired this digest told every manager in the company about every territory
  // beneath him — 24 recipients, up to 38 lines each — because not one rep had used Phoenix CRM
  // yet, so "no visits yesterday" was true everywhere. That is the shape the whole feature exists
  // to avoid: a message that arrives every morning whatever happened is muted inside a week.
  //
  // So a territory joins the digest on its own, the first time anything real appears on it, and the
  // digest stays silent until then. It needs no stand-down to undo and nothing to remember: as reps
  // move across from iReports360 the digest turns itself on territory by territory, and the first
  // message a manager gets is about a rep who was actually working.
  //
  // THE BOARD IS DELIBERATELY UNCHANGED — the exceptions screen still shows every territory, because
  // a manager who opens it is ASKING, and "nobody has started" is exactly what he needs to see there.
  // This narrows what is PUSHED at 06:55, never what can be read.
  const started = await seatsWithRealActivity(openSeats.map((seat) => seat.seatId));
  const seats = openSeats.filter((seat) => started.has(seat.seatId));

  const board = await gatherExceptions({
    seats,
    isTest: false,
    cairoToday,
    config,
    windowFieldDays: DIGEST_WINDOW_FIELD_DAYS,
  });

  const managerIds = [...org.seats.values()].filter((seat) => isManagerTier(seat.tier)).map((seat) => seat.occupantHrId);
  const names = await loadPeopleNames(managerIds);
  const recipients = digestRecipientsFrom(org, (hrId) => nameOf(names, hrId));
  const digests = planPhoenixCrmDigest(board.rows, recipients, day, formatPhoenixLongDate(day));

  let delivered = 0;
  let failed = 0;
  for (const digest of digests) {
    try {
      await send(digest);
      delivered += 1;
    } catch (error) {
      failed += 1;
      logError("Phoenix CRM digest delivery failed", {
        labels: { event: "phoenix_crm_digest_failed", job: "phoenix-crm-daily-digest" },
        error,
      });
    }
  }

  return {
    day,
    territories: board.summary.territories,
    needingAttention: board.summary.needingAttention,
    recipients: digests.length,
    delivered,
    failed,
    waitingForFirstUse: openSeats.length - seats.length,
  };
}
