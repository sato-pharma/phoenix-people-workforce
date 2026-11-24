import { resolveDisputeReviewerHrIds } from "@/lib/attendance/digest-service.ts";
import { loadWorkEmails } from "@/lib/conversations/notify";
import { resolveDisputeAudience, type ResolvedDisputePerson } from "@/lib/deductions/dispute-audience.ts";
import {
  createSystemNotification,
  createSystemNotificationForRecipients,
  type CreateSystemNotificationInput,
  type SystemNotificationChannel,
} from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { resolveSuperAdminRecipients } from "@/lib/private-calendar/notify-admin";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";

import type { DisputeCaseKind } from "./types.ts";

// Who is told what, when a Dispute Center case moves — a reopen asked for, a reopen granted or
// declined, a deduction decided, a weekly-review dispute filed. In-app and push only: these are
// prompts to open the case, which carries the whole conversation. Each module's own long-standing
// notices (a calendar decision, a weekly-review decision, a reply) keep their own channels.
//
// Best-effort everywhere: the change is already saved when this runs, and a notice that cannot be
// delivered must never make the person who acted think it was not saved.
//
// A DECIDED DEDUCTION DISPUTE IS THE EXCEPTION TO "IN-APP AND PUSH ONLY" (owner, 2026-11-24: "the
// email and a telegram to be sent to them, CC their manager and their national sales manager"). He
// accepted two deduction disputes and neither employee's phone showed anything: the notice reached
// the bell alone, because both push subscriptions had lapsed and the decision asked for no email and
// no Telegram. A decision that carries `copyManagers` now goes to the employee by email, Telegram,
// push and in-app, with the managers on the email's cc line; each manager also gets the heads-up
// in-app and on Telegram. The managers are the deduction-dispute audience's own chain
// (DISPUTE_REPLY_MANAGER_LEVELS: the direct manager and the one above; for a rep that is the
// District Sales Manager and the National Sales Manager), so a reply and a decision copy the same
// people. Pinned by tests/dispute-decision-copies-managers.test.ts.

/** Owner, 2026-11-24: what a decided deduction dispute reaches the employee on. */
export const DECISION_EMPLOYEE_CHANNELS: readonly SystemNotificationChannel[] = ["in_app", "email", "telegram", "push"];
/** What each copied manager gets beside the email's cc line. No email of their own: the cc is it. */
export const DECISION_MANAGER_CHANNELS: readonly SystemNotificationChannel[] = ["in_app", "telegram"];

/** The managers' copy of a decision, in their own words, since the employee's say "your". */
export type DisputeManagerCopy = {
  title: (employeeName: string) => string;
  message: (employeeName: string) => string;
};

const MODULE_BY_KIND: Record<DisputeCaseKind, string> = {
  calendar: "private_calendar",
  deduction: "deductions",
  digest: "attendance_digest",
  daily: "deductions",
};

/** Where each side opens a case. */
export function disputeCaseHref(kind: DisputeCaseKind, ref: string, side: "employee" | "reviewer"): string {
  const query = `kind=${encodeURIComponent(kind)}&case=${encodeURIComponent(ref)}`;
  return side === "reviewer" ? `/admin/disputes?${query}` : `/employee-portals/disputes?${query}`;
}

/**
 * The people who answer a kind of dispute. A weekly-review dispute's reviewers come from the review's
 * own settings (never the employee whose week it is); the other two kinds are every active Super
 * Admin.
 */
export async function reviewerHrIdsFor(kind: DisputeCaseKind, ownerHrId: string | null): Promise<string[]> {
  // A weekly-review dispute has its own named reviewers beside the Super Admins; the other two kinds
  // are the Super Admin's alone (the calendar by the owner's rule, a deduction decision by the
  // module's own gate).
  if (kind === "digest") return resolveDisputeReviewerHrIds(ownerHrId ?? "");
  const admins = await resolveSuperAdminRecipients().catch(() => []);
  const seen = new Set<string>();
  return admins
    .map((admin) => admin.hrId)
    .filter((hrId) => {
      const key = canonicalHrIdKey(hrId);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function notifyDisputeCase(input: {
  kind: DisputeCaseKind;
  ref: string;
  audience: "employee" | "reviewer";
  recipientHrIds: Array<string | null | undefined>;
  /** Who acted — never notified of their own action. */
  actorHrId: string | null;
  employeeHrId: string;
  title: string;
  message: string;
  /** Unique per occurrence, so a second reopen of the same case is its own notice. */
  eventKey: string;
  /**
   * A decision told to the employee by email and Telegram too, CC their manager and the one above
   * (owner, 2026-11-24). Only with audience "employee".
   */
  copyManagers?: DisputeManagerCopy;
}): Promise<void> {
  if (input.copyManagers && input.audience === "employee") {
    await notifyDecisionWithManagers({ ...input, copyManagers: input.copyManagers });
    return;
  }
  const actorKey = canonicalHrIdKey(input.actorHrId);
  const recipients = input.recipientHrIds.filter(
    (id): id is string => Boolean(id) && (input.audience === "employee" || canonicalHrIdKey(id) !== actorKey),
  );
  if (recipients.length === 0) return;
  try {
    await createSystemNotificationForRecipients(
      {
        actionUrl: disputeCaseHref(input.kind, input.ref, input.audience),
        actorId: input.actorHrId,
        channels: ["in_app", "push"],
        eventType: `dispute_center_${input.eventKey.split(":")[0]}`,
        message: input.message,
        metadata: {
          // A reviewer is not the data subject; the server addresses them on purpose (the deductions
          // module refuses a non-subject explicit recipient otherwise).
          authorizedRecipient: input.audience === "reviewer",
          caseKind: input.kind,
          caseRef: input.ref,
          employeeHrId: input.employeeHrId,
          idempotencyKey: `dispute-center:${input.kind}:${input.ref}:${input.eventKey}`,
        },
        module: MODULE_BY_KIND[input.kind],
        priority: "normal",
        recordId: input.ref,
        subjectHrId: input.employeeHrId,
        title: input.title,
      },
      recipients,
    );
  } catch (error) {
    logError("Dispute Center notice failed", {
      error,
      labels: { caseKind: input.kind, caseRef: input.ref, event: "dispute_center_notify_failed" },
    });
  }
}

type DecisionNoticeInput = Parameters<typeof notifyDisputeCase>[0] & { copyManagers: DisputeManagerCopy };

/**
 * The sends a decided dispute makes when it copies the managers, built apart from the delivery so a
 * test can read exactly who is addressed on which channel. ONE email, To the employee and cc every
 * manager, and one Telegram and in-app heads-up per manager. A manager is a non-subject recipient of
 * a deductions-module notice, which the engine refuses without `authorizedRecipient`; the owner
 * named them, so the sender vouches for them.
 */
export function buildDisputeDecisionSends(input: {
  notice: DecisionNoticeInput;
  employee: ResolvedDisputePerson | null;
  managers: ResolvedDisputePerson[];
  /** Work emails keyed by canonical HR id. */
  emails: Map<string, string>;
}): CreateSystemNotificationInput[] {
  const { notice } = input;
  const employeeHrId = notice.employeeHrId;
  const employeeName = input.employee?.name ?? "A team member";
  const emailOf = (hrId: string) => {
    const key = canonicalHrIdKey(hrId);
    return key ? input.emails.get(key) ?? null : null;
  };
  const employeeKey = canonicalHrIdKey(employeeHrId);
  const managers = input.managers.filter((manager) => canonicalHrIdKey(manager.hrId) !== employeeKey);
  const employeeEmail = emailOf(employeeHrId);
  const ccEmails = Array.from(
    new Set(managers.map((manager) => emailOf(manager.hrId)).filter((email): email is string => Boolean(email))),
  ).filter((email) => email !== employeeEmail);
  const ccHrIds = managers.map((manager) => manager.hrId);
  const idempotencyBase = `dispute-center:${notice.kind}:${notice.ref}:${notice.eventKey}`;

  const toEmployee: CreateSystemNotificationInput = {
    actionUrl: disputeCaseHref(notice.kind, notice.ref, "employee"),
    actorId: notice.actorHrId,
    channels: [...DECISION_EMPLOYEE_CHANNELS],
    // The cc rides on the employee's own envelope: one email with everyone visible on it. With no
    // work email on record the engine resolves the address itself, so the cc still has a To.
    email: {
      cc: ccEmails,
      ...(employeeEmail ? { recipients: [employeeEmail] } : {}),
      subject: notice.title,
      summary: notice.message,
      templateKey: "general",
      title: notice.title,
    },
    eventType: `dispute_center_${notice.eventKey.split(":")[0]}`,
    message: notice.message,
    metadata: {
      caseKind: notice.kind,
      caseRef: notice.ref,
      ccHrIds,
      employeeHrId,
      idempotencyKey: idempotencyBase,
    },
    module: MODULE_BY_KIND[notice.kind],
    priority: "high",
    recipientHrId: hrIdForStorage(employeeHrId),
    recordId: notice.ref,
    subjectHrId: employeeHrId,
    title: notice.title,
  };

  const toManagers = managers.map((manager): CreateSystemNotificationInput => ({
    // No link: the case lives on the employee's own self-only portal page, which a manager cannot open.
    actionUrl: null,
    actorId: notice.actorHrId,
    channels: [...DECISION_MANAGER_CHANNELS],
    eventType: `dispute_center_${notice.eventKey.split(":")[0]}`,
    message: notice.copyManagers.message(employeeName),
    metadata: {
      authorizedRecipient: true,
      caseKind: notice.kind,
      caseRef: notice.ref,
      employeeHrId,
      idempotencyKey: `${idempotencyBase}:${canonicalHrIdKey(manager.hrId) ?? manager.hrId}`,
      managerCopy: true,
    },
    module: MODULE_BY_KIND[notice.kind],
    priority: "normal",
    recipientHrId: hrIdForStorage(manager.hrId),
    recordId: notice.ref,
    subjectHrId: employeeHrId,
    title: notice.copyManagers.title(employeeName),
  }));

  return [toEmployee, ...toManagers];
}

async function notifyDecisionWithManagers(notice: DecisionNoticeInput): Promise<void> {
  try {
    const audience = await resolveDisputeAudience(notice.employeeHrId);
    const emails = await loadWorkEmails([notice.employeeHrId, ...audience.managers.map((manager) => manager.hrId)]);
    const [toEmployee, ...toManagers] = buildDisputeDecisionSends({
      emails,
      employee: audience.employee,
      managers: audience.managers,
      notice,
    });
    // The employee first: a manager's copy must never be the only one that went.
    await createSystemNotification(toEmployee);
    await Promise.all(
      toManagers.map((send) =>
        createSystemNotification(send).catch((error) =>
          logError("Dispute Center manager copy failed", {
            error,
            labels: { caseKind: notice.kind, caseRef: notice.ref, event: "dispute_center_manager_copy_failed" },
          }),
        ),
      ),
    );
  } catch (error) {
    logError("Dispute Center notice failed", {
      error,
      labels: { caseKind: notice.kind, caseRef: notice.ref, event: "dispute_center_notify_failed" },
    });
  }
}
