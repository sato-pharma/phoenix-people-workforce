/**
 * Phoenix CRM — who is told what.
 *
 * Owner rules: in-app and Telegram, never email (the module's email is hard-blocked in
 * src/lib/notifications/phoenix-crm-channel-guard.ts; the policy row is the intent, the guard the
 * enforcement). The Super Admin's test entries tell nobody.
 *
 *   - a grade or drop request waits      → the territory's reviewing manager;
 *   - a request is decided               → the rep who asked;
 *   - a weekly plan is sent for review   → the reviewing manager;
 *   - a plan is approved or returned     → the rep; a plan the SFE Manager returns also tells the
 *                                          reviewing manager, whose approval it undoes.
 *
 * A PLANNED visit tells nobody: double and chain visits count straight away, and a far visit is
 * flagged on the manager's screens rather than pushed (about 600 visits a working day). An OFF-PLAN
 * visit is the one exception (owner, 2026-09-26) — it counts in nothing until it is approved, so the
 * manager who must approve it is told, and the rep is told each time it moves.
 *
 * Never throws: a notice that cannot be delivered must not undo a saved decision.
 */

import { formatPhoenixLongDate, formatPhoenixMonth } from "@/lib/i18n/format";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { dropReasonLabel } from "@/lib/phoenix-crm/entry-rules";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { territoryName, territoryReviewer, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import type { UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";

export const PHOENIX_CRM_NOTIFICATION_MODULE = "phoenix_crm";
export const PHOENIX_CRM_NOTIFICATION_CATEGORY = "phoenix_crm";
export const PHOENIX_CRM_PORTAL_PATH = "/employee-portals/field-crm";

export type PhoenixCrmNotice =
  | {
      kind: "request_created";
      org: OrgIndex;
      seat: OrgSeat;
      requestId: string;
      requestKind: "grade" | "drop";
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
      requestKind: "grade" | "drop";
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
    };

type Delivery = {
  recipients: string[];
  eventType: string;
  title: string;
  message: string;
  tab: "team" | "list" | "plan" | "visits";
  recordId: string;
  idempotencyKey: string;
  subjectHrId: string | null;
};

async function describe(notice: PhoenixCrmNotice): Promise<Delivery | null> {
  const territory = territoryName(notice.seat);

  if (notice.kind === "request_created") {
    const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
    if (!reviewer) return null;
    const names = await loadPeopleNames([notice.requesterHrId]);
    const rep = nameOf(names, notice.requesterHrId, "A rep");
    const customer = `${notice.customerName} (${notice.listType})`;
    const grade = notice.requestKind === "grade";
    return {
      recipients: [reviewer.hrId],
      eventType: grade ? "grade_request_waiting" : "drop_request_waiting",
      title: grade ? `Grade to approve for ${notice.customerName}` : `Drop to approve for ${notice.customerName}`,
      message: grade
        ? `${rep} proposes grade ${notice.proposedGrade ?? "—"} for ${customer} on ${territory}. Approve or refuse it in Phoenix CRM.`
        : `${rep} asks to take ${customer} off the ${territory} list. Reason: ${dropReasonLabel(notice.dropReason) ?? "not given"}. Approve or refuse it in Phoenix CRM.`,
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
        : `taking ${notice.customerName} off your list`;
    const note = notice.note ? ` Note: ${notice.note}` : "";
    return {
      recipients: [notice.requesterHrId],
      eventType: approved ? "request_approved" : "request_refused",
      title: `${approved ? "Approved" : "Refused"}: ${notice.requestKind === "grade" ? "grade" : "drop"} for ${notice.customerName}`,
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

  if (notice.kind === "unplanned_visit_raised") {
    // The reviewing manager, exactly as a grade request goes to him. A territory whose chain is vacant
    // starts at the SFE stage, and the SFE Manager is a ROLE with no seat in the organogram — there is
    // no hr id here to address, so it goes unpushed and the Team tab's counter carries it, the same
    // silence plan_submitted already keeps for a vacant chain.
    const reviewer = territoryReviewer(notice.org, notice.seat.seatId);
    if (!reviewer) return null;
    const names = await loadPeopleNames([notice.repHrId]);
    const rep = nameOf(names, notice.repHrId, "A rep");
    return {
      recipients: [reviewer.hrId],
      eventType: "unplanned_visit_waiting",
      title: `Off-plan visit to approve: ${notice.customerName}`,
      message: `${rep} visited ${notice.customerName} on ${territory} off his plan on ${formatPhoenixLongDate(notice.visitDate)}. He wrote: ${notice.clarification} — approve it or refuse it in Phoenix CRM. It counts in nothing until you and then SFE approve it.`,
      tab: "team",
      recordId: notice.visitId,
      idempotencyKey: `phoenix_crm:unplanned:${notice.visitId}:raised`,
      subjectHrId: notice.repHrId,
    };
  }

  if (notice.kind === "unplanned_visit_decided") {
    const names = await loadPeopleNames([notice.deciderHrId]);
    const decider = nameOf(names, notice.deciderHrId, "Your manager");
    const day = formatPhoenixLongDate(notice.visitDate);
    const note = notice.note ? ` Note: ${notice.note}` : "";
    // Read as booleans first, so the eventType line below carries event NAMES and nothing else.
    const approved = notice.status === "approved";
    const refused = notice.status === "refused";
    return {
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
      idempotencyKey: `phoenix_crm:unplanned:${notice.visitId}:v${notice.version}:${notice.status}`,
      subjectHrId: notice.repHrId,
    };
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
  return {
    recipients,
    eventType: approved ? "plan_approved" : "plan_returned",
    title: approved ? `Weekly plan approved: week starting ${week}` : `Weekly plan returned: week starting ${week}`,
    message: approved
      ? `${decider} approved the ${territory} plan for the week starting ${week}.`
      : `${decider} returned the ${territory} plan for the week starting ${week} for changes.${notice.note ? ` Note: ${notice.note}` : ""}`,
    tab: "plan",
    recordId: notice.planId,
    idempotencyKey: `phoenix_crm:plan:${notice.planId}:v${notice.version}:${notice.status}`,
    subjectHrId: notice.repHrIds[0] ?? null,
  };
}

export async function notifyPhoenixCrm(notice: PhoenixCrmNotice, isTest: boolean): Promise<void> {
  if (isTest) return;
  try {
    const delivery = await describe(notice);
    if (!delivery) return;
    const actionUrl = `${PHOENIX_CRM_PORTAL_PATH}?tab=${delivery.tab}`;
    await createSystemNotificationForRecipients(
      {
        actionUrl,
        category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
        channels: ["in_app", "telegram"],
        eventType: delivery.eventType,
        message: delivery.message,
        metadata: { idempotencyKey: delivery.idempotencyKey, seatId: notice.seat.seatId },
        module: PHOENIX_CRM_NOTIFICATION_MODULE,
        priority: "normal",
        recordId: delivery.recordId,
        subjectHrId: delivery.subjectHrId,
        telegram: { ctaLabel: "Open Phoenix CRM", ctaUrl: actionUrl },
        title: delivery.title,
      },
      delivery.recipients,
    );
  } catch (error) {
    logError("Phoenix CRM notification failed", {
      labels: { event: "phoenix_crm_notify_failed", kind: notice.kind },
      error,
    });
  }
}
