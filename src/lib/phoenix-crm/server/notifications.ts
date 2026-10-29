/**
 * Phoenix CRM — who is told what.
 *
 * Owner rules: in-app, Telegram and the phone; email ONLY for the event types the module's guard lists
 * (src/lib/notifications/phoenix-crm-channel-guard.ts — the policy row is the intent, the guard the
 * enforcement). Since 2026-10-08 (owner: "email for every action on CRM to the person responsible") that is
 * every person-to-person step: a plan sent / approved / returned, a request waiting / decided, an off-plan
 * visit waiting / moving, a visit ask and its answer, and each step of a plan edit. `phoenixCrmChannels`
 * answers for each event type; this file never names a channel.
 *
 * 🔴 THE TEST WORLD TELLS THE TEST ACCOUNTS, AND ONLY THEM (owner, 2026-09-28). A test-world notice
 * is addressed to the employee it mirrors — that is the id the bell queries by — and carries the
 * mirroring `TEST-` login as its marker, which is what keeps it off HER bell and on his. It is
 * in-app only: her Telegram chat, her push subscription and her email address are hers, and a test
 * entry reaching any of them is the one thing test accounts exist to prevent. An entry by a Super
 * Admin playing in the test world, whom no test account mirrors, still tells nobody.
 *
 *   - a grade or drop request waits      → the territory's reviewing manager;
 *   - a request is decided               → the rep who asked;
 *   - a weekly plan is sent for review   → the reviewing manager;
 *   - a plan is approved or returned     → the rep; a plan the SFE Manager returns also tells the
 *                                          reviewing manager, whose approval it undoes.
 *
 *   - a rep asks to edit a sent week, and each step after it (owner, 2026-10-01) → the next person to
 *                                          act (the district manager, then SFE, then HR — Omar
 *                                          Gawish), the rep, the district manager and the SFE
 *                                          Manager, minus whoever just acted. Email, in-app and
 *                                          Telegram.
 *
 *   - a CNS rep sends his daily forecast → the territory's reviewing manager (his district manager),
 *                                          IN-APP ONLY, once a day (owner, 2026-10-01: "an in-app
 *                                          alert to the district manager when a CNS rep sends his
 *                                          daily forecast"). A re-send updates the same alert.
 *
 *   - a rep asks for a visit with somebody (owner, 2026-10-02) → the person asked (his manager, the
 *                                          product manager he picked, or for a chain visit his district
 *                                          manager), and the person told: the manager above for a chain
 *                                          visit ("both are told"), and the rep's district manager for a
 *                                          product manager's visit — IN-APP ONLY, a courtesy he does not
 *                                          act on. The answer tells the rep, and the person told again.
 *                                          A cancelled ask is not announced: its notices are withdrawn.
 *
 *   - a rep submits his FIRST visit ever   → EVERY occupied manager seat above him — his district
 *     (owner, 2026-10-03)                    manager, a regional manager where his line has one, his
 *                                          national sales manager — and the SFE Managers, BY EMAIL (and
 *                                          in-app, Telegram and the phone), with the owner on the BCC of
 *                                          every email the system sends. He named three and then added
 *                                          the Pedia RSM the same day, so the line is the TIER, not a
 *                                          person. It is an adoption notice, not a decision: ONE per rep,
 *                                          ever, keyed on the REP so nothing can send it twice, and
 *                                          nobody who gets it has anything to do. The rep himself is
 *                                          never told — Golden Rule #1: his app does not tell him he is
 *                                          being watched begin.
 *
 * A PLANNED visit tells nobody: double and chain visits count straight away, and a far visit is
 * flagged on the manager's screens rather than pushed (about 600 visits a working day). An OFF-PLAN
 * visit is the one exception (owner, 2026-09-26) — it counts in nothing until it is approved, so the
 * manager who must approve it is told, and the rep is told each time it moves. 🔴 AND SINCE
 * 2026-10-02 SO IS THE SFE MANAGER, WHEN THE VISIT REACHES HIS STEP — whether it started there
 * because the territory's chain is vacant, or a manager passed it on. Both were silent before: the
 * rep read "it counts once SFE approves it too" and SFE had never heard of the visit.
 *
 * Never throws: a notice that cannot be delivered must not undo a saved decision.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { bidiIsolate } from "@/emails/bidi";
import { formatPhoenixDateTime, formatPhoenixLongDate, formatPhoenixMonth } from "@/lib/i18n/format";
import { phoenixCrmChannels } from "@/lib/notifications/phoenix-crm-channel-guard";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { withdrawInAppNotificationsByEventKeyPrefix } from "@/lib/notifications/in-app";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { afterResponse } from "@/lib/http/after-response";
import { testAccountsMirroring } from "@/lib/auth/test-persona-directory";
import { logError } from "@/lib/observability/log";
import { minuteClock } from "@/lib/phoenix-crm/day-start-rules";
import { dropReasonLabel } from "@/lib/phoenix-crm/entry-rules";
import { LOCATION_NOT_CONFIRMED_TEXT, LOCATION_NOT_CONFIRMED_TITLE } from "@/lib/phoenix-crm/google-place-rules";
import { managerPlannerTitle, type ManagerPlannerKind } from "@/lib/phoenix-crm/manager-plan-rules";
import { PHOENIX_CRM_ADMINISTRATOR_HR_ID, planEditStatusLabel, type PlanEditStatus } from "@/lib/phoenix-crm/plan-edit-rules";
import { seatHasLiveTeamBelow, seatIsInLiveTeam } from "@/lib/phoenix-crm/live-team-rules";
import { phoenixCrmModulePath } from "@/lib/phoenix-crm/modules";
import { loadLiveTeamSeatIds } from "@/lib/phoenix-crm/server/live-teams";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { managerChain, personKey, territoryName, territoryReviewer, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmListType, PhoenixCrmRequestKind } from "@/lib/phoenix-crm/types";
import type { UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";
import { sharedPlaceRefusalRepText, validationRefusalRepText } from "@/lib/phoenix-crm/validation-feedback";
import type { VisitAskKind } from "@/lib/phoenix-crm/visit-ask-rules";
import { RECORDED_VISIT_DECISION_MANAGER_LEVELS } from "@/lib/phoenix-crm/visit-recording-rules";

export const PHOENIX_CRM_NOTIFICATION_MODULE = "phoenix_crm";
export const PHOENIX_CRM_NOTIFICATION_CATEGORY = "phoenix_crm";
export const PHOENIX_CRM_PORTAL_PATH = "/employee-portals/field-crm";
/** The double-visit requests report (owner, 2026-10-16): the page every double-visit notice opens. */
export const DOUBLE_VISIT_REQUESTS_PATH = "/employee-portals/double-visit-requests";

/**
 * How a decision's decider is named in a notice. The Administrator is always "The Administrator" — never
 * Omar's name, never HR, never an "override" (owner, 2026-10-08).
 */
function deciderNameOf(names: PeopleNames, hrId: string, fallback: string): string {
  return personKey(hrId) === personKey(PHOENIX_CRM_ADMINISTRATOR_HR_ID) ? "The Administrator" : nameOf(names, hrId, fallback);
}

export type PhoenixCrmNotice =
  | {
      kind: "request_created";
      org: OrgIndex;
      seat: OrgSeat;
      requestId: string;
      requestKind: PhoenixCrmRequestKind;
      requesterHrId: string;
      customerName: string;
      listType: PhoenixCrmListType;
      proposedGrade: string | null;
      dropReason: string | null;
    }
  | {
      kind: "request_decided";
      seat: OrgSeat;
      requestId: string;
      requestKind: PhoenixCrmRequestKind;
      status: "approved" | "refused";
      deciderHrId: string;
      requesterHrId: string;
      customerName: string;
      proposedGrade: string | null;
      note: string | null;
      /** An approval the Administrator took back (owner, 2026-10-08): "refused", worded as a reversal. */
      reversed?: boolean;
    }
  | {
      /** SFE sent a waiting request back to the rep for a comment (owner, 2026-10-12). Told to the rep alone. */
      kind: "request_returned";
      seat: OrgSeat;
      requestId: string;
      requestKind: PhoenixCrmRequestKind;
      returnerHrId: string;
      requesterHrId: string;
      customerName: string;
      note: string;
      /** When it was returned — a request can be returned again after the rep answers, so it keys the notice. */
      returnedAt: string;
    }
  | {
      /** The rep answered a request SFE returned (owner, 2026-10-12). Told to the SFE who returned it. */
      kind: "request_answered";
      seat: OrgSeat;
      requestId: string;
      requestKind: PhoenixCrmRequestKind;
      requesterHrId: string;
      returnerHrId: string;
      customerName: string;
      reply: string;
      answeredAt: string;
    }
  | {
      kind: "plan_submitted";
      org: OrgIndex;
      seat: OrgSeat;
      planId: string;
      version: number;
      weekStart: string;
      submitterHrId: string;
      /**
       * The SFE Manager who RETURNED this week, when he is the one who did and the rep has now sent it
       * again (2026-10-08). He asked for the change and nothing told him it had come back: the plan's
       * actionable notice belongs to the reviewing manager, because the SFE returns a week and approves
       * none. Null for a week returned by its own reviewer, or never returned at all.
       */
      returnedBySfeHrId?: string | null;
    }
  | {
      kind: "plan_decided";
      org: OrgIndex;
      seat: OrgSeat;
      planId: string;
      version: number;
      weekStart: string;
      status: "approved" | "returned";
      deciderHrId: string;
      decidedAs: "reviewer" | "sfe" | "administrator";
      repHrIds: string[];
      note: string | null;
      /** The ONE day returned, when only that day went back (owner, 2026-10-02); the notice names it. */
      returnedDay?: string | null;
    }
  | {
      kind: "monthly_plan_submitted";
      org: OrgIndex;
      seat: OrgSeat;
      monthlyPlanId: string;
      version: number;
      monthStart: string;
      submitterHrId: string;
    }
  | {
      kind: "monthly_plan_decided";
      org: OrgIndex;
      seat: OrgSeat;
      monthlyPlanId: string;
      version: number;
      monthStart: string;
      status: "approved" | "returned";
      deciderHrId: string;
      decidedAs: "reviewer" | "sfe" | "administrator";
      repHrIds: string[];
      note: string | null;
    }
  | {
      kind: "unplanned_visit_raised";
      org: OrgIndex;
      seat: OrgSeat;
      visitId: string;
      repHrId: string;
      customerName: string;
      visitDate: string;
      clarification: string;
      /**
       * The Super Admin entered it for the rep, who missed logging it (owner, 2026-10-01) — so the
       * reason is the Super Admin's words, not the rep's, and the notice says whose they are.
       */
      enteredByAdmin?: boolean;
    }
  | {
      kind: "plan_edit";
      org: OrgIndex;
      seat: OrgSeat;
      requestId: string;
      /** The request's version after this step — every step moves it, so every step's key is its own. */
      version: number;
      weekStart: string;
      /** Where the request stands after this step. */
      status: PlanEditStatus;
      repHrId: string;
      /** Who just acted: the rep on a raise, the decider on a step. Told nothing about his own act. */
      actorHrId: string;
      note: string | null;
      /** A reopened week the Administrator closed again (owner, 2026-10-08): "refused", worded as a reversal. */
      reversed?: boolean;
    }
  | {
      kind: "forecast_sent";
      org: OrgIndex;
      seat: OrgSeat;
      /** The forecast's own Cairo business day, as the save wrote it. */
      day: string;
      repHrId: string;
    }
  | {
      kind: "unplanned_visit_decided";
      org: OrgIndex;
      seat: OrgSeat;
      visitId: string;
      version: number;
      repHrId: string;
      customerName: string;
      visitDate: string;
      status: UnplannedVisitStatus;
      deciderHrId: string;
      note: string | null;
      /** An approval the Administrator took back (owner, 2026-10-08): "refused", worded as a reversal. */
      reversed?: boolean;
      /**
       * The rep's written "why I went". It rides along so the copy the SFE step gets when a manager
       * passes the visit on carries the reason, exactly as the manager's own copy did — he should not
       * have to open the row to learn what he is being asked about.
       */
      clarification: string | null;
    }
  | {
      /**
       * A rep's FIRST visit on Phoenix CRM, ever (owner, 2026-10-03). An adoption notice to his district
       * manager, his national sales manager and the SFE Manager, by email; never to the rep.
       */
      kind: "first_visit";
      org: OrgIndex;
      seat: OrgSeat;
      visitId: string;
      repHrId: string;
      customerName: string;
      /**
       * The SERVER's own stamp on the visit (`captured_at`), which is the time the email reports. Never
       * the phone's clock — that is the whole reason the save returns it.
       */
      capturedAt: string;
    }
  | {
      /**
       * The Administrator approved or refused a recorded visit, with his comment (owner, 2026-10-17:
       * "reject or approve with a comment and this comment goes email and telegram to the rep and his
       * manager and his manager of manager"). Told to the rep and the two manager seats nearest above him.
       */
      kind: "recorded_visit_decided";
      org: OrgIndex;
      seat: OrgSeat;
      visitId: string;
      repHrId: string;
      customerName: string;
      visitDate: string;
      decision: "approved" | "refused";
      deciderHrId: string;
      note: string | null;
    }
  | {
      kind: "visit_ask";
      seat: OrgSeat;
      askId: string;
      askKind: VisitAskKind;
      /** Where the ask stands after this step: just raised, or answered. A cancel is never announced. */
      status: "waiting" | "accepted" | "declined";
      repHrId: string;
      askedHrId: string;
      /** The manager above (a chain visit) or the rep's district manager (a product manager's visit). */
      toldHrId: string | null;
      customerName: string;
      listType: PhoenixCrmListType;
      wishedOn: string | null;
      /** The day the person asked picked, once accepted. */
      visitOn: string | null;
    }
  | {
      /**
       * A rep's REQUEST for a double visit, raised by the last question of his visit (owner,
       * 2026-10-16): up to three field days, any number of the people offered, each answering on his
       * own. `raised` tells every person asked; `days_changed` tells those still waiting (the rep
       * edited the days — he can never cancel); `accepted` / `declined` tell the rep which person
       * answered. A cancel does not exist, so there is no such step.
       */
      kind: "double_visit_request";
      seat: OrgSeat;
      requestId: string;
      step: "raised" | "days_changed" | "accepted" | "declined";
      repHrId: string;
      /** raised / days_changed: the people to tell. accepted / declined: the person who answered. */
      askedHrIds: string[];
      customerName: string;
      listType: PhoenixCrmListType;
      /** The days the rep offers, earliest first. */
      days: string[];
      /** The day the person accepted. Null for every other step. */
      visitOn: string | null;
      /** Which edit this is (the request's `edit_count`), so a second change is not swallowed by the first's key. */
      version: number;
    }
  | {
      /**
       * A rep pressed "Show your manager you started working" (owner, 2026-10-03). His district
       * manager and the SFE Manager are told the time AND where he was — the one Phoenix CRM notice
       * that reports a rep's position to his managers, which the owner ruled explicitly ("their
       * location and their time send to managers") and which the button tells him before he presses.
       */
      kind: "day_start";
      org: OrgIndex;
      seat: OrgSeat;
      repHrId: string;
      /** The SERVER's stamp — the only start time anybody is judged by. */
      startedAt: string;
      lat: number;
      lon: number;
      /** What his sent plan said he would start the morning at, when he had one. */
      plannedAmMinute: number | null;
    }
  | {
      /**
       * 🔴 THE ONE NOTICE IN THIS MODULE THAT TELLS A REP HIS OWN WORK WAS TURNED DOWN (owner,
       * 2026-10-08, after he was shown that the mandatory note on a refusal was the single character
       * "-" in 22 of 24 refusals and that 0 of the 22 reopened customers had been validated again,
       * average wait 40.8 hours): "tell the rep why", from a fixed pick-list.
       *
       * 🔴 A NARROW, DELIBERATE BEND OF GOLDEN RULE #1 AND NOTHING WIDER. What travels is what is
       * wrong with HIS PHOTO, chosen from the closed six-item list in
       * `@/lib/phoenix-crm/validation-feedback` — never the free-text note the Super Admin writes for
       * the record, never who decided, never that anybody decided, never a distance, a reading or a
       * threshold. In-app only, and push-blocked as well (`PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES`): no
       * email, no Telegram, no phone, ever.
       */
      kind: "validation_not_confirmed";
      seat: OrgSeat;
      repHrId: string;
      customerId: string;
      customerName: string;
      /**
       * The review row this refusal is recorded on — or, when `via` is `shared_place`, the VENUE's
       * own id, because a venue carries its decision on its own row and has no review row at all.
       * Either way it is the one thing the refusal happened to, which is what the key below needs.
       */
      reviewId: string;
      /** A key from `VALIDATION_REFUSAL_REASON_KEYS`. Null only for a caller that sent none. */
      reason: string | null;
      /**
       * WHOSE photo was refused. `place` (the default) — his own capture of this customer.
       * `shared_place` — the polyclinic or centre he seated the customer in, refused as a whole,
       * which sends every customer seated there back to To validate. The two take DIFFERENT wording
       * and that is not a nicety: the six signboard sentences name this customer's OWN door, which a
       * seated customer has not got, so `sharedPlaceRefusalRepText` answers for a venue.
       */
      via?: "place" | "shared_place";
      /**
       * 🔴 WHICH REFUSAL THIS IS, AND WHY IT HAD TO EXIST (owner, 2026-10-15). The key below is
       * `customer:review`, and a VENUE refusal puts the venue's own id in that second half — which
       * was one key per refusal FOR EVER only while a rejected venue could never come back. Now that
       * it can (`restoreSharedPlace`), the same building can be rejected, brought back and rejected
       * again, and the second refusal would land on the first one's key and reach the rep in SILENCE
       * — the exact failure `tellSeatedRepsValidateAgain` was written to end. So the caller passes
       * the decision's own instant and it rides on the END of the key, leaving the
       * `phoenix_crm:validation_not_confirmed:<customer>:` PREFIX that
       * `withdrawValidationNotConfirmed` clears by untouched.
       */
      attempt?: string | null;
    }
  | ManagerPlanNotice;

/**
 * The district manager's weekly plan (owner, 2026-10-16) — each step told to the ONE person it concerns:
 * a week, an ask to edit it or an own-list removal waiting goes to whoever decides it, and the answer goes
 * back to the district manager. 🔴 NEVER THE REP — the plan is the district manager's alone and the rep
 * never learns it exists — and never the activity mirror (`activityMirrorDelivery` returns null for it):
 * the managers above him are the ones deciding. The live-team gate reads `seat`, his own seat.
 *
 * Widened (owner, 2026-10-17) to the regional, national and product managers: a regional or national
 * sales manager's `seat` is his own, and the gate asks for any live team BELOW it; a product manager sits
 * on no seat (`seat` null) and plans across his lines, so his notices pass the gate.
 */
export type ManagerPlanNotice = {
  kind: "manager_plan";
  seat: OrgSeat | null;
  /** What the manager plans as — names him in the message ("A regional sales manager") when no name reads. */
  plannerKind?: ManagerPlannerKind;
  step:
    | "waiting"
    | "approved"
    | "returned"
    | "edit_waiting"
    | "edit_reopened"
    | "edit_refused"
    | "edit_expired"
    | "removal_waiting"
    | "removal_decided"
    | "single_visit_day_waiting"
    | "single_visit_day_decided"
    | "single_visit_day_expired"
    | "with_you";
  recipientHrId: string;
  managerHrId: string;
  /** Who took the step — null for the system (an expired ask). */
  actorHrId: string | null;
  /** The plan, the ask to edit, or the own-list customer the step is about. */
  recordId: string;
  planId: string | null;
  weekStart: string | null;
  /** Keys a step that can happen again on the same record (a week sent, returned and sent again). */
  version: number | null;
  note: string | null;
  customerName: string | null;
  byAdministrator: boolean;
  returnedDay?: string | null;
  /** The removal was approved (true) or refused (false). */
  approved?: boolean;
  /** The week reached its approver after its Thursday deadline. */
  late?: boolean;
  /** An ask reaching its SECOND approver: the actor is the regional manager who agreed first. */
  secondStep?: boolean;
  /** The date an ask for another day of single visits names (owner, 2026-10-20). */
  visitDate?: string | null;
  /**
   * `with_you`: the half-days of an approved district manager's week that name the recipient as the manager
   * or product manager he goes with (owner, 2026-10-24: "calendar + notice"), in date order.
   */
  withYou?: ReadonlyArray<{ date: string; half: "AM" | "PM"; areaName: string | null }>;
};

/** The planning calendar a picked manager opens to see the half-days planned with him. */
export const MANAGER_PLAN_WITH_YOU_PATH = "/employee-portals/plans/calendar";

/** The Approvals Hub page a waiting district-manager step opens on. */
export function managerPlanHubPath(recordId: string): string {
  return `/employee-portals/approvals/plan/${encodeURIComponent(recordId)}`;
}

/** Every notice raised about one district-manager plan record, of every step. */
export function managerPlanNoticeKeyPrefix(recordId: string): string {
  return `phoenix_crm:manager_plan:${recordId}:`;
}

/** The deliveries of one district-manager plan step, given the people's names. Pure, so who is told and the keys are tested. */
export function managerPlanDeliveries(notice: ManagerPlanNotice, names: PeopleNames): Delivery[] {
  const manager = nameOf(names, notice.managerHrId, `A ${managerPlannerTitle(notice.plannerKind ?? "dm").toLowerCase()}`);
  const actor = notice.byAdministrator ? "The Administrator" : notice.actorHrId ? nameOf(names, notice.actorHrId, "Your manager") : "The system";
  const week = notice.weekStart ? `the week starting ${formatPhoenixLongDate(notice.weekStart)}` : "your week";
  const note = notice.note ? ` Note: ${notice.note}` : "";
  const key = `${managerPlanNoticeKeyPrefix(notice.recordId)}${notice.step}:${notice.version ?? 0}:${personKey(notice.recipientHrId) ?? notice.recipientHrId}`;
  const toHub = { recordId: notice.recordId, path: managerPlanHubPath(notice.recordId), tab: "plan" as const };
  const toPlan = { recordId: notice.recordId, tab: "plan" as const };
  const base = { recipients: [notice.recipientHrId], idempotencyKey: key, subjectHrId: notice.managerHrId };
  const planMeta = notice.planId ? { planId: notice.planId } : undefined;
  const customer = notice.customerName ? bidiIsolate(notice.customerName) : "a customer";
  const visitDay = notice.visitDate ? formatPhoenixLongDate(notice.visitDate) : "a day";
  const agreedFirst = notice.secondStep ? ` ${actor} approved it first; it needs your approval too.` : "";

  switch (notice.step) {
    case "waiting":
      return [
        {
          ...base,
          ...toHub,
          eventType: "manager_plan_waiting",
          title: `Weekly plan to approve: ${manager}`,
          message: `${manager} sent ${week} for your approval${notice.late ? ", after the Thursday deadline" : ""}. Approve it or return it in the Approvals Hub.`,
          metadata: planMeta,
        },
      ];
    case "approved":
      return [
        {
          ...base,
          ...toPlan,
          eventType: "manager_plan_approved",
          title: "Your weekly plan is approved",
          message: `${actor} approved ${week}.${note}`,
          metadata: planMeta,
        },
      ];
    case "returned":
      return [
        {
          ...base,
          ...toPlan,
          eventType: "manager_plan_returned",
          title: notice.returnedDay ? `One day of your weekly plan was returned` : "Your weekly plan was returned",
          message: notice.returnedDay
            ? `${actor} returned ${formatPhoenixLongDate(notice.returnedDay)} of ${week}. Change it and send the week again.${note}`
            : `${actor} returned ${week}. Change it and send it again.${note}`,
          metadata: planMeta,
        },
      ];
    case "edit_waiting":
      return [
        {
          ...base,
          ...toHub,
          eventType: "manager_plan_edit_waiting",
          title: `Ask to edit a weekly plan: ${manager}`,
          message: `${manager} asks to edit ${week}, already sent.${note}${agreedFirst} Reopen it or refuse in the Approvals Hub.`,
          metadata: { requestId: notice.recordId, ...(planMeta ?? {}) },
        },
      ];
    case "edit_reopened":
      return [
        {
          ...base,
          ...toPlan,
          eventType: "manager_plan_edit_reopened",
          title: "Your weekly plan is open to edit",
          message: `${actor} reopened ${week}. Change it and send it again.${note}`,
          metadata: planMeta,
        },
      ];
    case "edit_refused":
      return [
        {
          ...base,
          ...toPlan,
          eventType: "manager_plan_edit_refused",
          title: "Your ask to edit was refused",
          message: `${actor} refused your ask to edit ${week}. It stays as it was sent.${note}`,
          metadata: planMeta,
        },
      ];
    case "edit_expired":
      return [
        {
          ...base,
          ...toPlan,
          eventType: "manager_plan_edit_expired",
          title: "Your ask to edit ended with its week",
          message: `Nobody answered your ask to edit ${week} before the week ended, so it stays as it was sent.`,
          metadata: planMeta,
        },
      ];
    case "removal_waiting":
      return [
        {
          ...base,
          ...toHub,
          eventType: "manager_list_removal_waiting",
          title: `Take a customer off Manager's own list: ${manager}`,
          message: `${manager} asks to take ${customer} off Manager's own list.${note}${agreedFirst} Approve or refuse it in the Approvals Hub.`,
          metadata: { requestId: notice.recordId },
        },
      ];
    case "removal_decided":
      return [
        {
          ...base,
          recordId: notice.recordId,
          tab: "team",
          eventType: "manager_list_removal_decided",
          title: notice.approved ? "A customer came off your own list" : "Your customer stays on your own list",
          message: notice.approved
            ? `${actor} approved taking ${customer} off Manager's own list.${note}`
            : `${actor} refused taking ${customer} off Manager's own list.${note}`,
        },
      ];
    case "single_visit_day_waiting":
      return [
        {
          ...base,
          ...toHub,
          eventType: "manager_single_visit_day_waiting",
          title: `Another day of single visits to approve: ${manager}`,
          message: `${manager} asks for ${visitDay} as another day of single visits this week.${note}${agreedFirst} Approve or refuse it in the Approvals Hub.`,
          metadata: { requestId: notice.recordId },
        },
      ];
    case "single_visit_day_decided":
      return [
        {
          ...base,
          ...toPlan,
          eventType: "manager_single_visit_day_decided",
          title: notice.approved ? `${visitDay} is approved for single visits` : `${visitDay} is refused for single visits`,
          message: notice.approved
            ? `${actor} approved ${visitDay} as another day of single visits. Plan or log single visits on it.${note}`
            : `${actor} refused ${visitDay} as another day of single visits.${note}`,
        },
      ];
    case "with_you": {
      const halves = notice.withYou ?? [];
      if (halves.length === 0) return [];
      const list = halves
        .map((entry) => `${formatPhoenixLongDate(entry.date)} ${entry.half === "AM" ? "morning" : "afternoon"}${entry.areaName ? ` in ${bidiIsolate(entry.areaName)}` : ""}`)
        .join("; ");
      const theWeek = notice.weekStart ? `the week starting ${formatPhoenixLongDate(notice.weekStart)}` : "this week";
      return [
        {
          ...base,
          recordId: notice.recordId,
          tab: "plan",
          path: MANAGER_PLAN_WITH_YOU_PATH,
          eventType: "manager_plan_with_you",
          title: halves.length === 1 ? `${manager} planned a half-day with you` : `${manager} planned ${halves.length} half-days with you`,
          message: `${manager}'s plan for ${theWeek} is approved, and you are planned to join: ${list}. It is on your planning calendar.`,
          metadata: planMeta,
        },
      ];
    }
    case "single_visit_day_expired":
      return [
        {
          ...base,
          ...toPlan,
          eventType: "manager_single_visit_day_expired",
          title: "Your ask for a day of single visits ended with the day",
          message: `Nobody finished deciding your ask for ${visitDay} before the day passed, so it is closed.`,
        },
      ];
  }
}

async function describeManagerPlan(notice: ManagerPlanNotice): Promise<Delivery[]> {
  const names = await loadPeopleNames([notice.managerHrId, notice.actorHrId, notice.recipientHrId]);
  return managerPlanDeliveries(notice, names);
}

type Delivery = {
  recipients: string[];
  eventType: string;
  title: string;
  message: string;
  /** A product manager answers an ask on the Reports page, the one page of the module he opens. */
  tab: "team" | "list" | "plan" | "visits" | "forecast" | "reports";
  /**
   * Where the notice opens when it is NOT a tab of the Phoenix CRM page — the double-visit requests
   * report (owner, 2026-10-16), a page of its own that managers AND product managers both open.
   */
  path?: string;
  recordId: string;
  idempotencyKey: string;
  subjectHrId: string | null;
  /**
   * In the bell and nowhere else. Two notices set it. The daily forecast's alert: the owner asked for
   * an IN-APP alert, and with some 26 CNS reps sending one every working day, a Telegram ping for each
   * would bury the notices that are waiting for a decision. And the courtesy a district manager gets
   * when one of his reps asks a product manager for a visit (2026-10-02): nothing waits on him.
   */
  inAppOnly?: boolean;
  /**
   * Extra metadata on the notification row. The "approve this off-plan visit" notice carries the
   * VISIT ID here, which is how the bell knows which visit to ask about before clearing the notice —
   * the same shape the vacation, excuse and weekly-plan notices already use (`requestId`, `planId`).
   */
  metadata?: Record<string, string>;
};

/**
 * The event each kind of waiting list request is sent as. One `eventType:` literal a line, on purpose:
 * tests/phoenix-crm-email-block.test.ts reads every event type the module sends from those lines, so a
 * template string would hide the add and bring-back notices from its email check.
 */
const REQUEST_WAITING: Record<PhoenixCrmRequestKind, { eventType: string }> = {
  grade: {
    eventType: "grade_request_waiting",
  },
  drop: {
    eventType: "drop_request_waiting",
  },
  add: {
    eventType: "add_request_waiting",
  },
  restore: {
    eventType: "restore_request_waiting",
  },
};

/**
 * The SFE Managers by hr id — a ROLE with no seat in the organogram, so read from the accounts. Shared
 * with the daily approval nudge (approval-nudge.ts) and, since 2026-10-02, with the off-plan visit's
 * own SFE step, so the SFE step is the same people everywhere.
 *
 * The resolver drops a departed holder (`resolveHrIdsForRole`) and logs an empty answer, because every
 * step this feeds is addressed to an OFFICE: nobody holding the role means that step told no one.
 */
export async function sfeManagerHrIds(): Promise<string[]> {
  const scope = sfeManagersOnce.getStore();
  if (scope) return (scope.read ??= readSfeManagerHrIds());
  return readSfeManagerHrIds();
}

async function readSfeManagerHrIds(): Promise<string[]> {
  const { hrIds } = await resolveHrIdsForRole("SFE Manager", "Phoenix CRM — SFE Managers");
  // A test account holds the role it mirrors; its TEST- id is never a real person to tell.
  return hrIds.filter((hrId) => !hrId.startsWith("TEST-"));
}

/**
 * Within ONE notice the SFE Managers are read once and shared — `describe` and the activity mirror both
 * ask. Scoped to the single send, never cached across sends: who holds the role decides who is told, so
 * a change to it reaches the very next notice.
 */
const sfeManagersOnce = new AsyncLocalStorage<{ read?: Promise<string[]> }>();

function withSfeManagersReadOnce<T>(work: () => Promise<T>): Promise<T> {
  return sfeManagersOnce.run({}, work);
}

/**
 * A request to edit a sent week, at one of its steps (owner, 2026-10-01: "emails, in-app and Telegram
 * for every step" — to the next person to act, the rep, the district manager and SFE). Two deliveries:
 * the managers' copy opens the Team tab where they decide, the rep's opens his Plan.
 */
async function describePlanEdit(notice: Extract<PhoenixCrmNotice, { kind: "plan_edit" }>): Promise<Delivery[]> {
  const territory = territoryName(notice.seat);
  const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
  const sfe = await sfeManagerHrIds();
  const names = await loadPeopleNames([notice.repHrId, notice.actorHrId]);
  const rep = nameOf(names, notice.repHrId, "A rep");
  // The Administrator is named by his title, never by name and never as HR (owner, 2026-10-08).
  const byAdministrator = personKey(notice.actorHrId) === personKey(PHOENIX_CRM_ADMINISTRATOR_HR_ID);
  const actor = byAdministrator ? "The Administrator" : nameOf(names, notice.actorHrId, "The approver");
  const week = formatPhoenixLongDate(notice.weekStart);
  const status = notice.status;
  const raised = notice.actorHrId === notice.repHrId && (status === "manager_pending" || status === "sfe_pending");
  // Read as booleans first, so the eventType line below carries event NAMES and nothing else.
  const reopened = status === "reopened";
  const refused = status === "refused";
  const expired = status === "expired";
  const reversed = refused && notice.reversed === true;
  const note = notice.note ? ` Note: ${notice.note}` : "";

  const next: string[] =
    status === "manager_pending" ? (reviewer ? [reviewer.hrId] : []) : status === "sfe_pending" ? sfe : [];
  const actorKey = personKey(notice.actorHrId);
  const repKey = personKey(notice.repHrId);
  const managers = [...new Set([...next, ...(reviewer ? [reviewer.hrId] : []), ...sfe])].filter((hrId) => {
    const key = personKey(hrId);
    return key !== null && key !== actorKey && key !== repKey;
  });

  const nextStep =
    status === "manager_pending"
      ? "The district manager decides first, then SFE."
      : status === "sfe_pending"
        ? raised
          ? "SFE decides (the territory has no district manager)."
          : "SFE decides next."
        : "";
  const title = raised
    ? `Request to edit a weekly plan: ${rep}`
    : reopened
      ? `Weekly plan open to edit: ${rep}, week starting ${week}`
      : refused
        ? reversed
          ? `Reversed: ${rep}'s request to edit a weekly plan`
          : `Refused: ${rep}'s request to edit a weekly plan`
        : expired
          ? `Expired: ${rep}'s request to edit a weekly plan`
          : `Approved by ${actor}: ${rep}'s request to edit a weekly plan`;
  const message = raised
    ? `${rep} asks to edit the ${territory} plan for the week starting ${week}, which is already sent. ${nextStep}`
    : reopened
      ? `${actor} approved ${rep}'s request. The ${territory} plan for the week starting ${week} is open again for them to change and send again.${note}`
      : refused
        ? reversed
          ? `${actor} reversed the approval of ${rep}'s request to edit the ${territory} plan for the week starting ${week}. The week is closed again, as it was sent.${note}`
          : `${actor} refused ${rep}'s request to edit the ${territory} plan for the week starting ${week}. The week stays as it was sent.${note}`
        : expired
          ? `The week starting ${week} passed before ${rep}'s request to edit the ${territory} plan was settled.`
          : `${actor} approved ${rep}'s request to edit the ${territory} plan for the week starting ${week}. ${nextStep}${note}`;
  const repMessage = reopened
    ? `${actor} approved your request. Your plan for the week starting ${week} is open again: change the days from today on and send it again. Until you send it, your visits this week count as off-plan.${note}`
    : refused
      ? reversed
        ? `${actor} reversed the approval of your request to edit your plan for the week starting ${week}. Your week is closed again, as you sent it.${note}`
        : `${actor} refused your request to edit your plan for the week starting ${week}. The week stays as you sent it.${note}`
      : expired
        ? `The week starting ${week} passed before your request to edit it was settled.`
        : `${actor} approved your request to edit your plan for the week starting ${week}. ${nextStep}${note}`;

  const base = {
    eventType: raised ? "plan_edit_waiting" : reopened ? "plan_edit_reopened" : refused ? "plan_edit_refused" : expired ? "plan_edit_expired" : "plan_edit_moved_on",
    recordId: notice.requestId,
    subjectHrId: notice.repHrId,
  };
  const key = `phoenix_crm:plan_edit:${notice.requestId}:v${notice.version}:${status}`;
  const deliveries: Delivery[] = [];
  if (managers.length > 0) deliveries.push({ ...base, recipients: managers, title, message, tab: "team", idempotencyKey: key });
  // The rep asked; his own press is not news to him. Every step after it is.
  if (!raised && repKey !== actorKey) {
    deliveries.push({ ...base, recipients: [notice.repHrId], title, message: repMessage, tab: "plan", idempotencyKey: `${key}:rep` });
  }
  return deliveries;
}

/**
 * A rep's FIRST visit on Phoenix CRM (owner, 2026-10-03: "every rep submits a visit on Phoenix CRM —
 * only the first visit for each medical rep — an email goes to his district manager, his national sales
 * manager and the SFE, and Omar in the BCC").
 *
 * The SFE Manager is a ROLE with no seat in the organogram, so it is read from the accounts — the same
 * list the plan edit's SFE step and the daily approval nudge use.
 */
async function describeFirstVisit(notice: Extract<PhoenixCrmNotice, { kind: "first_visit" }>): Promise<Delivery[]> {
  const [sfe, names] = await Promise.all([sfeManagerHrIds(), loadPeopleNames([notice.repHrId])]);
  return firstVisitDeliveries(notice, names, sfe);
}

/**
 * Who is told of a rep's first visit, and in what words. Pure, so who it reaches and the once-ever key
 * are pinned by a test rather than by reading the code (tests/phoenix-crm-first-visit.test.ts).
 *
 * 🔒 EVERY OCCUPIED MANAGER SEAT ABOVE HIM, PLUS THE SFE MANAGERS (owner, 2026-10-03). He first named
 * three — the district manager, the national sales manager and SFE — and then, the same day, *"add the
 * Pedia RSM to the first-visit email"*. So the line is drawn at the TIER, not at a person: `managerChain`
 * is already every occupied manager seat above the territory, nearest first, excluding the CEO and
 * excluding a seat the rep himself holds. Today that is the district manager, Pedia Upper Egypt's
 * regional manager (`PD-0001`, the company's only RSM seat), and the line's national manager.
 *
 * 🔴 WHY THE WHOLE CHAIN AND NOT "DM + RSM + NSM" SPELLED OUT: a second regional seat, or a tier added
 * between, would be SILENTLY missed by a tier list — and missed in the direction that looks fine, since
 * the email still arrives, just without the one manager who was appointed last. The chain cannot
 * under-report that way. It also cannot over-report: the only manager tiers are DM, ACTING_DM, RSM and
 * NSM, and `managerChain` never reaches the CEO.
 *
 * 🔴 THE DISTRICT MANAGER IS THE TERRITORY'S REVIEWING MANAGER, not "the DM seat": a vacant district
 * passes upward exactly as it does for a grade request and a weekly plan — which falls out of using the
 * chain, because `chain[0]` IS that manager — so a rep whose district seat is empty still has somebody
 * told rather than nobody, and nobody is ever named twice.
 *
 * 🔴 AND NEVER THE REP (Golden Rule #1). The notice says a person has started; the one person it is about
 * is the one person who must not read it, and `personKey` comparison is what keeps him off it when he
 * also sits on a manager seat (an acting district manager holds both).
 */
export function firstVisitDeliveries(
  notice: Extract<PhoenixCrmNotice, { kind: "first_visit" }>,
  names: PeopleNames,
  sfeHrIds: readonly string[],
): Delivery[] {
  const chain = managerChain(notice.org, notice.seat.seatId);
  const repKey = personKey(notice.repHrId);
  const recipients = [...new Set([...chain.map((member) => member.hrId), ...sfeHrIds])].filter((hrId) => {
    const key = personKey(hrId);
    return key !== null && key !== repKey;
  });
  if (recipients.length === 0) return [];

  const rep = nameOf(names, notice.repHrId, "A rep");
  const territory = territoryName(notice.seat);
  return [
    {
      recipients,
      eventType: "first_visit_submitted",
      title: `First Phoenix CRM visit: ${rep}`,
      /**
       * 🔴 THE CUSTOMER'S NAME IS BIDI-ISOLATED, AND IT IS THE ONLY PART OF THIS LINE THAT NEEDS IT
       * (owner, 2026-10-03). Every Phoenix CRM customer name is ARABIC — all twelve sampled on one real
       * seat — so this one sentence mixes an RTL run into LTR text, and the neutral punctuation beside
       * it then resolves to the paragraph's direction and can display on the wrong side of the name.
       *
       * `renderEmailParagraphs` already isolates each LINE, which is right for a single-language line
       * and does nothing for a run INSIDE one — the granularity the bilingual-bodies rule is about. So
       * the isolate goes where the name is interpolated, which is also the only place that knows which
       * substring is the name. The resulting nested isolate is legal and intended.
       *
       * Applied BEFORE HTML-escaping, deliberately, although `bidiIsolate` is documented for after it:
       * FSI and PDI are untouched by escaping, and this string is not HTML — it is the one message the
       * bell, Telegram and the phone show too, and all three have the same mixed-direction problem.
       */
      message:
        `${rep} submitted a first visit on Phoenix CRM: ${bidiIsolate(notice.customerName)}, ${territory}, ` +
        `at ${formatPhoenixDateTime(notice.capturedAt)} (Cairo). ` +
        `It is the first visit this rep has submitted on the module — nothing waits on you.`,
      tab: "team",
      recordId: notice.visitId,
      // 🔴 KEYED ON THE REP, NOT THE VISIT. "Only the first visit for each medical rep" is a promise about
      // the PERSON, so the key is the person: a second reading of "this is his first" — a retried save, a
      // repeat of the count, two visits landing in the same second — upserts the same event row instead of
      // sending a second email. Nothing else in this file keys on a person alone, and that is the point.
      idempotencyKey: `phoenix_crm:first_visit:${repKey ?? notice.repHrId}`,
      subjectHrId: notice.repHrId,
    },
  ];
}

/**
 * Who hears the Administrator's decision on a recorded visit, and in what words. Pure, so who it reaches
 * and what it says are pinned by a test (tests/phoenix-crm-visit-recording.test.ts).
 *
 * 🔒 THE REP, HIS MANAGER AND HIS MANAGER'S MANAGER (owner, 2026-10-17) — the two nearest occupied manager
 * seats of `managerChain`, so a vacant district passes upward exactly as it does for a plan, and the chain
 * never reaches the CEO. The decider is never told his own decision, and nobody is named twice.
 *
 * 🔴 THE REP'S WORDS NAME A ROLE, NEVER A CHECK (Golden Rule #1): "the Administrator approved your visit".
 * They do not say the visit was recorded, listened to or judged on anything — what he reads is the
 * decision and the comment, as his own visit list already shows the decision.
 */
export function recordedVisitDecisionDeliveries(
  notice: Extract<PhoenixCrmNotice, { kind: "recorded_visit_decided" }>,
  names: PeopleNames,
): Delivery[] {
  const approved = notice.decision === "approved";
  const repKey = personKey(notice.repHrId);
  const deciderKey = personKey(notice.deciderHrId);
  const taken = new Set<string>(deciderKey ? [deciderKey] : []);
  const managers: string[] = [];
  for (const member of managerChain(notice.org, notice.seat.seatId).slice(0, RECORDED_VISIT_DECISION_MANAGER_LEVELS)) {
    const key = personKey(member.hrId);
    if (!key || key === repKey || taken.has(key)) continue;
    taken.add(key);
    managers.push(key);
  }

  const day = formatPhoenixLongDate(notice.visitDate);
  const customer = bidiIsolate(notice.customerName);
  // The comment is his words, so it is isolated like the customer's name: Arabic inside English text.
  const comment = notice.note ? ` Comment: ${bidiIsolate(notice.note)}` : "";
  const prefix = phoenixCrmVisitNoticeKeyPrefix(notice.visitId);
  const deliveries: Delivery[] = [];

  if (repKey && repKey !== deciderKey) {
    deliveries.push({
      recipients: [repKey],
      eventType: "recorded_visit_decided",
      title: `${approved ? "Approved" : "Not approved"}: your visit to ${notice.customerName}`,
      message: approved
        ? `The Administrator approved your visit to ${customer} on ${day}. It counts.${comment}`
        : `The Administrator did not approve your visit to ${customer} on ${day}, so it does not count.${comment}`,
      tab: "visits",
      recordId: notice.visitId,
      idempotencyKey: `${prefix}recorded:${notice.decision}:rep`,
      subjectHrId: notice.repHrId,
    });
  }
  if (managers.length > 0) {
    const rep = nameOf(names, notice.repHrId, "A rep");
    deliveries.push({
      recipients: managers,
      eventType: "recorded_visit_decided",
      title: `${approved ? "Approved" : "Not approved"}: ${rep}'s visit to ${notice.customerName}`,
      message: approved
        ? `The Administrator approved ${rep}'s visit to ${customer} on ${day} (${territoryName(notice.seat)}). It counts.${comment}`
        : `The Administrator did not approve ${rep}'s visit to ${customer} on ${day} (${territoryName(notice.seat)}), so it does not count.${comment}`,
      tab: "team",
      recordId: notice.visitId,
      idempotencyKey: `${prefix}recorded:${notice.decision}:managers`,
      subjectHrId: notice.repHrId,
    });
  }
  return deliveries;
}

async function describeRecordedVisitDecided(notice: Extract<PhoenixCrmNotice, { kind: "recorded_visit_decided" }>): Promise<Delivery[]> {
  return recordedVisitDecisionDeliveries(notice, await loadPeopleNames([notice.repHrId]));
}

async function describeDayStart(notice: Extract<PhoenixCrmNotice, { kind: "day_start" }>): Promise<Delivery[]> {
  const [sfe, names] = await Promise.all([sfeManagerHrIds(), loadPeopleNames([notice.repHrId])]);
  return dayStartDeliveries(notice, names, sfe);
}

/**
 * Who is told that a rep has started his day, and in what words (owner, 2026-10-03).
 *
 * 🔒 HIS DISTRICT MANAGER AND THE SFE MANAGER — the owner's own pick when asked, out of three
 * options. The DM is the territory's REVIEWING manager, so a vacant district passes upward exactly as
 * a grade request and a weekly plan do, and a rep whose district seat is empty still has somebody told
 * rather than nobody.
 *
 * 🔴 TWO EVENT TYPES, AND THAT IS THE WHOLE POINT OF THE SPLIT. He chose "all three channels, email to
 * the DM only", because this notice repeats EVERY WORKING DAY: at ~5 reps a district the DM's inbox
 * takes ~5 a morning, while the SFE, who reads every line, would take one per rep — about 74 once the
 * module is company-wide. Channels are decided per EVENT TYPE
 * (`phoenixCrmChannels`), never per recipient, so the only way to hold that line is a second type:
 *   · `day_start_confirmed` is on the email allow-list  → the DM gets in-app, Telegram, email, push;
 *   · `day_start_seen` is on the push-blocked list      → the SFE gets in-app and Telegram, and email
 *     can never reach him even through the Telegram-failure fallback, which is the back door that put
 *     the daily digest on the phone once already.
 * Collapsing these two into one type silently gives the SFE 74 emails a morning.
 *
 * 🔴 AND NEVER THE REP. He pressed it; telling him his own press is noise, and `personKey` keeps him
 * off both lists when he also holds a manager seat (an acting district manager holds both).
 */
export function dayStartDeliveries(
  notice: Extract<PhoenixCrmNotice, { kind: "day_start" }>,
  names: PeopleNames,
  sfeHrIds: readonly string[],
): Delivery[] {
  const repKey = personKey(notice.repHrId);
  const notRep = (hrId: string) => {
    const key = personKey(hrId);
    return key !== null && key !== repKey;
  };
  const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
  const managers = reviewer && notRep(reviewer.hrId) ? [reviewer.hrId] : [];
  const sfe = [...new Set(sfeHrIds)].filter((hrId) => notRep(hrId) && !managers.includes(hrId));

  const rep = nameOf(names, notice.repHrId, "A rep");
  const territory = territoryName(notice.seat);
  const clock = formatPhoenixDateTime(notice.startedAt);
  // The place, as a link anybody can open. The rep was told this travels before he pressed.
  const where = `https://www.google.com/maps/search/?api=1&query=${notice.lat},${notice.lon}`;
  const planned =
    notice.plannedAmMinute === null
      ? "They had no sent plan for today."
      : `Their plan said they would start the morning at ${minuteClock(notice.plannedAmMinute)}.`;
  const message =
    `${rep} confirmed they started working at ${clock} (Cairo), ${territory}. ${planned} ` +
    `Where they were when they pressed it: ${where}`;
  const title = `Started working: ${rep}`;
  // Keyed on the rep and the DAY, not on the row: one start per rep per day, so a retried save or two
  // presses landing together upsert the same event instead of telling anybody twice.
  const key = `phoenix_crm:day_start:${repKey ?? notice.repHrId}:${notice.startedAt.slice(0, 10)}`;

  const deliveries: Delivery[] = [];
  if (managers.length > 0) {
    deliveries.push({
      recipients: managers,
      eventType: "day_start_confirmed",
      title,
      message,
      tab: "team",
      recordId: notice.seat.seatId,
      idempotencyKey: `${key}:dm`,
      subjectHrId: notice.repHrId,
    });
  }
  if (sfe.length > 0) {
    deliveries.push({
      recipients: sfe,
      eventType: "day_start_seen",
      title,
      message,
      tab: "team",
      recordId: notice.seat.seatId,
      idempotencyKey: `${key}:sfe`,
      subjectHrId: notice.repHrId,
    });
  }
  return deliveries;
}

/**
 * A rep's ask for a visit with somebody (owner, 2026-10-02), raised or answered.
 *
 * Raised: the person asked, who answers it — on the Team tab for a manager, on Reports for a product
 * manager — and the person told: the manager above for a chain visit ("both are told"), the rep's
 * district manager for a product manager's visit, in the bell only, a courtesy he does not act on.
 * Answered: the rep, whose request it is (he sees "accepted, Tue 6 Oct"), and the person told again.
 * Each delivery has its own key, per ask and status, so a step sent twice reaches nobody twice.
 */
async function describeVisitAsk(notice: Extract<PhoenixCrmNotice, { kind: "visit_ask" }>): Promise<Delivery[]> {
  const names = await loadPeopleNames([notice.repHrId, notice.askedHrId, notice.toldHrId]);
  return visitAskDeliveries(notice, names);
}

/**
 * The deliveries of one visit-ask step, given the people's names. Pure, so who is told of each kind and
 * each step — and that the district manager's courtesy copy is the one in-app-only notice of an ask —
 * is tested without a database (tests/phoenix-crm-visit-asks.test.ts).
 */
export function visitAskDeliveries(notice: Extract<PhoenixCrmNotice, { kind: "visit_ask" }>, names: PeopleNames): Delivery[] {
  const territory = territoryName(notice.seat);
  const rep = nameOf(names, notice.repHrId, "A rep");
  const asked = nameOf(names, notice.askedHrId, "The person asked");
  const told = notice.toldHrId ? nameOf(names, notice.toldHrId, "the manager above") : null;
  const customer = `${notice.customerName} (${notice.listType})`;
  // Read as booleans first, so the eventType lines below carry event NAMES and nothing else.
  const chain = notice.askKind === "chain";
  const productManager = notice.askKind === "product_manager";
  const raised = notice.status === "waiting";
  const accepted = notice.status === "accepted";
  const key = `${phoenixCrmVisitAskNoticeKeyPrefix(notice.askId)}${notice.status}`;
  const base = { recordId: notice.askId, subjectHrId: notice.repHrId };
  const day = accepted && notice.visitOn ? formatPhoenixLongDate(notice.visitOn) : "the day agreed";
  const deliveries: Delivery[] = [];

  if (raised) {
    const wish = notice.wishedOn ? `They would like ${formatPhoenixLongDate(notice.wishedOn)}.` : "Any day suits them.";
    const what = chain
      ? `a chain visit to ${customer} on ${territory}: you, ${told ?? "the manager above"} and them`
      : productManager
        ? `a visit with you to ${customer} on ${territory}`
        : `a double visit with you to ${customer} on ${territory}`;
    deliveries.push({
      ...base,
      recipients: [notice.askedHrId],
      eventType: "visit_ask_waiting",
      title: `Visit asked of you: ${notice.customerName}`,
      message: `${rep} asks for ${what}. ${wish} Accept it and pick the day, or decline it, in Phoenix CRM.`,
      tab: productManager ? "reports" : "team",
      idempotencyKey: `${key}:asked`,
    });
  } else {
    const visitWords = chain ? "chain visit" : productManager ? "visit" : "double visit";
    deliveries.push({
      ...base,
      recipients: [notice.repHrId],
      eventType: accepted ? "visit_ask_accepted" : "visit_ask_declined",
      title: accepted ? `Visit accepted: ${notice.customerName}` : `Visit declined: ${notice.customerName}`,
      message: accepted
        ? `${asked} accepted your ${visitWords} to ${customer}. The visit is on ${day}.${chain && told ? ` ${told} is told too.` : ""}`
        : `${asked} declined your ${visitWords} to ${customer}.`,
      tab: "list",
      idempotencyKey: `${key}:rep`,
    });
  }

  // The person told: the manager above for a chain visit, the rep's district manager for a product
  // manager's. A double visit tells nobody else.
  if (notice.toldHrId && (chain || productManager)) {
    const title = raised
      ? `${chain ? "Chain visit" : "Product manager visit"} asked: ${notice.customerName}`
      : `${chain ? "Chain visit" : "Product manager visit"} ${accepted ? "accepted" : "declined"}: ${notice.customerName}`;
    const message = raised
      ? chain
        ? `${rep} asks ${asked} and you for a chain visit to ${customer} on ${territory}. ${asked} picks the day, and you are told when it is answered.`
        : // The VISIT is named, never a title for the person asked: on CNS he is the Marketing Manager.
          `${rep} asked ${asked} for a product manager visit to ${customer} on ${territory}. You are told when it is answered.`
      : accepted
        ? `${asked} accepted ${rep}'s ${chain ? "chain visit" : "visit"} to ${customer} on ${territory}. The visit is on ${day}${chain ? ", and you are on it too." : "."}`
        : `${asked} declined ${rep}'s ${chain ? "chain visit" : "visit"} to ${customer} on ${territory}.`;
    const toldDelivery: Delivery = {
      ...base,
      recipients: [notice.toldHrId],
      eventType: raised ? "visit_ask_told" : accepted ? "visit_ask_accepted" : "visit_ask_declined",
      title,
      message,
      tab: "team",
      idempotencyKey: `${key}:told`,
    };
    deliveries.push(
      productManager
        ? {
            ...toldDelivery,
            // The rep's district manager hears of his rep's product manager visit in the bell and
            // nowhere else (owner's brief, 2026-10-02: "told (in-app)"): nothing waits on him.
            inAppOnly: true,
          }
        : toldDelivery,
    );
  }
  return deliveries;
}

/**
 * A rep's request for a double visit (owner, 2026-10-16), raised, re-dated or answered.
 *
 * Raised and re-dated: every person asked who still waits, one delivery each so each has his own key
 * and a request sent twice reaches nobody twice. The edit's key carries its version, so a second change
 * of the days is not swallowed by the first's. Answered: the rep, who reads "accepted, Tue 6 Oct" or
 * "declined" from the person who answered. Nothing is ever cancelled, so nothing is withdrawn on one.
 */
async function describeDoubleVisitRequest(notice: Extract<PhoenixCrmNotice, { kind: "double_visit_request" }>): Promise<Delivery[]> {
  const names = await loadPeopleNames([notice.repHrId, ...notice.askedHrIds]);
  return doubleVisitRequestDeliveries(notice, names);
}

/** The deliveries of one double-visit step, given the people's names. Pure, so who is told and the keys are tested without a database. */
export function doubleVisitRequestDeliveries(notice: Extract<PhoenixCrmNotice, { kind: "double_visit_request" }>, names: PeopleNames): Delivery[] {
  const territory = territoryName(notice.seat);
  const rep = nameOf(names, notice.repHrId, "A rep");
  const customer = `${notice.customerName} (${notice.listType})`;
  const base = { recordId: notice.requestId, subjectHrId: notice.repHrId, tab: "team" as const, path: DOUBLE_VISIT_REQUESTS_PATH };
  const prefix = phoenixCrmDoubleVisitNoticeKeyPrefix(notice.requestId);
  const offered = notice.days.map((day) => formatPhoenixLongDate(day)).join(", ");
  const asked = notice.step === "raised" || notice.step === "days_changed";

  if (asked) {
    const changed = notice.step === "days_changed";
    return notice.askedHrIds.map((hrId): Delivery => ({
      ...base,
      recipients: [hrId],
      eventType: changed ? "double_visit_days_changed" : "double_visit_waiting",
      title: changed ? `Double visit days changed: ${notice.customerName}` : `Double visit asked of you: ${notice.customerName}`,
      message: changed
        ? `${rep} changed the days offered for a double visit with you to ${customer} on ${territory}: ${offered}. Accept one day or decline, in Double visit requests.`
        : `${rep} asks for a double visit with you to ${customer} on ${territory}. Days offered: ${offered}. Accept one day or decline, in Double visit requests.`,
      idempotencyKey: `${prefix}${personKey(hrId) ?? hrId}:${changed ? `days:${notice.version}` : "raised"}`,
    }));
  }

  const answeredBy = notice.askedHrIds[0] ?? "";
  const who = nameOf(names, answeredBy, "The person asked");
  const accepted = notice.step === "accepted";
  const day = accepted && notice.visitOn ? formatPhoenixLongDate(notice.visitOn) : "the day agreed";
  return [
    {
      ...base,
      recipients: [notice.repHrId],
      eventType: accepted ? "double_visit_accepted" : "double_visit_declined",
      title: accepted ? `Double visit accepted: ${notice.customerName}` : `Double visit declined: ${notice.customerName}`,
      message: accepted
        ? `${who} accepted your double visit to ${customer}. The visit is on ${day}.`
        : `${who} declined your double visit to ${customer}.`,
      // The answer is keyed on the person AND what he answered, so a changed mind reaches the rep as a second notice.
      idempotencyKey: `${prefix}answer:${personKey(answeredBy) ?? answeredBy}:${notice.step}:${notice.visitOn ?? "none"}`,
    },
  ];
}

async function describe(notice: PhoenixCrmNotice): Promise<Delivery | Delivery[] | null> {
  // A manager's plan names no territory, and a product manager's has no seat at all.
  if (notice.kind === "manager_plan") return describeManagerPlan(notice);
  const territory = territoryName(notice.seat);

  if (notice.kind === "plan_edit") return describePlanEdit(notice);
  if (notice.kind === "double_visit_request") return describeDoubleVisitRequest(notice);
  if (notice.kind === "first_visit") return describeFirstVisit(notice);
  if (notice.kind === "recorded_visit_decided") return describeRecordedVisitDecided(notice);
  if (notice.kind === "day_start") return describeDayStart(notice);
  if (notice.kind === "visit_ask") return describeVisitAsk(notice);

  if (notice.kind === "request_created") {
    const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
    // 🔴 A VACANT CHAIN IS TOLD SFE, NOT NOBODY. This returned null when the territory had no manager
    //    seat above it — and that is exactly the territory where the request starts at SFE
    //    (`firstRequestStage`), so the one person who could decide it was the one person never told. The
    //    rep's ask then sat for ever with nothing on anybody's screen. Same shape as a plan edit, which
    //    has always fallen through to `sfeManagerHrIds` for its SFE step.
    const sfe = reviewer ? [] : await sfeManagerHrIds();
    const recipients = reviewer ? [reviewer.hrId] : sfe;
    if (recipients.length === 0) return null;
    const names = await loadPeopleNames([notice.requesterHrId]);
    const rep = nameOf(names, notice.requesterHrId, "A rep");
    const customer = `${notice.customerName} (${notice.listType})`;
    const kind = notice.requestKind;
    // With no district manager there is no step after this one, for a grade change (his alone, and
    // SFE's while the seat is empty) or for the two-step kinds that begin at SFE.
    const after = reviewer ? " SFE decides after you." : "";
    const why = reviewer ? "" : " This territory has no district manager, so it is yours to decide.";
    return {
      recipients,
      eventType: REQUEST_WAITING[kind].eventType,
      title:
        kind === "grade"
          ? `Grade to approve for ${notice.customerName}`
          : kind === "drop"
            ? `Drop to approve for ${notice.customerName}`
            : kind === "add"
              ? `Customer to add for ${notice.customerName}`
              : `Bring back to approve for ${notice.customerName}`,
      message:
        kind === "grade"
          ? `${rep} proposes grade ${notice.proposedGrade ?? "—"} for ${customer} on ${territory}. Approve or refuse it in Phoenix CRM.${why}`
          : kind === "drop"
            ? `${rep} asks to take ${customer} off the ${territory} list. Reason: ${dropReasonLabel(notice.dropReason) ?? "not given"}. Approve or refuse it in Phoenix CRM.${after}${why}`
            : kind === "add"
              ? `${rep} asks to add ${customer} to the ${territory} list, proposing grade ${notice.proposedGrade ?? "—"}. Confirm the grade, set the potential and approve or refuse it in Phoenix CRM.${after}${why}`
              : `${rep} asks to bring ${customer} back to the ${territory} list from the Archive. Approve or refuse it in Phoenix CRM.${after}${why}`,
      tab: "team",
      recordId: notice.requestId,
      idempotencyKey: `phoenix_crm:request:${notice.requestId}:created`,
      subjectHrId: notice.requesterHrId,
    };
  }

  if (notice.kind === "request_decided") {
    const names = await loadPeopleNames([notice.deciderHrId]);
    const decider = deciderNameOf(names, notice.deciderHrId, "Your manager");
    const approved = notice.status === "approved";
    const what =
      notice.requestKind === "grade"
        ? `grade ${notice.proposedGrade ?? "—"} for ${notice.customerName}`
        : notice.requestKind === "drop"
          ? `taking ${notice.customerName} off your list`
          : notice.requestKind === "add"
            ? `adding ${notice.customerName} to your list`
            : `bringing ${notice.customerName} back to your list`;
    const note = notice.note ? ` Note: ${notice.note}` : "";
    const subject = { grade: "grade", drop: "drop", add: "add to list", restore: "bring back" }[notice.requestKind];
    const reversed = notice.reversed === true;
    return {
      recipients: [notice.requesterHrId],
      eventType: approved ? "request_approved" : "request_refused",
      title: reversed ? `Reversed: ${subject} for ${notice.customerName}` : `${approved ? "Approved" : "Refused"}: ${subject} for ${notice.customerName}`,
      message: reversed
        ? `${decider} reversed the approval of ${what} on ${territory}. It is undone.${note}`
        : `${decider} ${approved ? "approved" : "refused"} ${what} on ${territory}.${note}`,
      tab: "list",
      recordId: notice.requestId,
      idempotencyKey: `phoenix_crm:request:${notice.requestId}:${notice.status}`,
      subjectHrId: notice.requesterHrId,
    };
  }

  if (notice.kind === "request_returned") {
    const names = await loadPeopleNames([notice.returnerHrId]);
    const returner = deciderNameOf(names, notice.returnerHrId, "SFE");
    const subject = { grade: "grade change", drop: "drop request", add: "request to add", restore: "request to bring back" }[notice.requestKind];
    return {
      recipients: [notice.requesterHrId],
      eventType: "request_returned",
      title: `Comment needed: ${subject} for ${notice.customerName}`,
      message: `${returner} sent your ${subject} for ${bidiIsolate(notice.customerName)} on ${territory} back for a comment. Note: ${notice.note} Open it in Phoenix CRM and write your comment — it then goes straight back to SFE.`,
      tab: "list",
      recordId: notice.requestId,
      idempotencyKey: `phoenix_crm:request:${notice.requestId}:returned:${notice.returnedAt}`,
      subjectHrId: notice.requesterHrId,
    };
  }

  if (notice.kind === "request_answered") {
    const names = await loadPeopleNames([notice.requesterHrId]);
    const rep = nameOf(names, notice.requesterHrId, "The rep");
    const subject = { grade: "grade change", drop: "drop request", add: "request to add", restore: "request to bring back" }[notice.requestKind];
    return {
      recipients: [notice.returnerHrId],
      eventType: "request_answered",
      title: `Comment received: ${subject} for ${notice.customerName}`,
      message: `${rep} answered your question on the ${subject} for ${bidiIsolate(notice.customerName)} on ${territory}: ${notice.reply} It is back with you in Phoenix CRM to approve or refuse.`,
      tab: "team",
      recordId: notice.requestId,
      idempotencyKey: `phoenix_crm:request:${notice.requestId}:answered:${notice.answeredAt}`,
      subjectHrId: notice.requesterHrId,
    };
  }

  if (notice.kind === "validation_not_confirmed") {
    // 🔴 EVERY WORD HERE IS ABOUT HIS PICTURE. No name of a decider, no "rejected", no "admin", no
    // "review", no metres: `validationRefusalRepText` is the only sentence that varies, and a regex
    // sweep in tests/phoenix-crm-validation-feedback.test.ts refuses any of those words inside the six.
    const why =
      (notice.via === "shared_place" ? sharedPlaceRefusalRepText(notice.reason) : validationRefusalRepText(notice.reason)) ??
      LOCATION_NOT_CONFIRMED_TEXT;
    return {
      recipients: [notice.repHrId],
      eventType: "validation_not_confirmed",
      title: `${LOCATION_NOT_CONFIRMED_TITLE}: ${notice.customerName}`,
      // Every Phoenix CRM customer name is Arabic inside an English sentence, so it is isolated or the
      // punctuation around it jumps to the wrong end of the line.
      message: `${bidiIsolate(notice.customerName)} on ${territory} is back under To validate. ${why}`,
      tab: "list",
      recordId: notice.reviewId,
      // 🔴 CUSTOMER FIRST, REVIEW SECOND, so one PREFIX withdrawal
      // (`withdrawValidationNotConfirmed`) clears every such notice for one customer the moment he
      // validates again — a rep must never be left with a bell asking for something he has done.
      idempotencyKey: `phoenix_crm:validation_not_confirmed:${notice.customerId}:${notice.reviewId}${notice.attempt ? `:${notice.attempt}` : ""}`,
      subjectHrId: notice.repHrId,
    };
  }

  if (notice.kind === "plan_submitted") {
    const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
    const sfeReturner = notice.returnedBySfeHrId ?? null;
    if (!reviewer && !sfeReturner) return null;
    const names = await loadPeopleNames([notice.submitterHrId]);
    const rep = nameOf(names, notice.submitterHrId, "A rep");
    const week = formatPhoenixLongDate(notice.weekStart);
    const deliveries: Delivery[] = [];
    if (reviewer) {
      deliveries.push({
        recipients: [reviewer.hrId],
        eventType: "plan_waiting",
        title: `Weekly plan to review from ${rep}`,
        message: `${rep} sent the ${territory} plan for the week starting ${week}. Approve it or return it with a note in Phoenix CRM.`,
        tab: "team",
        recordId: notice.planId,
        idempotencyKey: `phoenix_crm:plan:${notice.planId}:v${notice.version}:submitted`,
        subjectHrId: notice.submitterHrId,
        // 🔴 `recordId` IS NOT PERSISTED ON THE ROW — it steers governance and the audit line, and
        // `notification_events` has no column for it. So the plan id has to travel in the METADATA or
        // the bell cannot tell which week this notice is about, and cannot withdraw it once the week is
        // decided (owner, 2026-10-07). The off-plan notice carries `visitId` for exactly this reason.
        metadata: { planId: notice.planId },
      });
    }
    // 🔴 THE SFE MANAGER WHO RETURNED IT IS TOLD IT CAME BACK (2026-10-08) — and in a notice of his
    // OWN event type, never as a second recipient on `plan_waiting` above. Two reasons, both load
    // bearing: he can never approve a plan (`canReviewTerritory`), so an actionable notice would offer
    // him a decision he cannot take; and the bell withdraws a `plan_waiting` the moment the week is not
    // the READER's to decide, which for him is immediately — his copy would vanish before he read it.
    if (sfeReturner) {
      deliveries.push({
        recipients: [sfeReturner],
        eventType: "plan_resent",
        title: `Weekly plan sent again: ${rep}`,
        message: `${rep} sent the ${territory} plan for the week starting ${week} again, after you returned it. ${
          reviewer ? "The manager above this territory approves it" : "Nobody above this territory approves it"
        } — nothing is waiting on you.`,
        tab: "team",
        recordId: notice.planId,
        idempotencyKey: `phoenix_crm:plan:${notice.planId}:v${notice.version}:resent_to_sfe`,
        subjectHrId: notice.submitterHrId,
      });
    }
    return deliveries;
  }

  if (notice.kind === "monthly_plan_submitted") {
    const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
    if (!reviewer) return null;
    const names = await loadPeopleNames([notice.submitterHrId]);
    const rep = nameOf(names, notice.submitterHrId, "A rep");
    const month = formatPhoenixMonth(notice.monthStart);
    return {
      recipients: [reviewer.hrId],
      eventType: "monthly_plan_waiting",
      title: `Monthly plan to review from ${rep}`,
      message: `${rep} sent the ${territory} plan for ${month}. Approve it or return it with a note in Phoenix CRM.`,
      tab: "team",
      recordId: notice.monthlyPlanId,
      idempotencyKey: `phoenix_crm:monthly:${notice.monthlyPlanId}:v${notice.version}:submitted`,
      subjectHrId: notice.submitterHrId,
    };
  }

  if (notice.kind === "monthly_plan_decided") {
    const names = await loadPeopleNames([notice.deciderHrId]);
    const decider = deciderNameOf(names, notice.deciderHrId, "Your manager");
    const month = formatPhoenixMonth(notice.monthStart);
    const recipients = [...notice.repHrIds];
    if (notice.status === "returned" && (notice.decidedAs === "sfe" || notice.decidedAs === "administrator")) {
      const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
      if (reviewer) recipients.push(reviewer.hrId);
    }
    const approved = notice.status === "approved";
    return {
      recipients,
      eventType: approved ? "monthly_plan_approved" : "monthly_plan_returned",
      title: approved ? `Monthly plan approved: ${month}` : `Monthly plan returned: ${month}`,
      message: approved
        ? `${decider} approved the ${territory} plan for ${month}.`
        : `${decider} returned the ${territory} plan for ${month} for changes.${notice.note ? ` Note: ${notice.note}` : ""}`,
      tab: "plan",
      recordId: notice.monthlyPlanId,
      idempotencyKey: `phoenix_crm:monthly:${notice.monthlyPlanId}:v${notice.version}:${notice.status}`,
      subjectHrId: notice.repHrIds[0] ?? null,
    };
  }

  if (notice.kind === "forecast_sent") {
    // The territory's reviewing manager — his district manager, the same person his weekly plan goes
    // to (an acting DM included). A chain with nobody in it tells nobody; the board still shows it.
    const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
    if (!reviewer) return null;
    const names = await loadPeopleNames([notice.repHrId]);
    const rep = nameOf(names, notice.repHrId, "A rep");
    return {
      recipients: [reviewer.hrId],
      eventType: "forecast_sent",
      title: `Daily forecast from ${rep}`,
      message: `${rep} sent the ${territory} forecast for ${formatPhoenixLongDate(notice.day)}. Your team's forecasts for the day are on the Forecast board in Phoenix CRM.`,
      tab: "forecast",
      recordId: `${notice.seat.seatId}:${notice.day}`,
      // ONE alert per territory and day: the key does not move when he corrects his boxes and sends
      // again, so the re-send updates the alert already in the manager's bell instead of adding one.
      idempotencyKey: `phoenix_crm:forecast:${notice.seat.seatId}:${notice.day}:sent`,
      subjectHrId: notice.repHrId,
      inAppOnly: true,
    };
  }

  if (notice.kind === "unplanned_visit_raised") {
    // The reviewing manager, exactly as a grade request goes to him — and when the territory's manager
    // chain is VACANT the visit starts at the SFE stage instead (`unplannedFirstStatus`, read from the
    // very same `reviewer !== null` test the save handed the database), so the SFE Managers are told.
    //
    // 🔴 UNTIL 2026-10-02 THAT SECOND CASE TOLD NOBODY AT ALL. The comment here said there was "no hr
    // id to address", which had gone stale: `sfeManagerHrIds()` reads the role from the accounts and
    // the five plan-edit notices had been using it since 2026-10-01. A vacant chain is precisely the
    // territory nobody else is watching, so its off-plan visits waited in silence.
    const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
    const recipients = reviewer ? [reviewer.hrId] : await sfeManagerHrIds();
    // Nobody holds the role either: the Team tab's counter carries it, as it did before. The resolver
    // has already logged the empty lookup.
    if (recipients.length === 0) return null;
    const names = await loadPeopleNames([notice.repHrId]);
    const rep = nameOf(names, notice.repHrId, "A rep");
    const day = formatPhoenixLongDate(notice.visitDate);
    // Whose approval it still needs, from where it starts. A vacant chain means SFE is the only step.
    const steps = reviewer ? "you and then SFE" : "you — this territory has no district manager, so SFE is its only step";
    return {
      recipients,
      eventType: "unplanned_visit_waiting",
      title: `Off-plan visit to approve: ${notice.customerName}`,
      message: notice.enteredByAdmin
        ? `The Super Admin entered a visit ${rep} missed logging: ${notice.customerName} on ${territory}, off the plan, on ${day}. ${notice.clarification ? `The reason given: ${notice.clarification} — approve` : "Approve"} it or refuse it in Phoenix CRM. It counts in nothing until ${steps} approve it.`
        : `${rep} visited ${notice.customerName} on ${territory} off their plan on ${day}. ${notice.clarification ? `They wrote: ${notice.clarification} — approve` : "No reason was written. Approve"} it or refuse it in Phoenix CRM. It counts in nothing until ${steps} approve it.`,
      tab: "team",
      recordId: notice.visitId,
      // Per visit per STEP: `raised` is the manager's, `sfe_pending` the SFE step's — the same key the
      // decided branch uses when a manager passes one on, so a visit tells SFE once however it got there.
      idempotencyKey: `${phoenixCrmVisitNoticeKeyPrefix(notice.visitId)}${reviewer ? "raised" : "sfe_pending"}`,
      subjectHrId: notice.repHrId,
      // What the bell asks about before clearing this notice: once the visit is no longer his to
      // decide, the "approve it" line has done its job and goes (owner, 2026-10-02).
      metadata: { visitId: notice.visitId },
    };
  }

  if (notice.kind === "unplanned_visit_decided") {
    const names = await loadPeopleNames([notice.deciderHrId, notice.repHrId]);
    const decider = deciderNameOf(names, notice.deciderHrId, "Your manager");
    const day = formatPhoenixLongDate(notice.visitDate);
    const note = notice.note ? ` Note: ${notice.note}` : "";
    // Read as booleans first, so the eventType line below carries event NAMES and nothing else.
    const approved = notice.status === "approved";
    const refused = notice.status === "refused";
    const deliveries: Delivery[] = [
      {
        recipients: [notice.repHrId],
        eventType: approved ? "unplanned_visit_approved" : refused ? "unplanned_visit_refused" : "unplanned_visit_moved_on",
        title: notice.reversed === true
          ? `Reversed: off-plan visit to ${notice.customerName}`
          : approved || refused
            ? `${approved ? "Approved" : "Refused"}: off-plan visit to ${notice.customerName}`
            : `Passed to SFE: off-plan visit to ${notice.customerName}`,
        message: notice.reversed === true
          ? `${decider} reversed the approval of your off-plan visit to ${notice.customerName} on ${day}, so it no longer counts.${note}`
          : approved
          ? `${decider} approved your off-plan visit to ${notice.customerName} on ${day}. It counts like a planned visit.${note}`
          : refused
            ? `${decider} refused your off-plan visit to ${notice.customerName} on ${day}, so it does not count.${note}`
            : `${decider} approved your off-plan visit to ${notice.customerName} on ${day}. It counts once SFE approves it too.${note}`,
        tab: "visits",
        recordId: notice.visitId,
        idempotencyKey: `${phoenixCrmVisitNoticeKeyPrefix(notice.visitId)}v${notice.version}:${notice.status}`,
        subjectHrId: notice.repHrId,
      },
    ];

    // 🔴 THE STEP IT JUST MOVED TO TOLD NOBODY UNTIL 2026-10-02: the rep read "it counts once SFE
    // approves it too" and the SFE Manager had never heard of the visit. The manager's own copy is
    // withdrawn by the bell the moment the visit leaves his step, so nothing anywhere was asking SFE.
    if (notice.status === "sfe_pending") {
      const sfe = await sfeManagerHrIds();
      const rep = nameOf(names, notice.repHrId, "A rep");
      if (sfe.length > 0) {
        deliveries.push({
          recipients: sfe,
          eventType: "unplanned_visit_waiting",
          title: `Off-plan visit to approve: ${notice.customerName}`,
          message: `${decider} approved ${rep}'s off-plan visit to ${notice.customerName} on ${territory}, on ${day}, and it now waits for SFE.${
            notice.clarification ? ` They wrote: ${notice.clarification}` : ""
          } Approve it or refuse it in Phoenix CRM — it counts in nothing until you do.${note}`,
          tab: "team",
          recordId: notice.visitId,
          // Per visit per step, and version-free on purpose: the SFE step is reached once, whether the
          // visit started there (the raised branch writes this same key) or a manager passed it on.
          idempotencyKey: `${phoenixCrmVisitNoticeKeyPrefix(notice.visitId)}sfe_pending`,
          subjectHrId: notice.repHrId,
          // The bell clears it the same way the manager's copy is cleared: once the visit is decided.
          metadata: { visitId: notice.visitId },
        });
      }
    }
    return deliveries;
  }

  const names = await loadPeopleNames([notice.deciderHrId]);
  const decider = deciderNameOf(names, notice.deciderHrId, "Your manager");
  const week = formatPhoenixLongDate(notice.weekStart);
  const recipients = [...notice.repHrIds];
  if (notice.status === "returned" && (notice.decidedAs === "sfe" || notice.decidedAs === "administrator")) {
    const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
    if (reviewer) recipients.push(reviewer.hrId);
  }
  const approved = notice.status === "approved";
  // One day returned (owner, 2026-10-02: "Only that day"): the same plan_returned notice, naming the day.
  const oneDay = !approved && notice.returnedDay ? formatPhoenixLongDate(notice.returnedDay) : null;
  const noteText = notice.note ? ` Note: ${notice.note}` : "";
  return {
    recipients,
    eventType: approved ? "plan_approved" : "plan_returned",
    title: approved
      ? `Weekly plan approved: week starting ${week}`
      : oneDay
        ? `Weekly plan returned: ${oneDay} only`
        : `Weekly plan returned: week starting ${week}`,
    message: approved
      ? `${decider} approved the ${territory} plan for the week starting ${week}.`
      : oneDay
        ? `${decider} returned ${oneDay} of the ${territory} plan for the week starting ${week}. Only that day is open to change; the other days stay as sent, and the week is sent again once it is changed.${noteText}`
        : `${decider} returned the ${territory} plan for the week starting ${week} for changes.${noteText}`,
    tab: "plan",
    recordId: notice.planId,
    idempotencyKey: `phoenix_crm:plan:${notice.planId}:v${notice.version}:${notice.status}`,
    subjectHrId: notice.repHrIds[0] ?? null,
  };
}

/**
 * The activity mirror — every Phoenix CRM action, to the NATIONAL SALES MANAGER above the rep and to the
 * SFE Managers, in-app and by Telegram (owner, 2026-10-05: "in nsm and sfe i want every single action
 * that happens on Phoenix CRM by their scope to be sent to Telegram to them").
 *
 * It is a PARALLEL stream, appended at the one choke point (`notifyPhoenixCrm`) rather than wired into
 * every write path, so the module's tuned notices — who they reach, what they say, the first-visit chain,
 * the day-start split — are untouched and their tests still hold. Its recipients are the NSM in the rep's
 * chain plus the SFE Managers, MINUS anyone a native notice of the SAME action already reached: nobody is
 * pinged twice, which is why the first visit (already the whole chain and SFE) and the day-start,
 * plan-edit and off-plan-to-SFE notices (already SFE) produce no second message for them.
 *
 * 🔴 NEVER THE REP (Golden Rule #1): the subject of every line is excluded by `personKey`, and the one
 * line that reports a position — the day start — carries the TIME ONLY here, never the location, which the
 * owner scoped to the district manager and SFE alone (see `dayStartDeliveries`).
 *
 * 🔴 IN-APP AND TELEGRAM ONLY: `activity_mirror` is on PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES, so the phone
 * and the Telegram-failure email fallback are both shut — the same guarantee the 06:55 digest has. Routine
 * PLANNED visits (about 600 a working day) are NOT mirrored here: they are the hourly rollup, which the
 * owner chose over a per-visit firehose.
 */
type MirrorLine = {
  title: string;
  message: string;
  tab: Delivery["tab"];
  recordId: string;
  subjectHrId: string | null;
  keySuffix: string;
};

/** The hr ids whose display names the mirror line for this notice needs. */
function activityMirrorPeopleIds(notice: PhoenixCrmNotice): string[] {
  const ids: Array<string | null | undefined> = [];
  switch (notice.kind) {
    case "request_created":
      ids.push(notice.requesterHrId);
      break;
    case "request_decided":
      ids.push(notice.requesterHrId, notice.deciderHrId);
      break;
    case "request_returned":
    case "request_answered":
      ids.push(notice.requesterHrId, notice.returnerHrId);
      break;
    case "plan_submitted":
    case "monthly_plan_submitted":
      ids.push(notice.submitterHrId);
      break;
    case "plan_decided":
    case "monthly_plan_decided":
      ids.push(notice.deciderHrId, ...notice.repHrIds);
      break;
    case "plan_edit":
      ids.push(notice.repHrId, notice.actorHrId);
      break;
    case "unplanned_visit_decided":
      ids.push(notice.repHrId, notice.deciderHrId);
      break;
    case "visit_ask":
      ids.push(notice.repHrId, notice.askedHrId);
      break;
    case "double_visit_request":
      ids.push(notice.repHrId, ...notice.askedHrIds);
      break;
    case "forecast_sent":
    case "unplanned_visit_raised":
    case "day_start":
    case "first_visit":
    case "validation_not_confirmed":
      ids.push(notice.repHrId);
      break;
  }
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * The neutral, third-person line the mirror sends for one action — never the actionable wording of the
 * native notice ("approve it"), which is addressed to the person who must act. Returns null for an action
 * the NSM and SFE already hear of natively (the first visit).
 */
function activityMirrorLine(notice: PhoenixCrmNotice, names: PeopleNames): MirrorLine | null {
  // A manager's plan is never mirrored, and a product manager's has no seat to name.
  if (notice.kind === "manager_plan") return null;
  const territory = territoryName(notice.seat);
  switch (notice.kind) {
    case "first_visit":
      return null;
    // The rep and the two managers above him are told natively; the Administrator's decision is not a feed line.
    case "recorded_visit_decided":
      return null;
    // A return is a step between SFE and one rep: not a feed line for the NSM, and SFE did it himself.
    case "request_returned":
    case "request_answered":
      return null;
    case "request_created": {
      const rep = nameOf(names, notice.requesterHrId, "A rep");
      const verb =
        notice.requestKind === "grade"
          ? `proposed grade ${notice.proposedGrade ?? "—"} for`
          : notice.requestKind === "drop"
            ? "asked to drop"
            : notice.requestKind === "add"
              ? "asked to add"
              : "asked to bring back";
      return {
        title: `Activity · list request: ${notice.customerName}`,
        message: `${rep} ${verb} ${bidiIsolate(notice.customerName)} (${notice.listType}) on ${territory}.`,
        tab: "team",
        recordId: notice.requestId,
        subjectHrId: notice.requesterHrId,
        keySuffix: `request:${notice.requestId}:created`,
      };
    }
    case "request_decided": {
      const decider = deciderNameOf(names, notice.deciderHrId, "A manager");
      const rep = nameOf(names, notice.requesterHrId, "a rep");
      const approved = notice.status === "approved";
      const what =
        notice.requestKind === "grade"
          ? `grade ${notice.proposedGrade ?? "—"} for ${bidiIsolate(notice.customerName)}`
          : notice.requestKind === "drop"
            ? `dropping ${bidiIsolate(notice.customerName)}`
            : notice.requestKind === "add"
              ? `adding ${bidiIsolate(notice.customerName)}`
              : `bringing ${bidiIsolate(notice.customerName)} back`;
      const reversed = notice.reversed === true;
      return {
        title: `Activity · list request ${reversed ? "reversed" : approved ? "approved" : "refused"}: ${notice.customerName}`,
        message: reversed
          ? `${decider} reversed the approval of ${rep}'s request — ${what} on ${territory}.`
          : `${decider} ${approved ? "approved" : "refused"} ${rep}'s request — ${what} on ${territory}.`,
        tab: "team",
        recordId: notice.requestId,
        subjectHrId: notice.requesterHrId,
        keySuffix: `request:${notice.requestId}:${notice.status}`,
      };
    }
    case "plan_submitted": {
      const rep = nameOf(names, notice.submitterHrId, "A rep");
      return {
        title: `Activity · weekly plan sent: ${rep}`,
        message: `${rep} sent the ${territory} weekly plan for the week starting ${formatPhoenixLongDate(notice.weekStart)}.`,
        tab: "team",
        recordId: notice.planId,
        subjectHrId: notice.submitterHrId,
        keySuffix: `plan:${notice.planId}:v${notice.version}:submitted`,
      };
    }
    case "plan_decided": {
      const decider = deciderNameOf(names, notice.deciderHrId, "A manager");
      const approved = notice.status === "approved";
      const week = formatPhoenixLongDate(notice.weekStart);
      const oneDay = !approved && notice.returnedDay ? formatPhoenixLongDate(notice.returnedDay) : null;
      return {
        title: `Activity · weekly plan ${approved ? "approved" : "returned"}`,
        message: approved
          ? `${decider} approved the ${territory} weekly plan for the week starting ${week}.`
          : `${decider} returned ${oneDay ? `${oneDay} of ` : ""}the ${territory} weekly plan for the week starting ${week}.`,
        tab: "team",
        recordId: notice.planId,
        subjectHrId: notice.repHrIds[0] ?? null,
        keySuffix: `plan:${notice.planId}:v${notice.version}:${notice.status}`,
      };
    }
    case "monthly_plan_submitted": {
      const rep = nameOf(names, notice.submitterHrId, "A rep");
      return {
        title: `Activity · monthly plan sent: ${rep}`,
        message: `${rep} sent the ${territory} plan for ${formatPhoenixMonth(notice.monthStart)}.`,
        tab: "team",
        recordId: notice.monthlyPlanId,
        subjectHrId: notice.submitterHrId,
        keySuffix: `monthly:${notice.monthlyPlanId}:v${notice.version}:submitted`,
      };
    }
    case "monthly_plan_decided": {
      const decider = deciderNameOf(names, notice.deciderHrId, "A manager");
      const approved = notice.status === "approved";
      return {
        title: `Activity · monthly plan ${approved ? "approved" : "returned"}`,
        message: `${decider} ${approved ? "approved" : "returned"} the ${territory} plan for ${formatPhoenixMonth(notice.monthStart)}.`,
        tab: "team",
        recordId: notice.monthlyPlanId,
        subjectHrId: notice.repHrIds[0] ?? null,
        keySuffix: `monthly:${notice.monthlyPlanId}:v${notice.version}:${notice.status}`,
      };
    }
    case "plan_edit": {
      const rep = nameOf(names, notice.repHrId, "A rep");
      return {
        title: `Activity · plan edit: ${rep}`,
        message: `${rep}'s request to edit the ${territory} week starting ${formatPhoenixLongDate(notice.weekStart)} — ${planEditStatusLabel(notice.status)}.`,
        tab: "team",
        recordId: notice.requestId,
        subjectHrId: notice.repHrId,
        keySuffix: `plan_edit:${notice.requestId}:v${notice.version}:${notice.status}`,
      };
    }
    case "forecast_sent": {
      const rep = nameOf(names, notice.repHrId, "A rep");
      return {
        title: `Activity · daily forecast: ${rep}`,
        message: `${rep} sent the ${territory} daily forecast for ${formatPhoenixLongDate(notice.day)}.`,
        tab: "forecast",
        recordId: `${notice.seat.seatId}:${notice.day}`,
        subjectHrId: notice.repHrId,
        keySuffix: `forecast:${notice.seat.seatId}:${notice.day}`,
      };
    }
    case "unplanned_visit_raised": {
      const rep = nameOf(names, notice.repHrId, "A rep");
      const day = formatPhoenixLongDate(notice.visitDate);
      return {
        title: `Activity · off-plan visit: ${notice.customerName}`,
        message: notice.enteredByAdmin
          ? `An off-plan visit was logged for ${rep}: ${bidiIsolate(notice.customerName)} on ${territory} (${day}).`
          : `${rep} logged an off-plan visit to ${bidiIsolate(notice.customerName)} on ${territory} (${day}).`,
        tab: "team",
        recordId: notice.visitId,
        subjectHrId: notice.repHrId,
        keySuffix: `unplanned:${notice.visitId}:raised`,
      };
    }
    case "unplanned_visit_decided": {
      const decider = deciderNameOf(names, notice.deciderHrId, "A manager");
      const rep = nameOf(names, notice.repHrId, "a rep");
      const day = formatPhoenixLongDate(notice.visitDate);
      const word =
        notice.reversed === true
          ? "reversed"
          : notice.status === "approved"
            ? "approved"
            : notice.status === "refused"
              ? "refused"
              : "passed to SFE";
      return {
        title: `Activity · off-plan visit ${word}: ${notice.customerName}`,
        message:
          notice.reversed === true
            ? `${decider} reversed the approval of ${rep}'s off-plan visit to ${bidiIsolate(notice.customerName)} on ${territory} (${day}).`
            : `${decider} ${word} ${rep}'s off-plan visit to ${bidiIsolate(notice.customerName)} on ${territory} (${day}).`,
        tab: "team",
        recordId: notice.visitId,
        subjectHrId: notice.repHrId,
        keySuffix: `unplanned:${notice.visitId}:v${notice.version}:${notice.status}`,
      };
    }
    case "visit_ask": {
      const rep = nameOf(names, notice.repHrId, "A rep");
      const asked = nameOf(names, notice.askedHrId, "the person asked");
      const kindWord = notice.askKind === "chain" ? "chain visit" : notice.askKind === "product_manager" ? "product manager visit" : "double visit";
      const customer = `${bidiIsolate(notice.customerName)} (${notice.listType})`;
      const message =
        notice.status === "waiting"
          ? `${rep} asked ${asked} for a ${kindWord} to ${customer} on ${territory}.`
          : notice.status === "accepted"
            ? `${asked} accepted ${rep}'s ${kindWord} to ${customer}${notice.visitOn ? ` on ${formatPhoenixLongDate(notice.visitOn)}` : ""}.`
            : `${asked} declined ${rep}'s ${kindWord} to ${customer}.`;
      return {
        title: `Activity · ${kindWord}: ${notice.customerName}`,
        message,
        tab: "team",
        recordId: notice.askId,
        subjectHrId: notice.repHrId,
        keySuffix: `visit_ask:${notice.askId}:${notice.status}`,
      };
    }
    case "double_visit_request": {
      const rep = nameOf(names, notice.repHrId, "A rep");
      const people = notice.askedHrIds.map((hrId) => nameOf(names, hrId, "the person asked")).join(", ");
      const customer = `${bidiIsolate(notice.customerName)} (${notice.listType})`;
      const days = notice.days.map((day) => formatPhoenixLongDate(day)).join(", ");
      const message =
        notice.step === "raised"
          ? `${rep} asked ${people} for a double visit to ${customer} on ${territory}. Days offered: ${days}.`
          : notice.step === "days_changed"
            ? `${rep} changed the days offered for a double visit to ${customer} on ${territory}: ${days}.`
            : notice.step === "accepted"
              ? `${people} accepted ${rep}'s double visit to ${customer}${notice.visitOn ? ` on ${formatPhoenixLongDate(notice.visitOn)}` : ""}.`
              : `${people} declined ${rep}'s double visit to ${customer}.`;
      const answered = notice.step === "accepted" || notice.step === "declined";
      return {
        title: `Activity · double visit: ${notice.customerName}`,
        message,
        tab: "team",
        recordId: notice.requestId,
        subjectHrId: notice.repHrId,
        keySuffix: `double_visit:${notice.requestId}:${notice.step}${notice.step === "days_changed" ? `:${notice.version}` : ""}${answered ? `:${notice.askedHrIds[0] ?? ""}:${notice.visitOn ?? "none"}` : ""}`,
      };
    }
    case "day_start": {
      const rep = nameOf(names, notice.repHrId, "A rep");
      return {
        title: `Activity · started working: ${rep}`,
        // Time only — the place is the district manager's and the SFE Manager's alone (dayStartDeliveries).
        message: `${rep} confirmed they started working at ${formatPhoenixDateTime(notice.startedAt)} (Cairo), ${territory}.`,
        tab: "team",
        recordId: notice.seat.seatId,
        subjectHrId: notice.repHrId,
        keySuffix: `day_start:${personKey(notice.repHrId) ?? notice.repHrId}:${notice.startedAt.slice(0, 10)}`,
      };
    }
    case "validation_not_confirmed": {
      const rep = nameOf(names, notice.repHrId, "A rep");
      return {
        title: `Activity · validate again: ${notice.customerName}`,
        // 🔴 THE MIRROR CARRIES THE FACT, NEVER THE REASON. The NSM and the SFE Manager read that the
        // customer is back under To validate; what is wrong with the photograph is the rep's own
        // sentence and the Super Admin's evidence, and routing it here would make a managers' feed out
        // of a judgement on one rep's picture. 🔴 And a case is REQUIRED, not optional: this function
        // returns null for an unhandled kind, so a missing case is a silent hole in the feed rather
        // than a type error.
        message: `${bidiIsolate(notice.customerName)} is back under To validate for ${rep}, ${territory}.`,
        tab: "team",
        recordId: notice.reviewId,
        subjectHrId: notice.repHrId,
        keySuffix: `validation_not_confirmed:${notice.reviewId}${notice.attempt ? `:${notice.attempt}` : ""}`,
      };
    }
  }
}

/**
 * Who DID the action, when that is a decider or an answerer rather than the rep the line is about — so the
 * mirror never echoes a manager's own decision back to him. An NSM who approves a request, or an SFE
 * Manager who answers a visit ask, is the one person in scope who already knows it happened.
 */
function activityMirrorActorHrId(notice: PhoenixCrmNotice): string | null {
  switch (notice.kind) {
    case "request_decided":
    case "plan_decided":
    case "monthly_plan_decided":
    case "unplanned_visit_decided":
      return notice.deciderHrId;
    case "request_returned":
      return notice.returnerHrId;
    case "request_answered":
      return notice.requesterHrId;
    case "plan_edit":
      return notice.actorHrId;
    case "visit_ask":
      return notice.status === "waiting" ? notice.repHrId : notice.askedHrId;
    case "double_visit_request":
      return notice.step === "accepted" || notice.step === "declined" ? (notice.askedHrIds[0] ?? null) : notice.repHrId;
    // 🔴 Explicitly nobody, and not left to the default: this notice deliberately carries NO decider
    // hr id — the rep must never be able to learn that a person judged his photo (Golden Rule #1) —
    // and the one person who can decide these is the Super Admin, who is not in the mirror's audience
    // (the national sales manager and the SFE Managers) in the first place.
    case "validation_not_confirmed":
      return null;
    default:
      return null;
  }
}

/**
 * The mirror delivery for one action: the NSM in the rep's chain plus the SFE Managers, minus the rep, the
 * actor, and anyone the native notices already reached. Pure, so who it reaches, the dedup, and the one
 * line that must carry no location are pinned by a test (tests/phoenix-crm-activity-mirror.test.ts).
 */
export function buildActivityMirrorDelivery(
  notice: PhoenixCrmNotice,
  org: OrgIndex,
  names: PeopleNames,
  sfeHrIds: readonly string[],
  nativeRecipientKeys: ReadonlySet<string>,
): Delivery | null {
  const line = activityMirrorLine(notice, names);
  if (!line || notice.kind === "manager_plan") return null;
  const nsm = managerChain(org, notice.seat.seatId).find((member) => member.seat.tier === "NSM")?.hrId ?? null;
  const excluded = new Set(
    [line.subjectHrId, activityMirrorActorHrId(notice)].map((hrId) => personKey(hrId)).filter((key): key is string => key !== null),
  );
  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const hrId of [...(nsm ? [nsm] : []), ...sfeHrIds]) {
    const key = personKey(hrId);
    if (!key || seen.has(key) || nativeRecipientKeys.has(key) || excluded.has(key)) continue;
    seen.add(key);
    recipients.push(key);
  }
  if (recipients.length === 0) return null;
  return {
    recipients,
    eventType: "activity_mirror",
    title: line.title,
    message: line.message,
    tab: line.tab,
    recordId: line.recordId,
    idempotencyKey: `phoenix_crm:activity:${line.keySuffix}`,
    subjectHrId: line.subjectHrId,
  };
}

/** Resolve the people and org the mirror needs, then build its one delivery (null when nobody is left). */
async function activityMirrorDelivery(notice: PhoenixCrmNotice, nativeDeliveries: Delivery[]): Promise<Delivery | null> {
  if (notice.kind === "first_visit" || notice.kind === "manager_plan" || notice.kind === "recorded_visit_decided") return null;
  const org = (notice as { org?: OrgIndex }).org ?? (await loadPhoenixCrmOrg());
  const [sfe, names] = await Promise.all([sfeManagerHrIds(), loadPeopleNames(activityMirrorPeopleIds(notice))]);
  const nativeRecipientKeys = new Set(
    nativeDeliveries
      .flatMap((delivery) => delivery.recipients)
      .map((hrId) => personKey(hrId))
      .filter((key): key is string => key !== null),
  );
  return buildActivityMirrorDelivery(notice, org, names, sfe, nativeRecipientKeys);
}

/**
 * Tell everyone a Phoenix CRM action concerns — AFTER the reply has gone (Phoenix CRM performance audit,
 * 2026-10-16). Twenty-odd writes awaited this while the person who pressed Save waited: the live-team
 * read, the org, the names, the SFE role read, then every recipient's in-app row, Telegram and phone, one
 * after another — although it never throws, so no answer could ever depend on it. A plan submit measured
 * 975 ms on production that afternoon. `afterResponse` runs it once the response has closed; outside a
 * request (a cron's loop, a script, the unit suite) it is awaited exactly as before. The notice therefore
 * reaches the bell about a second after the save, never before the record it describes exists.
 *
 * Callers keep their `await` deliberately: inside a request it returns at once, outside one it is the
 * same awaited call it always was. A withdrawal that must happen BEFORE the new notice stays an awaited
 * call ahead of this one, so it still lands first.
 */
/**
 * The live-team gate for one notice. A territory's notice: its own team. A manager's plan: a district
 * manager's own team; a regional or national sales manager's — any live team BELOW his seat, the rule that
 * moved his week here (`seniorPlansInPhoenixCrm`); a product manager's always passes, since he sits on no
 * seat and his week only exists here once he chose to plan it.
 */
async function noticeIsForALiveTeam(notice: PhoenixCrmNotice, live: ReadonlySet<string>): Promise<boolean> {
  if (notice.kind !== "manager_plan") return seatIsInLiveTeam(notice.seat, live);
  const seat = notice.seat;
  if (!seat) return true;
  if (seat.tier !== "RSM" && seat.tier !== "NSM") return seatIsInLiveTeam(seat, live);
  const org = await loadPhoenixCrmOrg();
  return seatHasLiveTeamBelow(org.seats, seat.seatId, live);
}

export async function notifyPhoenixCrm(notice: PhoenixCrmNotice, isTest: boolean): Promise<void> {
  await afterResponse(`phoenix_crm_notify:${notice.kind}`, () => sendPhoenixCrmNotice(notice, isTest));
}

async function sendPhoenixCrmNotice(notice: PhoenixCrmNotice, isTest: boolean): Promise<void> {
  try {
    // One SFE role read per notice: `describe` and the mirror both ask for the SFE Managers, and they
    // are the same people within one send.
    await withSfeManagersReadOnce(async () => {
      // Only a LIVE team is told anything (owner, 2026-10-08): a notice about a territory whose team the
      // Super Admin has not started tells nobody — rep, district manager, SFE or NSM. The test world keeps
      // its in-app copies, and an unreadable gate fails open (live-teams.ts). Read fresh on every notice,
      // never from a cache: a team the Super Admin has just stopped must not be told one more thing.
      if (!isTest) {
        const live = await loadLiveTeamSeatIds();
        if (live && !(await noticeIsForALiveTeam(notice, live))) return;
      }
      const described = await describe(notice);
      const deliveries = described === null ? [] : Array.isArray(described) ? described : [described];
      // Mirror the action to the NSM and SFE in scope (owner, 2026-10-05), as a parallel delivery deduped
      // against the native recipients — so the tuned notices above are untouched and nobody is told twice.
      const mirror = await activityMirrorDelivery(notice, deliveries);
      if (mirror) deliveries.push(mirror);
      // Each delivery has its own recipients and its own idempotency key, so none waits on another.
      await Promise.all(deliveries.map((delivery) => deliver(notice, delivery, isTest)));
    });
  } catch (error) {
    logError("Phoenix CRM notification failed", {
      labels: { event: "phoenix_crm_notify_failed", kind: notice.kind },
      error,
    });
  }
}

/** Every notice ever raised about one visit — both kinds, every version, and the test-world copies. */
export function phoenixCrmVisitNoticeKeyPrefix(visitId: string): string {
  return `phoenix_crm:unplanned:${visitId}:`;
}

/**
 * Take back the notices about a visit that no longer exists (owner, 2026-10-02: "close the stale
 * manager notice when an entered visit is removed").
 *
 * 🔴 ONLY A REMOVED VISIT, AND IT IS THE RECORD'S ABSENCE THAT JUSTIFIES IT. The manager was told to
 * approve an off-plan visit; the Super Admin then took back the entry he had made for the rep, so the
 * queue item is gone and the notice is a to-do with nothing behind it. Every notice naming that visit
 * goes the same way — the rep's "approved"/"refused" copies describe the same vanished visit — and
 * the prefix names ONE visit, never the category.
 *
 * A PLANNED entered visit raises no notice at all, so this is a no-op for one, and it stays correct
 * rather than conditional: the keys simply match nothing.
 *
 * Never throws, exactly like `notifyPhoenixCrm`: a notice that cannot be withdrawn must not undo the
 * removal that has already happened in the database.
 */
export async function withdrawPhoenixCrmVisitNotices(
  visitId: string,
  client?: Parameters<typeof withdrawInAppNotificationsByEventKeyPrefix>[1],
): Promise<void> {
  try {
    await withdrawInAppNotificationsByEventKeyPrefix(phoenixCrmVisitNoticeKeyPrefix(visitId), client);
  } catch (error) {
    logError("Phoenix CRM notice withdrawal failed", {
      labels: { event: "phoenix_crm_notice_withdraw_failed", visitId },
      error,
    });
  }
}

/** Every notice ever raised about one rep's weekly plan — each version and step, and the test-world copies. */
export function phoenixCrmPlanNoticeKeyPrefix(planId: string): string {
  return `phoenix_crm:plan:${planId}:`;
}

/** Every notice ever raised about one monthly plan — each version and step. */
export function phoenixCrmMonthlyNoticeKeyPrefix(monthlyPlanId: string): string {
  return `phoenix_crm:monthly:${monthlyPlanId}:`;
}

/** Every notice ever raised about one request to edit a week — each version and status. */
export function phoenixCrmPlanEditNoticeKeyPrefix(requestId: string): string {
  return `phoenix_crm:plan_edit:${requestId}:`;
}

/**
 * Take back every notice about a weekly plan the Super Admin deleted as if it never happened (owner,
 * 2026-10-23): the plan's own notices and those of every request to edit it. A plan's absence is what
 * justifies it, exactly like a removed visit's.
 *
 * Never throws, exactly like `notifyPhoenixCrm`: a notice that cannot be withdrawn must not undo a
 * deletion that has already happened in the database.
 */
export async function withdrawPhoenixCrmPlanNotices(plan: {
  kind: "rep_plan" | "manager_plan" | "monthly_plan";
  planId: string;
  editRequestIds: ReadonlyArray<string>;
}): Promise<void> {
  const prefixes = [
    plan.kind === "rep_plan"
      ? phoenixCrmPlanNoticeKeyPrefix(plan.planId)
      : plan.kind === "monthly_plan"
        ? phoenixCrmMonthlyNoticeKeyPrefix(plan.planId)
        : managerPlanNoticeKeyPrefix(plan.planId),
    ...plan.editRequestIds.map(phoenixCrmPlanEditNoticeKeyPrefix),
  ];
  for (const prefix of prefixes) {
    try {
      await withdrawInAppNotificationsByEventKeyPrefix(prefix);
    } catch (error) {
      logError("Phoenix CRM plan notice withdrawal failed", {
        labels: { event: "phoenix_crm_plan_notice_withdraw_failed", planId: plan.planId },
        error,
      });
    }
  }
}

/** Every notice ever raised about one visit ask — each step, each person, and the test-world copies. */
export function phoenixCrmVisitAskNoticeKeyPrefix(askId: string): string {
  return `phoenix_crm:visit_ask:${askId}:`;
}

/**
 * Take back the notices of an ask that no longer waits on anybody: the whole ask when the rep cancels it
 * (a cancel is never announced — the to-do simply goes), and its "waiting" step once it is answered, so
 * the person asked is not left with an "accept or decline" line he has already acted on (the same rule
 * the off-plan visit's notice follows, owner, 2026-10-02).
 *
 * Never throws, exactly like `notifyPhoenixCrm`: a notice that cannot be withdrawn must not undo the
 * answer or the cancel that has already happened in the database.
 */
export async function withdrawPhoenixCrmVisitAskNotices(askId: string, step: "waiting" | null = null): Promise<void> {
  try {
    await withdrawInAppNotificationsByEventKeyPrefix(`${phoenixCrmVisitAskNoticeKeyPrefix(askId)}${step ?? ""}`);
  } catch (error) {
    logError("Phoenix CRM visit ask notice withdrawal failed", {
      labels: { event: "phoenix_crm_visit_ask_withdraw_failed", askId },
      error,
    });
  }
}

/** Every notice ever raised about one double-visit request — each step, each person, and the test-world copies. */
export function phoenixCrmDoubleVisitNoticeKeyPrefix(requestId: string): string {
  return `phoenix_crm:double_visit:${requestId}:`;
}

/**
 * Take back the "accept or decline" line of a person who has answered (the off-plan visit's notice
 * follows the same rule), so he is not left with a to-do he already did. Never throws, exactly like
 * `notifyPhoenixCrm`. There is no whole-request withdrawal: a request is never cancelled.
 */
export async function withdrawPhoenixCrmDoubleVisitWaitingNotices(requestId: string, hrId: string): Promise<void> {
  const key = personKey(hrId) ?? hrId;
  try {
    // `<request>:<person>:raised` and `<request>:<person>:days:<version>` — one prefix is all of his.
    await withdrawInAppNotificationsByEventKeyPrefix(`${phoenixCrmDoubleVisitNoticeKeyPrefix(requestId)}${key}:`);
  } catch (error) {
    logError("Phoenix CRM double visit notice withdrawal failed", {
      labels: { event: "phoenix_crm_double_visit_withdraw_failed", requestId },
      error,
    });
  }
}

async function deliver(notice: PhoenixCrmNotice, delivery: Delivery, isTest: boolean): Promise<void> {
  // Straight to the module's own page. `/field-crm?tab=` still works for every link already sent, but it
  // is a redirect — a whole portal render — before the page the notice is about. The badges read both.
  const actionUrl = delivery.path ?? phoenixCrmModulePath(PHOENIX_CRM_PORTAL_PATH, delivery.tab);
  const base = {
    actionUrl,
    category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
    eventType: delivery.eventType,
    message: delivery.message,
    module: PHOENIX_CRM_NOTIFICATION_MODULE,
    priority: "normal" as const,
    recordId: delivery.recordId,
    subjectHrId: delivery.subjectHrId,
    title: delivery.title,
  };

  if (!isTest) {
    await createSystemNotificationForRecipients(
      {
        ...base,
        channels: phoenixCrmChannels(delivery.eventType, delivery.inAppOnly),
        metadata: { ...(delivery.metadata ?? {}), idempotencyKey: delivery.idempotencyKey, seatId: notice.seat?.seatId ?? null },
        ...(delivery.inAppOnly ? {} : { telegram: { ctaLabel: "Open Phoenix CRM", ctaUrl: actionUrl } }),
      },
      delivery.recipients,
    );
    return;
  }

  // The test world. Each recipient becomes the TEST- login that mirrors him, and a recipient no
  // test account mirrors is dropped rather than told — never addressed to the real person.
  const mirrors = await testAccountsMirroring(delivery.recipients);
  for (const mirror of mirrors) {
    await createSystemNotificationForRecipients(
      {
        ...base,
        // In-app alone. `createSystemNotificationForRecipient` enforces this again from the
        // marker, so neither a policy nor a preference can put a test entry on her Telegram.
        channels: ["in_app"],
        // A DIFFERENT key from the real notice's. They share an `event_key` upsert
        // (onConflict: "event_key"), so reusing it would overwrite a real person's notification
        // row with a test one — the leak this whole path is built to avoid.
        metadata: {
          ...(delivery.metadata ?? {}),
          idempotencyKey: `${delivery.idempotencyKey}:test:${mirror.loginId}`,
          seatId: notice.seat?.seatId ?? null,
        },
        testLoginId: mirror.loginId,
      },
      [mirror.hrId],
    );
  }
}
