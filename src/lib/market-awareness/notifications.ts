import { raiseApproval } from "@/lib/approvals/raise-approval";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import type { MarketAwarenessApproverSlot } from "@/lib/market-awareness/approvers";
import type { MarketAwarenessActivity, MarketAwarenessDecision } from "@/lib/market-awareness/types";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Who is told what, and when.
 *
 * THE CONVERSATION IS NOT BUILT HERE. Any comment thread on an activity goes through
 * `src/lib/conversations/notify.ts`, which is the owner's own 2026-09-03 rule — email to the
 * submitter, CC the sender and every participant, in-app and Telegram to everyone except the author.
 * Re-implementing that addressing would make it two rules within a year.
 *
 * WHAT THIS MODULE ADDS is the one-off announcement on CEO approval: the National Sales Manager,
 * the SFE Manager and Finance, for execution. In-app, Telegram and email (owner answer 42).
 *
 * TWO AUDIENCES WERE REMOVED ON 2026-09-12, both at the owner's instruction and both for the same
 * reason. Every district manager in the region was told, and so was the area's own Medical Rep;
 * neither holds a `market_awareness` grant any more, so the announcement would have handed each of
 * them a link to a page that refuses them. A notification is a door: closing the sidebar link while
 * this one still fired would have left the door standing.
 *
 * EVERY NOTICE COPIES THE WHOLE WORKFLOW (owner rule, 2026-09-28). The email goes TO whoever must
 * act and CCs the requester, his manager and every approver on the activity — see
 * `resolveWorkflowCcHrIds`. The BCC half of that rule was the standing admin BCC
 * `send-phoenix-email.ts` put on every automated email; the owner stopped it on 2026-11-06 ("Stop
 * the BCC copies"), and his copy is now the Telegram mirror every email carries. Do not add one here.
 *
 * TELEGRAM WAS DEAD HERE UNTIL 2026-09-28 and nothing said so. All four notifiers below pass a
 * `telegram` block, and `market_awareness` was listed in NEITHER `notifications/policy.ts` NOR
 * `notifications/telegram-governance.ts` — two gates that must agree, both defaulting to refuse.
 * Ten events on production produced nine in-app, eight email, nine push and zero Telegram, with
 * nothing failed and nothing logged. Adding a row to one file alone changes nothing; if either row
 * is ever removed, this module goes quiet on Telegram again in exactly the same silence.
 *
 * Best-effort by contract. The activity row is already committed by the time this runs, so a
 * delivery failure is logged and swallowed — never thrown back into the write path, where it would
 * roll back an approval the CEO actually made.
 */

export const MARKET_AWARENESS_NOTIFICATION_MODULE = "market_awareness";

/**
 * Everyone already on this activity's workflow, for the email's CC line.
 *
 * The owner's rule, 2026-09-28: the notice goes TO whoever must act, and everyone else on the
 * workflow is COPIED — one email with the chain visible on it, not a private note to one person.
 * (The BCC half of that rule was the standing admin BCC, which the owner stopped on 2026-11-06 —
 * his copy is the Telegram mirror every email carries; none is added here.)
 *
 * Before this, a CEO notice read `To: the CEO, Cc: (nobody)` — the requester could not tell his
 * request had reached the top, the manager who approved it could not tell it had moved on, and an
 * approver who had already answered had no copy of what he had signed off. That is not a delivery
 * failure, which is why nothing was ever logged: the mail went out, to a third of the room.
 *
 * PURE, and separate from the address lookup below, so the audience can be asserted without a
 * database — the same reason `resolveApprovalAudience` and `resolvePendingDecisionRecipients` are.
 *
 * `exclude` is the To line. Copying a man on his own notice is how a thread reads as two messages.
 *
 * TAKES ONLY THE FOUR FIELDS IT READS, not `Pick<MarketAwarenessActivity, …>` — the same shape
 * `resolvePendingDecisionRecipients` above already uses, and for the same reason. A whole activity
 * still satisfies it structurally, so the four callers are unchanged, while a test can state a
 * four-line fixture instead of casting one: a `Pick` of the activity drags in the full twelve-field
 * approver slot and the full decision row, and an `as` cast past that does not even compile
 * ("neither type sufficiently overlaps"). The alternative — `as unknown as` — would have silenced
 * the very mismatch a fixture exists to expose.
 */
export function resolveWorkflowCcHrIds(
  activity: {
    approvers?: Array<Pick<MarketAwarenessApproverSlot, "assignedHrId">> | null;
    decisions?: Array<Pick<MarketAwarenessDecision, "actorHrId">> | null;
    managerHrId: string | null;
    requesterHrId: string | null;
  },
  exclude: Array<string | null | undefined> = [],
): string[] {
  const excluded = new Set(
    exclude.map((hrId) => canonicalHrIdKey(hrId)).filter((key): key is string => Boolean(key)),
  );

  const candidates: Array<string | null | undefined> = [
    activity.requesterHrId,
    activity.managerHrId,
    ...(activity.approvers ?? []).map((slot) => slot.assignedHrId),
    ...(activity.decisions ?? []).map((decision) => decision.actorHrId),
  ];

  const seen = new Set<string>();
  const output: string[] = [];
  for (const hrId of candidates) {
    if (!hrId) continue;
    const key = canonicalHrIdKey(hrId);
    if (!key || seen.has(key) || excluded.has(key)) continue;
    seen.add(key);
    output.push(hrId);
  }
  return output;
}

/**
 * Work emails for the CC line, keyed by nothing — the caller only wants the addresses.
 *
 * `hrIdLookupKeys` on every id rather than one normalized form, because `employees.hr_id` is stored
 * in more than one casing here and an `.in()` on a single spelling silently returns fewer rows —
 * which on a CC line looks exactly like "that person has no email" rather than "we asked wrongly".
 *
 * `src/lib/conversations/notify.ts` has its own copy of this lookup. It is deliberately NOT shared:
 * that one is load-bearing for the owner's 2026-09-03 conversation-addressing rule and is working,
 * and folding the two together to save fifteen lines would put this change inside it for no gain.
 *
 * Returns an empty list on any error. A CC line that could not be resolved must never stop the
 * notification the person actually needs — the To line is resolved separately and is not affected.
 */
async function loadWorkflowCcAddresses(hrIds: string[]): Promise<string[]> {
  if (hrIds.length === 0) return [];
  const lookups = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
  if (lookups.length === 0) return [];

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id,work_email")
      .in("hr_id", lookups);
    if (error) throw error;

    const seen = new Set<string>();
    const addresses: string[] = [];
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; work_email?: string | null }>) {
      const address = pickDeliverableEmail(row.work_email);
      if (!address || seen.has(address)) continue;
      seen.add(address);
      addresses.push(address);
    }
    return addresses;
  } catch (error) {
    logError("Market Awareness workflow cc lookup failed", {
      labels: { event: "market_awareness_workflow_cc_lookup_failed" },
      error,
    });
    return [];
  }
}

/**
 * The CC line for one notice: the workflow minus whoever it is addressed to.
 *
 * Wrapped so all four notifiers ask the same question in one call and cannot drift into copying
 * different people — the exact failure mode `policy.ts` and `telegram-governance.ts` record for
 * two config values that must agree.
 */
async function workflowCcAddresses(
  activity: Parameters<typeof resolveWorkflowCcHrIds>[0],
  toHrIds: Array<string | null | undefined>,
): Promise<string[]> {
  return loadWorkflowCcAddresses(resolveWorkflowCcHrIds(activity, toHrIds));
}

function activityLabel(activity: MarketAwarenessActivity): string {
  const name = activity.title?.trim();
  return name ? `${activity.activityType.name} — ${name}` : activity.activityType.name;
}

function moneyLabel(activity: MarketAwarenessActivity): string {
  const amount = activity.approvedCost ?? activity.estimatedCost;
  // Human-readable, never a raw number with no currency. Cairo formatting, EGP.
  return `${amount.toLocaleString("en-EG", { maximumFractionDigits: 2 })} ${activity.currency}`;
}

export type ApprovalAudience = {
  /** Everyone who will actually be told, de-duplicated by canonical HR id. */
  recipientHrIds: string[];
};

/**
 * The informed set: whoever the caller resolves by role — the NSM, the SFE Manager and Finance.
 *
 * NOBODY ELSE, and two names that used to be here are the reason this comment is long.
 *
 * NO DISTRICT MANAGER. Every DM in the region used to be told — owner answer 32, deliberately wider
 * than the single DM of the area — and on 2026-09-12 the owner hid the module from district managers
 * altogether.
 *
 * NO MEDICAL REP either. The area's own rep was the first name on this list (owner answer 42) and
 * came off the same day, at the owner's instruction: "no hide from medical rep". He never held a
 * `market_awareness` grant at all, so the notice he was getting pointed at a page that redirected
 * him the moment he opened it — a door with nothing behind it, arriving by three channels.
 *
 * So the activity itself is no longer read here: every recipient now comes from the caller's role
 * lookup, and this function's whole job is to de-duplicate them by canonical HR id. It was async
 * while it still resolved the region's managers from the database; it reads nothing now, and a
 * function that returns a promise for no reason is a missing `await` waiting to happen. Left
 * exported and separate so the audience can be asserted without a database.
 *
 * `loadRegionManagers` is still the source of `activity.districtManagers` in the service — the
 * activity screen names the DMs of the region to the people who CAN see it. Naming a manager is not
 * notifying him, and the same holds for the rep named on the activity.
 */
export function resolveApprovalAudience(
  hrIds: Array<string | null | undefined> = [],
): ApprovalAudience {
  const seen = new Set<string>();
  const recipientHrIds: string[] = [];
  for (const hrId of hrIds) {
    if (!hrId) continue;
    const key = canonicalHrIdKey(hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recipientHrIds.push(hrId);
  }

  return { recipientHrIds };
}

/**
 * Who must be told that a step is waiting on them.
 *
 * Split out so it can be asserted without a database, the same reason `resolveConversationAudience`
 * is. It mirrors `canDecideStep` deliberately: the notification must never reach someone the
 * decision route would then refuse, and it must never miss somebody who can act.
 *
 * AT THE GROUP STEP IT IS EVERY MEMBER WHO HAS NOT YET ANSWERED — the whole point of the parallel
 * rewrite is that two or three people are asked at once, and telling only the first of them
 * reproduces the sequential chain the owner replaced. Whoever has already approved is left out: a
 * second notice for a decision he has made reads as his answer not having registered.
 *
 * At the CEO step the group is irrelevant, and the step is role-based, so the CEO seat holders are
 * the whole list.
 *
 * An empty result means the step has no holder. The caller reports the count rather than assuming
 * it landed.
 */
export function resolvePendingDecisionRecipients(input: {
  ceoHrIds: Array<string | null | undefined>;
  managerHrId: string | null;
  approvers?: Array<Pick<MarketAwarenessApproverSlot, "assignedHrId" | "decision">>;
  step: "group" | "manager" | "ceo";
}): string[] {
  const candidates =
    input.step === "ceo"
      ? input.ceoHrIds
      : input.step === "group"
        ? (input.approvers ?? [])
            .filter((slot) => slot.decision === null)
            .map((slot) => slot.assignedHrId)
        : [input.managerHrId];

  const seen = new Set<string>();
  const recipientHrIds: string[] = [];
  for (const hrId of candidates) {
    if (!hrId) continue;
    const key = canonicalHrIdKey(hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recipientHrIds.push(hrId);
  }
  return recipientHrIds;
}

/**
 * Fired on every hand-off: an activity has arrived at a step and somebody must act on it.
 *
 * THIS IS THE ONE THAT WAS MISSING. The module shipped with an approvals inbox and no way for
 * anyone to learn there was something in it — two real requests sat untouched on 2026-09-07,
 * submitted at 09:52 and 09:56 Cairo, because nothing told Rasha or the CEO they existed. A queue
 * nobody is sent to is a queue nobody reads.
 *
 * Addressed by SLOT at the group step and by ROLE at the CEO step, matching `canDecideStep`
 * exactly — the notification must never reach someone the decision route would then refuse, and it
 * must never miss somebody who can act. `recipientHrIds` empty means the step has no holder; the
 * caller reports the count rather than assuming it landed.
 *
 * `notificationKey` exists so a hand-off can be RE-SENT on purpose. Without it the event key is a
 * hash of the action url, event type, module, recipient and title — all identical on a second send
 * for the same activity and step — so the delivery claim reads "already sent" and the re-send is
 * skipped in silence, which looks exactly like a send that failed. The workflow never passes it:
 * every ordinary hand-off must stay deduplicated, because that dedupe is what stops a retried write
 * telling the CEO twice. Only a deliberate re-notify supplies one, and it carries a timestamp so
 * two refires minutes apart are two events. Owner instruction 2026-09-28.
 */
export async function notifyDecisionPending(input: {
  activity: MarketAwarenessActivity;
  actionUrl: string;
  /** The CEO seat holders, resolved by the caller from the role directory. Ignored at the group step. */
  ceoHrIds: Array<string | null | undefined>;
  step: "group" | "manager" | "ceo";
  /** Set ONLY by a deliberate re-notify. Absent for every workflow hand-off — see above. */
  notificationKey?: string;
}): Promise<{ notified: number }> {
  const { activity, step } = input;

  try {
    const recipientHrIds = resolvePendingDecisionRecipients({
      approvers: activity.approvers,
      ceoHrIds: input.ceoHrIds,
      managerHrId: activity.managerHrId,
      step,
    });
    if (recipientHrIds.length === 0) return { notified: 0 };

    const where = [activity.areaName ?? activity.areaCode, activity.regionName ?? activity.regionCode]
      .filter(Boolean)
      .join(", ");

    await raiseApproval({ module: "market_awareness", step: "waiting" }, { via: "notices", notice: {
        module: MARKET_AWARENESS_NOTIFICATION_MODULE,
        eventType: "market_awareness_decision_pending",
        category: "market_awareness",
        recordId: activity.id,
        actionUrl: input.actionUrl,
        title: `${activityLabel(activity)} is waiting for your decision`,
        message:
          `${activity.requesterName ?? activity.requesterHrId} submitted ${activityLabel(activity)} ` +
          `for ${where} on ${activity.primaryLine.name}, starting ${activity.startDate}. ` +
          `Requested value ${moneyLabel(activity)}.`,
        // The whole chain is copied, never just the person whose turn it is — owner rule
        // 2026-09-28. See `resolveWorkflowCcHrIds`.
        email: { cc: await workflowCcAddresses(activity, recipientHrIds) },
        metadata: {
          activityCode: activity.activityCode,
          areaCode: activity.areaCode,
          regionCode: activity.regionCode,
          step,
          ...(input.notificationKey ? { idempotencyKey: input.notificationKey } : {}),
        },
        telegram: { ctaLabel: "Open the approvals inbox", ctaUrl: input.actionUrl },
      }, recipientHrIds: recipientHrIds });

    return { notified: recipientHrIds.length };
  } catch (error) {
    // Swallowed: the submission is already committed, and an undelivered notification must never
    // undo it. It is logged so a silent queue is visible in the error monitor rather than inferred
    // from nobody acting — which is exactly how this gap went unnoticed.
    logError("Market Awareness pending-decision notification failed", {
      labels: {
        event: "market_awareness_pending_notify_failed",
        activity_id: activity.id,
        activity_code: activity.activityCode,
        step,
      },
      error,
    });
    return { notified: 0 };
  }
}

/**
 * Fired when a decider sends it back or refuses it — the requester is the only recipient.
 *
 * Returned and rejected are one notification with different words, not two paths: both mean the
 * request stopped moving and only the person who raised it can act next. The decider's comment is
 * carried IN FULL, never trimmed to a preview — the owner's standing rule, and a half-sentence is
 * what forces someone back into the app to find out what was actually asked of them.
 */
export async function notifyActivityReturned(input: {
  activity: MarketAwarenessActivity;
  actionUrl: string;
  comment: string | null;
  deciderName: string | null;
  rejected: boolean;
}): Promise<{ notified: number }> {
  const { activity } = input;

  try {
    if (!activity.requesterHrId) return { notified: 0 };

    const decider = input.deciderName?.trim() || "Your reviewer";
    const verb = input.rejected ? "was not approved" : "was sent back for changes";
    const note = input.comment?.trim();

    await raiseApproval((input.rejected ? { decision: "rejected", module: "market_awareness", step: "decided" } : { decision: "returned", module: "market_awareness", step: "returned" }), { via: "notices", notice: {
        module: MARKET_AWARENESS_NOTIFICATION_MODULE,
        eventType: input.rejected
          ? "market_awareness_activity_rejected"
          : "market_awareness_activity_returned",
        category: "market_awareness",
        recordId: activity.id,
        actionUrl: input.actionUrl,
        title: `${activityLabel(activity)} ${verb}`,
        message:
          `${decider} ${input.rejected ? "did not approve" : "sent back"} ${activityLabel(activity)}` +
          (note ? `: "${note}"` : "."),
        email: { cc: await workflowCcAddresses(activity, [activity.requesterHrId]) },
        metadata: {
          activityCode: activity.activityCode,
          rejected: input.rejected,
        },
        telegram: { ctaLabel: "Open the activity", ctaUrl: input.actionUrl },
      }, recipientHrIds: [activity.requesterHrId] });

    return { notified: 1 };
  } catch (error) {
    logError("Market Awareness return notification failed", {
      labels: {
        event: "market_awareness_return_notify_failed",
        activity_id: activity.id,
        activity_code: activity.activityCode,
      },
      error,
    });
    return { notified: 0 };
  }
}

/**
 * Fired when a member of the group freezes the request — the requester is the only recipient.
 *
 * A HOLD IS NOT A RETURN AND MUST NOT READ LIKE ONE. Nothing is being asked of the requester and
 * there is nothing for him to edit; the request is simply parked, and it will move again when the
 * person who parked it says so. Without this he watches it stop with no reason given anywhere —
 * the same failure a return with no comment produces, which is why the reason is required at the
 * constraint, at the function and here.
 *
 * The other approvers are deliberately NOT told. They cannot act on a frozen request, and a notice
 * about something they are not being asked to do is the noise that makes people stop reading them.
 */
export async function notifyActivityHeld(input: {
  activity: MarketAwarenessActivity;
  actionUrl: string;
  holderName: string | null;
  reason: string | null;
}): Promise<{ notified: number }> {
  const { activity } = input;

  try {
    if (!activity.requesterHrId) return { notified: 0 };

    const holder = input.holderName?.trim() || "One of your approvers";
    const reason = input.reason?.trim();

    await raiseApproval({ module: "market_awareness", step: "fyi" }, { via: "notices", notice: {
        module: MARKET_AWARENESS_NOTIFICATION_MODULE,
        eventType: "market_awareness_activity_held",
        category: "market_awareness",
        recordId: activity.id,
        actionUrl: input.actionUrl,
        title: `${activityLabel(activity)} is on hold`,
        message:
          `${holder} put ${activityLabel(activity)} on hold` +
          (reason ? `: "${reason}".` : ".") +
          " Nothing is needed from you — it will move again when the hold is lifted.",
        email: { cc: await workflowCcAddresses(activity, [activity.requesterHrId]) },
        metadata: {
          activityCode: activity.activityCode,
          heldBy: activity.heldByHrId,
        },
        telegram: { ctaLabel: "Open the activity", ctaUrl: input.actionUrl },
      }, recipientHrIds: [activity.requesterHrId] });

    return { notified: 1 };
  } catch (error) {
    logError("Market Awareness hold notification failed", {
      labels: {
        event: "market_awareness_hold_notify_failed",
        activity_id: activity.id,
        activity_code: activity.activityCode,
      },
      error,
    });
    return { notified: 0 };
  }
}

/**
 * Fired once, when the CEO approves. Recipients can comment on the activity but never approve it —
 * their matrix grant is `read` only, so this notification cannot become an authority they lack.
 *
 * Neither district managers nor the area's Medical Rep are recipients since 2026-09-12 — see
 * `resolveApprovalAudience` for why.
 */
export async function notifyActivityApproved(input: {
  activity: MarketAwarenessActivity;
  /** NSM, SFE Manager and Finance HR ids, resolved by the caller from the role directory. */
  roleRecipientHrIds: Array<string | null | undefined>;
  actionUrl: string;
}): Promise<{ notified: number }> {
  const { activity } = input;

  try {
    const audience = resolveApprovalAudience(input.roleRecipientHrIds);
    if (audience.recipientHrIds.length === 0) {
      return { notified: 0 };
    }

    const where = [activity.areaName ?? activity.areaCode, activity.regionName ?? activity.regionCode]
      .filter(Boolean)
      .join(", ");

    await raiseApproval({ decision: "approved", module: "market_awareness", step: "decided" }, { via: "notices", notice: {
        module: MARKET_AWARENESS_NOTIFICATION_MODULE,
        eventType: "market_awareness_activity_approved",
        category: "market_awareness",
        recordId: activity.id,
        actionUrl: input.actionUrl,
        title: `${activityLabel(activity)} approved in ${where}`,
        message:
          `${activity.requesterName ?? activity.requesterHrId} had ${activityLabel(activity)} approved ` +
          `for ${where} on ${activity.primaryLine.name}, starting ${activity.startDate}. ` +
          `Approved value ${moneyLabel(activity)}.`,
        // The approval announcement goes TO the three execution roles; the requester, his manager
        // and every approver who signed it off are copied, so the people who moved it learn it
        // landed. Until now none of them was told at all once the CEO pressed approve.
        email: { cc: await workflowCcAddresses(activity, audience.recipientHrIds) },
        metadata: {
          activityCode: activity.activityCode,
          areaCode: activity.areaCode,
          regionCode: activity.regionCode,
          line: activity.primaryLine.name,
          startDate: activity.startDate,
        },
        telegram: { ctaLabel: "Open the activity", ctaUrl: input.actionUrl },
      }, recipientHrIds: audience.recipientHrIds });

    return { notified: audience.recipientHrIds.length };
  } catch (error) {
    // Swallowed on purpose: the approval is already committed, and an undelivered notification must
    // never undo a decision the CEO made.
    logError("Market Awareness approval notification failed", {
      labels: {
        event: "market_awareness_approval_notify_failed",
        activity_id: activity.id,
        activity_code: activity.activityCode,
      },
      error,
    });
    return { notified: 0 };
  }
}
