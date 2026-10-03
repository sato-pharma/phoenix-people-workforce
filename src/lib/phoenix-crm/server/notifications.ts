/**
 * Phoenix CRM — who is told what.
 *
 * Owner rules: in-app and Telegram, never email (the module's email is hard-blocked in
 * src/lib/notifications/phoenix-crm-channel-guard.ts; the policy row is the intent, the guard the
 * enforcement) — with ONE exception the owner ordered on 2026-10-01: a rep's request to edit a week he
 * already sent goes by email too, at every step (`phoenixCrmChannels` names the five event types).
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

import { bidiIsolate } from "@/emails/bidi";
import { formatPhoenixDateTime, formatPhoenixLongDate, formatPhoenixMonth } from "@/lib/i18n/format";
import { phoenixCrmChannels } from "@/lib/notifications/phoenix-crm-channel-guard";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { withdrawInAppNotificationsByEventKeyPrefix } from "@/lib/notifications/in-app";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { testAccountsMirroring } from "@/lib/auth/test-persona-directory";
import { logError } from "@/lib/observability/log";
import { dropReasonLabel } from "@/lib/phoenix-crm/entry-rules";
import { PLAN_EDIT_ACKNOWLEDGER_HR_ID, type PlanEditStatus } from "@/lib/phoenix-crm/plan-edit-rules";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { managerChain, personKey, territoryName, territoryReviewer, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmListType, PhoenixCrmRequestKind } from "@/lib/phoenix-crm/types";
import type { UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";
import type { VisitAskKind } from "@/lib/phoenix-crm/visit-ask-rules";

export const PHOENIX_CRM_NOTIFICATION_MODULE = "phoenix_crm";
export const PHOENIX_CRM_NOTIFICATION_CATEGORY = "phoenix_crm";
export const PHOENIX_CRM_PORTAL_PATH = "/employee-portals/field-crm";

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
    }
  | {
      kind: "plan_submitted";
      org: OrgIndex;
      seat: OrgSeat;
      planId: string;
      version: number;
      weekStart: string;
      submitterHrId: string;
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
      decidedAs: "reviewer" | "sfe";
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
      decidedAs: "reviewer" | "sfe";
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
    };

type Delivery = {
  recipients: string[];
  eventType: string;
  title: string;
  message: string;
  /** A product manager answers an ask on the Reports page, the one page of the module he opens. */
  tab: "team" | "list" | "plan" | "visits" | "forecast" | "reports";
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
  const { hrIds } = await resolveHrIdsForRole("SFE Manager", "Phoenix CRM — SFE Managers");
  // A test account holds the role it mirrors; its TEST- id is never a real person to tell.
  return hrIds.filter((hrId) => !hrId.startsWith("TEST-"));
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
  const actor = nameOf(names, notice.actorHrId, "The approver");
  const week = formatPhoenixLongDate(notice.weekStart);
  const status = notice.status;
  const raised = notice.actorHrId === notice.repHrId && (status === "manager_pending" || status === "sfe_pending");
  // Read as booleans first, so the eventType line below carries event NAMES and nothing else.
  const reopened = status === "reopened";
  const refused = status === "refused";
  const expired = status === "expired";
  const note = notice.note ? ` Note: ${notice.note}` : "";

  const next: string[] =
    status === "manager_pending" ? (reviewer ? [reviewer.hrId] : []) : status === "sfe_pending" ? sfe : status === "hr_pending" ? [PLAN_EDIT_ACKNOWLEDGER_HR_ID] : [];
  const actorKey = personKey(notice.actorHrId);
  const repKey = personKey(notice.repHrId);
  const managers = [...new Set([...next, ...(reviewer ? [reviewer.hrId] : []), ...sfe])].filter((hrId) => {
    const key = personKey(hrId);
    return key !== null && key !== actorKey && key !== repKey;
  });

  const nextStep =
    status === "manager_pending"
      ? "The district manager decides first, then SFE, then HR."
      : status === "sfe_pending"
        ? raised
          ? "SFE decides first (the territory has no district manager), then HR."
          : "SFE decides next, then HR."
        : status === "hr_pending"
          ? "It opens again once HR acknowledges it."
          : "";
  const title = raised
    ? `Request to edit a weekly plan: ${rep}`
    : reopened
      ? `Weekly plan open to edit: ${rep}, week starting ${week}`
      : refused
        ? `Refused: ${rep}'s request to edit a weekly plan`
        : expired
          ? `Expired: ${rep}'s request to edit a weekly plan`
          : `Approved by ${actor}: ${rep}'s request to edit a weekly plan`;
  const message = raised
    ? `${rep} asks to edit the ${territory} plan for the week starting ${week}, which is already sent. ${nextStep}`
    : reopened
      ? `HR acknowledged ${rep}'s request. The ${territory} plan for the week starting ${week} is open again for him to change and send again.`
      : refused
        ? `${actor} refused ${rep}'s request to edit the ${territory} plan for the week starting ${week}. The week stays as it was sent.${note}`
        : expired
          ? `The week starting ${week} passed before ${rep}'s request to edit the ${territory} plan was settled.`
          : `${actor} approved ${rep}'s request to edit the ${territory} plan for the week starting ${week}. ${nextStep}${note}`;
  const repMessage = reopened
    ? `HR acknowledged your request. Your plan for the week starting ${week} is open again: change the days from today on and send it again. Until you send it, your visits this week count as off-plan.`
    : refused
      ? `${actor} refused your request to edit your plan for the week starting ${week}. The week stays as you sent it.${note}`
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
    const wish = notice.wishedOn ? `He would like ${formatPhoenixLongDate(notice.wishedOn)}.` : "Any day suits him.";
    const what = chain
      ? `a chain visit to ${customer} on ${territory}: you, ${told ?? "the manager above"} and him`
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

async function describe(notice: PhoenixCrmNotice): Promise<Delivery | Delivery[] | null> {
  const territory = territoryName(notice.seat);

  if (notice.kind === "plan_edit") return describePlanEdit(notice);
  if (notice.kind === "first_visit") return describeFirstVisit(notice);
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
    const decider = nameOf(names, notice.deciderHrId, "Your manager");
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
    return {
      recipients: [notice.requesterHrId],
      eventType: approved ? "request_approved" : "request_refused",
      title: `${approved ? "Approved" : "Refused"}: ${subject} for ${notice.customerName}`,
      message: `${decider} ${approved ? "approved" : "refused"} ${what} on ${territory}.${note}`,
      tab: "list",
      recordId: notice.requestId,
      idempotencyKey: `phoenix_crm:request:${notice.requestId}:${notice.status}`,
      subjectHrId: notice.requesterHrId,
    };
  }

  if (notice.kind === "plan_submitted") {
    const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
    if (!reviewer) return null;
    const names = await loadPeopleNames([notice.submitterHrId]);
    const rep = nameOf(names, notice.submitterHrId, "A rep");
    return {
      recipients: [reviewer.hrId],
      eventType: "plan_waiting",
      title: `Weekly plan to review from ${rep}`,
      message: `${rep} sent the ${territory} plan for the week starting ${formatPhoenixLongDate(notice.weekStart)}. Approve it or return it with a note in Phoenix CRM.`,
      tab: "team",
      recordId: notice.planId,
      idempotencyKey: `phoenix_crm:plan:${notice.planId}:v${notice.version}:submitted`,
      subjectHrId: notice.submitterHrId,
    };
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
    const decider = nameOf(names, notice.deciderHrId, "Your manager");
    const month = formatPhoenixMonth(notice.monthStart);
    const recipients = [...notice.repHrIds];
    if (notice.status === "returned" && notice.decidedAs === "sfe") {
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
        ? `The Super Admin entered a visit ${rep} missed logging: ${notice.customerName} on ${territory}, off the plan, on ${day}. The reason given: ${notice.clarification} — approve it or refuse it in Phoenix CRM. It counts in nothing until ${steps} approve it.`
        : `${rep} visited ${notice.customerName} on ${territory} off his plan on ${day}. He wrote: ${notice.clarification} — approve it or refuse it in Phoenix CRM. It counts in nothing until ${steps} approve it.`,
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
    const decider = nameOf(names, notice.deciderHrId, "Your manager");
    const day = formatPhoenixLongDate(notice.visitDate);
    const note = notice.note ? ` Note: ${notice.note}` : "";
    // Read as booleans first, so the eventType line below carries event NAMES and nothing else.
    const approved = notice.status === "approved";
    const refused = notice.status === "refused";
    const deliveries: Delivery[] = [
      {
        recipients: [notice.repHrId],
        eventType: approved ? "unplanned_visit_approved" : refused ? "unplanned_visit_refused" : "unplanned_visit_moved_on",
        title: approved || refused
          ? `${approved ? "Approved" : "Refused"}: off-plan visit to ${notice.customerName}`
          : `Passed to SFE: off-plan visit to ${notice.customerName}`,
        message: approved
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
            notice.clarification ? ` He wrote: ${notice.clarification}` : ""
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
  const decider = nameOf(names, notice.deciderHrId, "Your manager");
  const week = formatPhoenixLongDate(notice.weekStart);
  const recipients = [...notice.repHrIds];
  if (notice.status === "returned" && notice.decidedAs === "sfe") {
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

export async function notifyPhoenixCrm(notice: PhoenixCrmNotice, isTest: boolean): Promise<void> {
  try {
    const described = await describe(notice);
    const deliveries = described === null ? [] : Array.isArray(described) ? described : [described];
    for (const delivery of deliveries) await deliver(notice, delivery, isTest);
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

async function deliver(notice: PhoenixCrmNotice, delivery: Delivery, isTest: boolean): Promise<void> {
  const actionUrl = `${PHOENIX_CRM_PORTAL_PATH}?tab=${delivery.tab}`;
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
        metadata: { ...(delivery.metadata ?? {}), idempotencyKey: delivery.idempotencyKey, seatId: notice.seat.seatId },
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
          seatId: notice.seat.seatId,
        },
        testLoginId: mirror.loginId,
      },
      [mirror.hrId],
    );
  }
}
