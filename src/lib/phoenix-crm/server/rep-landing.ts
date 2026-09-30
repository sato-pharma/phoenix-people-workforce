import { isForbiddenError } from "@/lib/auth/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { canAccess } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPhoenixCrmToday } from "@/lib/phoenix-crm/server/today";
import { todayByBrick } from "@/lib/phoenix-crm/today-rules";
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

    const bricks: RepTodayBrick[] = todayByBrick(view.stops).map((group) => ({
      key: group.key,
      label: group.label,
      stops: group.rows.map((stop) => ({
        customerId: stop.customerId,
        name: stop.name,
        listType: stop.listType,
        done: stop.done,
      })),
    }));

    return {
      date: view.date,
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
