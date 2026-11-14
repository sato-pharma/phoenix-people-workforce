/**
 * ONE WAY FOR A MODULE TO RAISE AN APPROVAL (enterprise audit REC-032, 14 Nov 2026).
 *
 * Every notice that says "a decision is waiting for you", "the request moved to the next step" or
 * "your request was approved / rejected / returned" goes through `raiseApproval`. Before this,
 * modules raised them three ways: the shared notification engine, the engine for in-app and
 * Telegram plus a separate durable email (leave), and a direct email (the direct-order final
 * approval, the marketing "approved requests" list). A new module copied whichever was nearest.
 *
 * 🔴 **"SAME NOTICES ONLY" (owner, 14 Nov 2026).** This door changes NOTHING about who is told or
 * how: every caller passes the recipients, channels, wording and email it passed before, and the
 * door hands them to the very same sender. What it adds is the one place every approval notice
 * passes through, and an `approval` stamp — `{ module, step, decision }` — on the engine notice's
 * metadata, so every approval notice is tagged the same way. The stamp is metadata only:
 * `notification_events.event_key` is hashed from the actor, type, module, title, link and recipient
 * (`eventKeyFor` in notifications/system.ts), never from metadata, so no notice merges or splits.
 * The gaps that exist today (expense claims tell no approver; probation and deduction decisions are
 * silent; Market Awareness reaches the requester only by email Cc) stay as they are — each is his
 * decision, one by one, not this door's.
 *
 * Who approves is decided by each module's own workflow, never here. Marketing keeps its own inbox.
 * Pinned by tests/approvals-one-door.test.ts.
 */

import type { SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import type { DurableEmailMessage } from "@/lib/notifications/direct-email-payload";
import { sendDurableEmail } from "@/lib/notifications/durable-email";
import {
  createSystemNotification,
  createSystemNotificationForRecipients,
  type CreateSystemNotificationInput,
  type SystemNotificationResult,
} from "@/lib/notifications/system";

/** The modules that raise approvals. Adding one here is how a new module joins the door. */
export const approvalModules = [
  "leave",
  "excuse",
  "weekly_plan",
  "phoenix_crm",
  "outstation",
  "direct_order",
  "marketing",
  "market_awareness",
  "resignation",
  "contract",
  "probation",
  "offer",
  "early_bird",
] as const;
export type ApprovalModule = (typeof approvalModules)[number];

/**
 * Where in its life the approval is.
 *  - `waiting`  — a decision is waiting for the recipient (a new request, or the next step's turn).
 *  - `decided`  — a step or the whole request was decided (see `decision`).
 *  - `returned` — sent back to the requester to change and resubmit.
 *  - `reminder` — a decision is still waiting, past its time.
 *  - `fyi`      — someone who does not decide is kept informed (HR, the chain, the execution roles).
 */
export const approvalSteps = ["waiting", "decided", "returned", "reminder", "fyi"] as const;
export type ApprovalStep = (typeof approvalSteps)[number];

export type ApprovalDecision = "approved" | "rejected" | "returned" | "acknowledged" | "cancelled";

export type ApprovalIdentity = {
  module: ApprovalModule;
  step: ApprovalStep;
  decision?: ApprovalDecision | null;
};

/**
 * How the notice is delivered — always the sender the module used before this door existed.
 *  - `notice`         — one engine notice (`createSystemNotification`).
 *  - `notices`        — one engine notice to a fixed list, one email envelope (`createSystemNotificationForRecipients`).
 *  - `durable-email`  — an approval email through the outbox, with Send again (`sendDurableEmail`).
 *  - `direct-email`   — an email the module builds and sends itself; the door runs it unchanged.
 */
/**
 * The identity of a notice whose module names its moment with a status or an event type (a contract
 * at `hr_review`, a plan's `plan_manager_approved`). It only TAGS the notice — delivery never reads
 * it. The order matters: `not_renewed` is a refusal although it contains `renewed`.
 */
export function approvalIdentity(module: ApprovalModule, signal: string | null | undefined): ApprovalIdentity {
  const s = String(signal ?? "").toLowerCase();
  if (/remind|sla|overdue|nudge|escalat/.test(s)) return { module, step: "reminder" };
  if (/reject|declin|not_renew|refus/.test(s)) return { decision: "rejected", module, step: "decided" };
  if (/cancel|withdr/.test(s)) return { decision: "cancelled", module, step: "decided" };
  if (/return|details_requested|changes_requested/.test(s)) return { decision: "returned", module, step: "returned" };
  if (/acknowledg/.test(s)) return { decision: "acknowledged", module, step: "decided" };
  if (/approved|approve$|renewed|complete|accepted|final/.test(s)) return { decision: "approved", module, step: "decided" };
  if (/submit|pending|waiting|request|created|assign|^new$|open|review|next|awaiting/.test(s)) return { module, step: "waiting" };
  return { module, step: "fyi" };
}

export type NoticeDelivery ={ via: "notice"; notice: CreateSystemNotificationInput };
export type NoticesDelivery = {
  via: "notices";
  notice: Omit<CreateSystemNotificationInput, "recipientHrId" | "recipientUserId">;
  recipientHrIds: Array<string | null | undefined>;
};
export type DurableEmailDelivery = { via: "durable-email"; message: DurableEmailMessage; dedupeKey: string };
export type DirectEmailDelivery<T> = { via: "direct-email"; send: () => Promise<T> };
export type ApprovalDelivery = NoticeDelivery | NoticesDelivery | DurableEmailDelivery | DirectEmailDelivery<unknown>;

function stamp<N extends { metadata?: Record<string, unknown> }>(notice: N, approval: ApprovalIdentity): N {
  return {
    ...notice,
    metadata: {
      ...(notice.metadata ?? {}),
      approval: { decision: approval.decision ?? null, module: approval.module, step: approval.step },
    },
  };
}

/** The one door. See the header: it delivers exactly what the caller hands it, tagged. */
export function raiseApproval(approval: ApprovalIdentity, delivery: NoticeDelivery): Promise<SystemNotificationResult>;
export function raiseApproval(approval: ApprovalIdentity, delivery: NoticesDelivery): Promise<SystemNotificationResult>;
export function raiseApproval(approval: ApprovalIdentity, delivery: DurableEmailDelivery): Promise<SendPhoenixEmailResult>;
export function raiseApproval<T>(approval: ApprovalIdentity, delivery: DirectEmailDelivery<T>): Promise<T>;
export async function raiseApproval(approval: ApprovalIdentity, delivery: ApprovalDelivery): Promise<unknown> {
  switch (delivery.via) {
    case "notice":
      return createSystemNotification(stamp(delivery.notice, approval));
    case "notices":
      return createSystemNotificationForRecipients(stamp(delivery.notice, approval), delivery.recipientHrIds);
    case "durable-email":
      return sendDurableEmail(delivery.message, { dedupeKey: delivery.dedupeKey });
    case "direct-email":
      return delivery.send();
  }
}

/** The stamp, exported for the test that pins it as metadata only. */
export function approvalStampForTest<N extends { metadata?: Record<string, unknown> }>(notice: N, approval: ApprovalIdentity) {
  return stamp(notice, approval);
}
