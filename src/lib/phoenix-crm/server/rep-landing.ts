import { isForbiddenError } from "@/lib/auth/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { canAccess } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPhoenixCrmToday } from "@/lib/phoenix-crm/server/today";
import { addressWithoutTheBrick, stopWhereLine, todayByBrick } from "@/lib/phoenix-crm/today-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

/**
 * Phoenix CRM — the rep's day, small enough to live on his LANDING page.
 *
 * 🔴 OWNER, 2026-09-30, retiring the Today module: "you will retire it from Phoenix CRM, and make
 * something like it — of course not a big tool like this — in the rep's landing page. For example
 * you put the BRICKS as headers, if more than one brick, and under each brick the customers planned
 * to be visited today. When he has visited one it is coloured GREEN; if not visited it is not
 * coloured. And a very small plus sign that redirects him to enter a visit for that person."
 *
 * So this is deliberately thin: the day's planned stops, clustered by brick, each one done or not.
 * No targets, no meters, no Next-up card, no counts — the Today tab had all of that and he is
 * retiring it. It reads the SAME approved-plan rule as before (`loadPhoenixCrmToday`), so a plan
 * still waiting on someone shows nothing here either.
 *
 * It NEVER throws onto the landing page. A rep whose line is closed, whose permission is missing, or
 * whose read fails gets `null` and the panel renders nothing — a landing page that fails to paint
 * because one panel could not load is worse than a landing page missing one panel.
 */

export type RepTodayStop = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  /**
   * Where and when, on one line — the place, and today's receiving hours. His ask of the same
   * morning: "list all of today with timing and location". Carries NOTHING that judges him: no
   * distance, no reading, no check (golden rule #1).
   */
  where: string;
  /** Green when he has already been (owner's own word for it). */
  done: boolean;
};

export type RepTodayBrick = {
  key: string;
  /** The brick's name, or what the module calls a stop with no brick yet. */
  label: string;
  stops: RepTodayStop[];
};

export type RepTodayPlan = {
  /** The VISIT day, Cairo — until 02:00 the day that just ended (owner, 2026-09-29). */
  date: string;
  /**
   * That day as "Tue 30 Sep". It is on the panel BECAUSE of the 02:00 rule: at 01:00 he is still
   * looking at the day that just ended, and a panel headed only "Your day" would read as tomorrow's.
   */
  dateLabel: string;
  /**
   * The one brick he is in today, when the whole day is in one. It goes in the HEADER, because his
   * own condition — bricks head the list only when there is more than one — leaves the single-brick
   * day with nowhere to say where he is.
   */
  soleBrick: string | null;
  territory: string;
  bricks: RepTodayBrick[];
  /** 🔴 AM and PM APART, never a total — the call-rate golden rule reaches every count. */
  amDone: number;
  amPlanned: number;
  pmDone: number;
  pmPlanned: number;
  /** Where his Add-visit "+" sends him: the Visits module's own page. */
  canAdd: boolean;
};

/**
 * "2026-09-30" → "Tue 30 Sep". Built as a UTC instant and formatted as UTC on purpose: the string is
 * a Cairo CALENDAR day, not an instant, and letting the runtime pick a zone would shift it a day.
 */
function cairoDayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
  });
}

export async function loadRepTodayPlan(access: AccessContext): Promise<RepTodayPlan | null> {
  try {
    if (!(await canAccess(access, "phoenix_crm", "read"))) return null;
    const viewer = await resolvePhoenixCrmViewer(access);
    // HIS OWN territory only. This is his landing page, not a manager's board: a District Manager
    // reads his team on the Team module, and putting someone else's day here would be a different
    // panel with different rules.
    const [own] = viewer.ownTerritories;
    if (!own) return null;

    const view = await loadPhoenixCrmToday(viewer, { seatId: own.seatId, test: null });
    if (view.stops.length === 0) return null;

    const groups = todayByBrick(view.stops);
    const bricks: RepTodayBrick[] = groups.map((group) => ({
      key: group.key,
      label: group.label,
      stops: group.rows.map((stop) => ({
        customerId: stop.customerId,
        name: stop.name,
        listType: stop.listType,
        // 🔴 NEITHER THE BRICK NOR THE AREA GOES ON A ROW (owner, 2026-09-30, looking at it: "you
        // don't have to write Menoufia, because she already knows this is her area — and the Bagour
        // is duplicated"). Both are constant for the whole panel: the area is HIS OWN territory, and
        // the brick is either a heading or the header's word on a single-brick day. On the row they
        // printed "باجور · Menoufia 2" sixteen times down a narrow column. What is left is what he
        // asked for that morning and nothing else — the place, and the hours.
        where: stopWhereLine(
          {
            ...stop,
            reference: stop.reference
              ? { ...stop.reference, address: addressWithoutTheBrick(stop.reference.address, stop.brick), area: null }
              : stop.reference,
          },
          null,
        ),
        done: stop.done,
      })),
    }));

    return {
      date: view.date,
      dateLabel: cairoDayLabel(view.date),
      // The stop's OWN brick, not the group's label: `clusterByBrick` labels a group "Brick <name>"
      // for a heading row, and the header read "WED 30 SEPT · BRICK باجور".
      soleBrick: groups.length === 1 ? (view.stops[0]?.brick ?? null) : null,
      territory: view.territory.name,
      bricks,
      amDone: view.counts.doneAm,
      amPlanned: view.counts.plannedAm,
      pmDone: view.counts.donePm,
      pmPlanned: view.counts.plannedPm,
      canAdd: view.canAdd,
    };
  } catch (error) {
    // A closed line and a missing permission are ordinary answers here, not failures to report.
    if (!isForbiddenError(error)) {
      logError("Rep landing: today's plan could not be read", { error, labels: { event: "rep_today_plan_failed" } });
    }
    return null;
  }
}
