/**
 * Phoenix CRM — the conversation on a manager's weekly plan (owner, 2026-11-01: "an option to open conversation
 * and people in approval window visible to it"). The thread lives in the one record-conversation table, keyed by
 * the plan; who may read and write it is whoever opens that week in the Approvals Hub (`mayOpenManagerRecord`),
 * so the two can never disagree. 🔴 NEVER A REP, and never email: every message goes in-app, by Telegram and to the
 * phone, as every Phoenix CRM notice does, through the shared notice sender rather than `conversations/notify.ts`,
 * which mails the thread.
 */

import { insertRecordConversationComment, listRecordConversation, listRecordConversationAuthors, RECORD_CONVERSATION_MAX_LENGTH, type RecordConversationComment } from "@/lib/conversations/comments";
import { conflictError, notFoundError, validationError } from "@/lib/http/api-errors";
import { isManagerAskLive, managerPlanConversationAudience, managerPlanConversationOpen } from "@/lib/phoenix-crm/manager-plan-rules";
import { testModeFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { textOrNull } from "@/lib/phoenix-crm/server/db";
import { mayOpenManagerRecord } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { loadEditAsks, loadManagerPlanRow, type ManagerEditAskRow, type ManagerPlanRow } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { tellManagerPlan } from "@/lib/phoenix-crm/server/manager-plans";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";

const MODULE = "manager_plans";

type ConversationRequest = { plan: unknown; test: unknown };

/** The week, once the viewer may open it. Not found for a week he may not: never a hint that it exists. */
async function openConversationWeek(viewer: PhoenixCrmViewer, request: ConversationRequest): Promise<{ plan: ManagerPlanRow; asks: ManagerEditAskRow[]; isTest: boolean }> {
  const planId = textOrNull(request.plan);
  const isTest = testModeFor(viewer, request.test);
  const plan = planId && /^[0-9a-f-]{36}$/i.test(planId) ? await loadManagerPlanRow(planId, isTest) : null;
  if (!plan) throw notFoundError("This plan could not be found, or you do not have access to it.");
  const asks = await loadEditAsks([plan.planId]);
  const approvers = [plan.firstApproverHrId, plan.secondApproverHrId, ...asks.flatMap((ask) => [ask.approverHrId, ask.secondApproverHrId])];
  if (!mayOpenManagerRecord(viewer, plan.managerHrId, approvers)) throw notFoundError("This plan could not be found, or you do not have access to it.");
  return { plan, asks, isTest };
}

/** GET: every message on the week, oldest first. */
export async function listManagerPlanConversation(viewer: PhoenixCrmViewer, request: ConversationRequest): Promise<{ comments: RecordConversationComment[]; schemaReady: boolean }> {
  const { plan } = await openConversationWeek(viewer, request);
  return listRecordConversation(MODULE, plan.planId);
}

/** POST: one message on the week, then a notice to everyone on its approval and everyone who has written. */
export async function postManagerPlanConversation(viewer: PhoenixCrmViewer, raw: ConversationRequest & { body: unknown }): Promise<RecordConversationComment> {
  const { plan, asks, isTest } = await openConversationWeek(viewer, raw);
  if (!managerPlanConversationOpen(plan)) throw conflictError("This week has not been sent yet, so its conversation is not open.");
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body) throw validationError("Write a message first.");
  if (body.length > RECORD_CONVERSATION_MAX_LENGTH) throw validationError(`Keep the message under ${RECORD_CONVERSATION_MAX_LENGTH} characters.`);

  const names = await loadPeopleNames([viewer.hrId]);
  const comment = await insertRecordConversationComment({
    authorHrId: viewer.hrId,
    authorName: nameOf(names, viewer.hrId),
    authorRole: viewer.role,
    body,
    module: MODULE,
    recordId: plan.planId,
  });

  const recipients = managerPlanConversationAudience({
    managerHrId: plan.managerHrId,
    approverHrIds: [
      plan.firstApproverHrId,
      plan.secondApproverHrId,
      plan.firstDecidedByHrId,
      plan.decidedByHrId,
      ...asks.filter((ask) => isManagerAskLive(ask.status, plan.status)).flatMap((ask) => [ask.approverHrId, ask.secondApproverHrId]),
    ],
    authorHrIds: await listRecordConversationAuthors(MODULE, plan.planId),
    actorHrId: viewer.hrId,
  });
  for (const recipientHrId of recipients) {
    await tellManagerPlan(
      viewer,
      plan,
      { step: "conversation", recipientHrId, actorHrId: viewer.hrId, recordId: plan.planId, version: null, note: comment.body, customerName: null, byAdministrator: false, messageId: comment.id },
      isTest,
    );
  }
  return comment;
}
