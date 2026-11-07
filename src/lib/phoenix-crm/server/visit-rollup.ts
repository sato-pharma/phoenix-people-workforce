/**
 * Phoenix CRM — the hourly routine-visit rollup, sent.
 *
 * The I/O half of `src/lib/phoenix-crm/visit-rollup-rules.ts`. It reads the routine PLANNED visits
 * submitted in the previous clock hour, groups them by in-scope manager (the pure
 * `buildVisitRollupRecipients`), and sends one batched message per manager — in-app and Telegram
 * only, the module guard strips the rest.
 *
 * THE WINDOW IS THE PREVIOUS COMPLETED CLOCK HOUR. The cron fires at :49, and the window is
 * [top of the previous hour, top of this hour): at 14:49 it reports 13:00–14:00. Flooring an instant
 * to the hour is identical in Cairo and UTC because Egypt's offset is a whole number of hours, so no
 * timezone arithmetic can get the boundary wrong; the Cairo label is only for the human message.
 * Each hour is reported once, with no overlap, and the idempotency key is that hour — a retried or
 * double-fired cron reaches nobody twice.
 *
 * 🔴 THE READ IS KEYSET-PAGED. `phoenix_crm_visits` crosses PostgREST's 1,000-row cap inside two
 * field days, and a single hour could in a large org approach it; an unpaged read would silently
 * truncate and under-report. Nothing here is ever run from a laptop — it is a production cron, and a
 * hand-run would spend the hour's idempotency key and silence the real one.
 */

import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { PHARMACY_LIST_TYPE } from "@/lib/phoenix-crm/pharmacy-call-rules";
import {
  PHOENIX_CRM_NOTIFICATION_CATEGORY,
  PHOENIX_CRM_NOTIFICATION_MODULE,
  PHOENIX_CRM_PORTAL_PATH,
  sfeManagerHrIds,
} from "@/lib/phoenix-crm/server/notifications";
import { seatIdIsInLiveTeam } from "@/lib/phoenix-crm/live-team-rules";
import { loadLiveTeamSeatIds } from "@/lib/phoenix-crm/server/live-teams";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { personOnTheVisit } from "@/lib/phoenix-crm/location-integrity";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { managerChain } from "@/lib/phoenix-crm/scope";
import {
  buildVisitRollupRecipients,
  planPhoenixCrmVisitRollup,
  VISIT_ROLLUP_EVENT_TYPE,
  type PhoenixCrmVisitRollup,
} from "@/lib/phoenix-crm/visit-rollup-rules";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const HOUR_MS = 60 * 60 * 1000;
/** How many managers are being sent their rollup at once. */
const DELIVERIES_AT_ONCE = 4;
// `manager_hr_id` too (owner, 2026-10-20: "EVERYSINGLE ROLE THATS APLLICABLE TOAPPEAR"): a visit a manager logged on
// a vacant territory carries no rep, and the roll-up named it after nobody. It is now filed under the person on the
// visit — the rep, or the manager when there is no rep (`personOnTheVisit`, the rule the integrity board names by).
const VISIT_COLUMNS = "id, seat_id, rep_hr_id, manager_hr_id";

type VisitRow = { id: string; seat_id: string | null; rep_hr_id: string | null; manager_hr_id: string | null };

export type VisitRollupRun = {
  windowStart: string;
  windowEnd: string;
  visits: number;
  recipients: number;
  delivered: number;
  failed: number;
};

async function deliver(rollup: PhoenixCrmVisitRollup): Promise<void> {
  const actionUrl = `${PHOENIX_CRM_PORTAL_PATH}?tab=team`;
  await createSystemNotificationForRecipients(
    {
      actionUrl,
      category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
      // In-app and Telegram. The module's guard strips email and push whatever is asked for here.
      channels: ["in_app", "telegram"],
      eventType: VISIT_ROLLUP_EVENT_TYPE,
      message: rollup.message,
      metadata: { idempotencyKey: rollup.idempotencyKey },
      module: PHOENIX_CRM_NOTIFICATION_MODULE,
      priority: "normal",
      subjectHrId: rollup.hrId,
      telegram: { ctaLabel: "Open the team board", ctaUrl: actionUrl },
      title: rollup.title,
    },
    [rollup.hrId],
  );
}

/**
 * One pass. Never throws for a single failed delivery: one manager whose Telegram is unlinked must
 * not cost the others their rollup.
 */
export async function runPhoenixCrmVisitRollup(
  send: (rollup: PhoenixCrmVisitRollup) => Promise<void> = deliver,
  now: Date = new Date(),
): Promise<VisitRollupRun> {
  const windowEnd = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const windowStart = new Date(windowEnd.getTime() - HOUR_MS);
  const hourBucket = windowStart.toISOString().slice(0, 13); // "2026-10-05T12" — unique per clock hour
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const windowLabel = `${timeFmt.format(windowStart)}–${timeFmt.format(windowEnd)}`;

  const rows = await fetchAllRowsKeyset<VisitRow>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select(VISIT_COLUMNS)
        .eq("is_test", false)
        .eq("is_unplanned", false)
        .is("linked_from_visit_id", null)
        // A visit copied from iReports360 (converted or not) is the old system's; the roll-up never reads it.
        .is("imported_from_ireports360_at", null)
        .neq("list_type", PHARMACY_LIST_TYPE)
        .gte("captured_at", windowStart.toISOString())
        .lt("captured_at", windowEnd.toISOString()),
    { cursorColumn: "id", cursorOf: (row) => row.id },
  );

  const base: VisitRollupRun = {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    visits: rows.length,
    recipients: 0,
    delivered: 0,
    failed: 0,
  };
  if (rows.length === 0) return base;

  const [org, sfeHrIds, live] = await Promise.all([loadPhoenixCrmOrg(), sfeManagerHrIds(), loadLiveTeamSeatIds()]);
  // Only a LIVE team's visits are rolled up (owner, 2026-10-08); an unreadable gate fails open.
  const liveRows = live ? rows.filter((row) => seatIdIsInLiveTeam(org.seats, row.seat_id, live)) : rows;
  if (liveRows.length === 0) return base;

  // Every id the rollup names or addresses: the reps, the NSMs above each visit's seat, the SFE Managers.
  const needed = new Set<string>(sfeHrIds);
  const personOf = (row: VisitRow) => personOnTheVisit({ managerHrId: row.manager_hr_id, repHrId: row.rep_hr_id });
  for (const row of liveRows) {
    const person = personOf(row);
    if (person) needed.add(person);
    if (row.seat_id) {
      const nsmHrId = managerChain(org, row.seat_id).find((member) => member.seat.tier === "NSM")?.hrId ?? null;
      if (nsmHrId) needed.add(nsmHrId);
    }
  }
  const names = await loadPeopleNames(needed);

  const recipients = buildVisitRollupRecipients(
    liveRows.map((row) => ({ seatId: row.seat_id, repHrId: personOf(row) })),
    org,
    (hrId) => nameOf(names, hrId),
    sfeHrIds,
  );
  const rollups = planPhoenixCrmVisitRollup(recipients, windowLabel, hourBucket);

  // Several managers at once rather than one after another (Phoenix CRM performance audit,
  // 2026-10-16); anyone sent more than one still gets his in their order. Every send is still
  // counted once, delivered or failed.
  const perPerson = new Map<string, PhoenixCrmVisitRollup[]>();
  for (const rollup of rollups) perPerson.set(rollup.hrId, [...(perPerson.get(rollup.hrId) ?? []), rollup]);
  let delivered = 0;
  let failed = 0;
  await mapWithConcurrency([...perPerson.values()], DELIVERIES_AT_ONCE, async (theirs) => {
    for (const rollup of theirs) {
      try {
        await send(rollup);
        delivered += 1;
      } catch (error) {
        failed += 1;
        logError("Phoenix CRM visit rollup delivery failed", {
          labels: { event: "phoenix_crm_visit_rollup_failed", job: "phoenix-crm-visit-rollup" },
          error,
        });
      }
    }
  });

  return { ...base, recipients: rollups.length, delivered, failed };
}
