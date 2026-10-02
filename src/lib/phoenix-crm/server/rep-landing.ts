import { isForbiddenError } from "@/lib/auth/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { canAccess } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPhoenixCrmToday } from "@/lib/phoenix-crm/server/today";
import { addressWithoutTheBrick, alsoTodayParts, stopWhereParts, todayByBrick } from "@/lib/phoenix-crm/today-rules";
import type { PhoenixCrmGrade, PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { weekProgressParts } from "@/lib/phoenix-crm/week-progress";

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
   * 🔴 THE GRADE AND THE SPECIALITY GO ON EVERY ROW (owner, recording the old CRM on 2026-09-29:
   * its dashboard "shows him my visits of today, with the specialities, with the grades"). The grade
   * is the A/B/C on his own list — the one his frequency is counted against — so it is his own work,
   * never a judgement of him. Both come straight off the day's stops; nothing is read twice.
   */
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  /**
   * Where and when, on one line — the place, and today's receiving hours. His ask of the same
   * morning: "list all of today with timing and location". Carries NOTHING that judges him: no
   * distance, no reading, no check (golden rule #1).
   *
   * The line's PARTS, not the joined string: the panel isolates each one, because joined, an Arabic
   * place scrambles the hours beside it (`stopWhereParts` says how).
   */
  where: string[];
  /**
   * The way to that place in Google Maps (owner, 2026-10-02), or null when no place with a usable
   * point is saved — and then the row carries no link. The way to HIS OWN customer, nothing more.
   */
  directionsUrl: string | null;
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
  /**
   * 🔴 AM and PM APART, never a total — the call-rate golden rule reaches every count.
   *
   * `amDone` and `pmDone` are the PLANNED stops he has done, never every visit he logged today: the
   * planned figure is the denominator the chip divides by, so a numerator from a wider set turned
   * "AM 3 of 2" green with a planned stop still undone (`TodayCounts.doneAm`). What he did off the
   * plan is `alsoParts`, beside them.
   */
  amDone: number;
  amPlanned: number;
  pmDone: number;
  pmPlanned: number;
  /**
   * 🔴 THE THIRD FIGURE — the pharmacies he took feedback from today, counted APART from AM and PM
   * (the AM · PM · Pharmacies golden rule). His own ask the same morning was "am/pm/ph"; the count
   * was built for the Today module, outlived it, and he put it back here (owner, 2026-09-30).
   *
   * There is no denominator, on purpose: a pharmacy is feedback recorded ON a visit, so there is
   * nothing to plan against one and no "n of m" to print. It reads the whole day's visits, including
   * one made off the plan, and is NEVER added into `amDone` or `pmDone`.
   */
  pharmaciesDone: number;
  /**
   * What he did TODAY off the plan, beside it — "AM 1", "PM 2" (`alsoTodayParts`). It is the work the
   * chips used to swallow: before 2026-10-02 an off-plan visit was added into `amDone`/`pmDone`, so
   * the plan's own figure passed its denominator. Apart, both figures are true. Empty on a day he
   * went nowhere off plan, and then the panel draws no line.
   */
  alsoParts: string[];
  /** Where his Add-visit "+" sends him: the Visits module's own page. */
  canAdd: boolean;
  /**
   * 🔴 HIS OWN WEEK, IN ONE LINE (owner, 2026-10-02): what his sent plan holds for the field week and
   * what he has visited so far — "AM 10 planned · 6 visited", "PM 50 planned · 28 visited",
   * "Pharmacies 4". THREE FIGURES APART, as the header's chips: never a total, never a slash, never
   * averaged (`weekProgressParts`). Empty when there is nothing to say, and then there is no line.
   */
  weekParts: string[];
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
        // `grade` is optional on a stop (one built before the Next-up card read it), so a missing one
        // is "no grade" here, and the row says so rather than leaving a gap.
        grade: stop.grade ?? null,
        speciality: stop.speciality,
        // 🔴 NEITHER THE BRICK NOR THE AREA GOES ON A ROW (owner, 2026-09-30, looking at it: "you
        // don't have to write Menoufia, because she already knows this is her area — and the Bagour
        // is duplicated"). Both are constant for the whole panel: the area is HIS OWN territory, and
        // the brick is either a heading or the header's word on a single-brick day. On the row they
        // printed "باجور · Menoufia 2" sixteen times down a narrow column. What is left is what he
        // asked for that morning and nothing else — the place, and the hours.
        where: stopWhereParts(
          {
            ...stop,
            reference: stop.reference
              ? { ...stop.reference, address: addressWithoutTheBrick(stop.reference.address, stop.brick), area: null }
              : stop.reference,
          },
          null,
        ),
        directionsUrl: stop.directionsUrl ?? null,
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
      pharmaciesDone: view.counts.donePharmacies,
      alsoParts: alsoTodayParts(view.counts),
      canAdd: view.canAdd,
      weekParts: weekProgressParts(view.week),
    };
  } catch (error) {
    // A closed line and a missing permission are ordinary answers here, not failures to report.
    if (!isForbiddenError(error)) {
      logError("Rep landing: today's plan could not be read", { error, labels: { event: "rep_today_plan_failed" } });
    }
    return null;
  }
}
