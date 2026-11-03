/**
 * The morning run of approval reminders. Rules: `./urgent-whatsapp-rules.ts`. Ledger: `./urgent-whatsapp-log.ts`.
 *
 * 🔴 OFF UNTIL HE SAYS, BY THREE LOCKS THAT NEED NO MERGE: the switch on the recipients screen, the third number being
 * set up, and Meta having approved the message. Production-only sits beside them. The job still runs and reports while
 * any of them holds, like the WhatsApp re-ask, so its heartbeat stays a straight one. `dryRun` reads and counts, passes
 * no lock, writes nothing and sends nothing.
 *
 * 🔴 NO TEST SEND IS EVER FIRED. The send is injected so the tests never reach Meta.
 */

import { isProductionRuntime } from "@/config/system-settings";
import { resolveNotificationRoleEnabled } from "@/lib/notifications/role-recipients";
import { logInfo, logWarning } from "@/lib/observability/log";
import { sendWhatsAppPayload, type WhatsAppSendResult } from "@/lib/recruitment/inbound/whatsapp-interactive";
import { buildTemplateMessage, readTemplateStatus, type InboxTemplate, type TemplateApprovalStatus } from "@/lib/whatsapp-inbox/graph";
import { whatsAppApprovalsLine } from "@/lib/whatsapp-inbox/lines";

import { claimApprovalReminder, finishApprovalReminder, readClaimedHrIds, type ApprovalReminderClaim, type ApprovalReminderOutcome } from "./urgent-whatsapp-log";
import {
  APPROVAL_REMINDER_CAP_PER_RUN,
  APPROVAL_REMINDER_EVENT,
  APPROVAL_REMINDER_SWITCH,
  APPROVAL_REMINDER_TEMPLATE_BODY,
  APPROVAL_REMINDER_TEMPLATE_LANGUAGE,
  APPROVAL_REMINDER_TEMPLATE_NAME,
  cairoReminderDay,
  reminderLockReason,
  reminderTemplateRefusal,
  reminderTimeRefusal,
  type ApprovalCounts,
  type ApproverTally,
} from "./urgent-whatsapp-rules";
import { readApproverTally } from "./waiting-by-approver";

const TEMPLATE: InboxTemplate = {
  bodyFields: [{ example: "3", key: "body:count", label: "Approvals waiting", name: "count" }],
  bodyText: APPROVAL_REMINDER_TEMPLATE_BODY,
  category: "UTILITY",
  footerText: null,
  headerFields: [],
  headerText: null,
  language: APPROVAL_REMINDER_TEMPLATE_LANGUAGE,
  name: APPROVAL_REMINDER_TEMPLATE_NAME,
  parameterFormat: "named",
  unsupportedReason: null,
};

/** The Cloud API message for one reminder. Exported so a test can pin it against the words submitted to Meta. */
export function approvalReminderMessage(total: number): Record<string, unknown> & { type: string } {
  return buildTemplateMessage(TEMPLATE, { "body:count": String(total) }) as Record<string, unknown> & { type: string };
}

export type ApprovalReminderLine = { phoneNumberId: string; businessAccountId: string };

export type ApprovalReminderDeps = {
  now: () => Date;
  production: () => boolean;
  switchOn: () => Promise<boolean>;
  line: () => ApprovalReminderLine | null;
  templateStatus: (line: ApprovalReminderLine) => Promise<TemplateApprovalStatus>;
  tally: (now: Date) => Promise<ApproverTally>;
  claimedToday: (cairoDay: string) => Promise<Set<string>>;
  claim: (claim: ApprovalReminderClaim) => Promise<boolean>;
  finish: (hrId: string, cairoDay: string, outcome: ApprovalReminderOutcome) => Promise<void>;
  send: (input: { toWaId: string; phoneNumberId: string; total: number }) => Promise<WhatsAppSendResult>;
};

const realDeps: ApprovalReminderDeps = {
  claim: claimApprovalReminder,
  claimedToday: readClaimedHrIds,
  finish: finishApprovalReminder,
  line: whatsAppApprovalsLine,
  now: () => new Date(),
  production: isProductionRuntime,
  send: ({ phoneNumberId, toWaId, total }) =>
    sendWhatsAppPayload({ event: APPROVAL_REMINDER_EVENT, message: approvalReminderMessage(total), phoneNumberId, toWaId }),
  switchOn: () => resolveNotificationRoleEnabled(APPROVAL_REMINDER_SWITCH),
  tally: readApproverTally,
  templateStatus: (line) => readTemplateStatus(line.businessAccountId, APPROVAL_REMINDER_TEMPLATE_NAME, APPROVAL_REMINDER_TEMPLATE_LANGUAGE),
};

export type ApprovalReminderRunResult = {
  outcome: "dry_run" | "off" | "ran";
  /** Why nothing went out, as a sentence a person reads. */
  because: string | null;
  cairoDay: string;
  approversDue: number;
  byChain: ApprovalCounts;
  accepted: number;
  failed: number;
  noNumber: number;
  alreadyToday: number;
  /** Past this tick's cap, for the next tick. */
  leftForNextTick: number;
  unaddressed: number;
  notYetDue: number;
};

function emptyResult(outcome: ApprovalReminderRunResult["outcome"], because: string | null, cairoDay: string): ApprovalReminderRunResult {
  return {
    accepted: 0,
    alreadyToday: 0,
    approversDue: 0,
    because,
    byChain: { direct_order: 0, excuse: 0, leave: 0, marketing: 0 },
    cairoDay,
    failed: 0,
    leftForNextTick: 0,
    noNumber: 0,
    notYetDue: 0,
    outcome,
    unaddressed: 0,
  };
}

function summarize(tally: ApproverTally, outcome: ApprovalReminderRunResult["outcome"], cairoDay: string): ApprovalReminderRunResult {
  const byChain: ApprovalCounts = { direct_order: 0, excuse: 0, leave: 0, marketing: 0 };
  for (const person of tally.due) {
    for (const chain of Object.keys(byChain) as Array<keyof ApprovalCounts>) byChain[chain] += person.counts[chain];
  }
  return { ...emptyResult(outcome, null, cairoDay), approversDue: tally.due.length, byChain, notYetDue: tally.notYetDue, unaddressed: tally.unaddressed };
}

/** Every send refused is a broken number or template, not a quiet morning, so the job must go red and say so. */
export function assertRemindersReachedSomeone(result: Pick<ApprovalReminderRunResult, "accepted" | "failed">): void {
  if (result.accepted === 0 && result.failed > 0) {
    throw new Error(`All ${result.failed} approval reminders in this run were refused.`);
  }
}

async function sendTheMorningRun(deps: ApprovalReminderDeps, line: ApprovalReminderLine, now: Date, cairoDay: string): Promise<ApprovalReminderRunResult> {
  const tally = await deps.tally(now);
  const result = summarize(tally, "ran", cairoDay);
  const claimed = await deps.claimedToday(cairoDay);

  for (const person of tally.due) {
    if (claimed.has(person.hrId)) {
      result.alreadyToday += 1;
      continue;
    }
    const base = { cairoDay, counts: person.counts, hrId: person.hrId, phoneNumberId: line.phoneNumberId, toWaId: person.waId, total: person.total };
    if (!person.waId) {
      if (await deps.claim({ ...base, status: "no_number" })) result.noNumber += 1;
      else result.alreadyToday += 1;
      continue;
    }
    if (result.accepted + result.failed >= APPROVAL_REMINDER_CAP_PER_RUN) {
      result.leftForNextTick += 1;
      continue;
    }
    if (!(await deps.claim({ ...base, status: "claimed" }))) {
      result.alreadyToday += 1;
      continue;
    }
    const sent = await deps.send({ phoneNumberId: line.phoneNumberId, toWaId: person.waId, total: person.total });
    if (sent.ok) {
      result.accepted += 1;
      await deps.finish(person.hrId, cairoDay, { failureReason: null, status: "accepted", wamid: sent.wamid });
    } else {
      result.failed += 1;
      const failureReason = [sent.reason, sent.detail].filter(Boolean).join(": ").slice(0, 300);
      await deps.finish(person.hrId, cairoDay, { failureReason, status: "failed", wamid: null });
      logWarning("An approval reminder was refused", { labels: { event: "approval_whatsapp_refused", reason: sent.reason } });
    }
  }

  logInfo("Approval reminders ran", {
    context: { accepted: result.accepted, due: result.approversDue, failed: result.failed, left: result.leftForNextTick, noNumber: result.noNumber, unaddressed: result.unaddressed },
    labels: { event: "approval_whatsapp_run" },
  });
  assertRemindersReachedSomeone(result);
  return result;
}

export async function runApprovalWhatsAppReminders(
  options: { dryRun?: boolean; deps?: Partial<ApprovalReminderDeps> } = {},
): Promise<ApprovalReminderRunResult> {
  const deps: ApprovalReminderDeps = { ...realDeps, ...options.deps };
  const now = deps.now();
  const cairoDay = cairoReminderDay(now);

  if (options.dryRun) {
    const tally = await deps.tally(now);
    return { ...summarize(tally, "dry_run", cairoDay), noNumber: tally.due.filter((person) => !person.waId).length };
  }

  const line = deps.line();
  const locked = reminderLockReason({ lineConfigured: Boolean(line), production: deps.production(), switchOn: await deps.switchOn() }) ?? reminderTimeRefusal(now);
  if (locked || !line) return emptyResult("off", locked ?? "The third WhatsApp number is not set up.", cairoDay);
  const refused = reminderTemplateRefusal(await deps.templateStatus(line));
  if (refused) return emptyResult("off", refused, cairoDay);
  return sendTheMorningRun(deps, line, now, cairoDay);
}
