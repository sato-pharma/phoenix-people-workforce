import { resolveDisputeReviewerHrIds } from "@/lib/attendance/digest-service.ts";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { resolveSuperAdminRecipients } from "@/lib/private-calendar/notify-admin";
import { canonicalHrIdKey } from "@/lib/hr-id";

import type { DisputeCaseKind } from "./types.ts";

// Who is told what, when a Dispute Center case moves — a reopen asked for, a reopen granted or
// declined, a deduction decided, a weekly-review dispute filed. In-app and push only: these are
// prompts to open the case, which carries the whole conversation. Each module's own long-standing
// notices (a calendar decision, a weekly-review decision, a reply) keep their own channels.
//
// Best-effort everywhere: the change is already saved when this runs, and a notice that cannot be
// delivered must never make the person who acted think it was not saved.

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
}): Promise<void> {
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
