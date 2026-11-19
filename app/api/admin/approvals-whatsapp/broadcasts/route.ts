import { NextResponse } from "next/server";

import {
  approvalsActor,
  approvalsApiError,
  approvalsProblem,
  approvalsWhatsAppForbidden,
  readJsonBody,
  text,
  valuesObject,
} from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { APPROVALS_TIER_LIMIT } from "@/lib/approvals-whatsapp/rules";
import { createApprovalsBroadcast, planApprovalsBroadcast } from "@/lib/approvals-whatsapp/send";
import { approvalsContactedToday, listApprovalsBroadcasts } from "@/lib/approvals-whatsapp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Every bulk send, newest first, with today's use of the daily limit. Super Admin only. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const [broadcasts, contacted] = await Promise.all([listApprovalsBroadcasts(), approvalsContactedToday()]);
    return NextResponse.json({ broadcasts, dailyLimit: { limit: APPROVALS_TIER_LIMIT, usedToday: contacted.size } });
  } catch (error) {
    return approvalsApiError(error, "Failed to load the bulk sends.");
  }
}

/**
 * `{ preview: true, ... }` works out the send without sending: who receives it, what three of them read, who is skipped
 * and why, and today's limit. Without `preview` the same plan is written and sent after the reply, throttled, one message
 * per recipient — refused whole when it would pass the daily limit. Super Admin only.
 *
 * Body: `{ templateName, language, mapping, recipients: { employeeHrIds?, pasted?, listId? } }`.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const body = await readJsonBody(request);
    const templateName = text(body.templateName);
    const language = text(body.language);
    if (!templateName || !language) return approvalsProblem("Pick an approved wording to send.", 400);
    const recipients = valuesObject(body.recipients) ?? {};
    const input = { language, mapping: body.mapping, recipients, templateName };

    if (body.preview === true) {
      const { plan } = await planApprovalsBroadcast(input);
      return NextResponse.json({
        ...plan,
        recipientCount: plan.recipients.length,
        recipients: undefined,
        sample: plan.recipients.slice(0, 3).map((recipient) => ({ name: recipient.name, renderedBody: recipient.renderedBody, waId: recipient.waId })),
      });
    }

    const created = await createApprovalsBroadcast({ ...input, access });
    await writeRequiredAuditLog({
      actorLoginId: approvalsActor(access),
      entityId: created.broadcastId,
      entityType: "approvals_whatsapp_broadcast",
      newValues: { language, recipientCount: created.recipientCount, templateName },
      summary: `Started a WhatsApp bulk send of ${templateName} to ${created.recipientCount} people from the approvals line.`,
    });
    return NextResponse.json({ success: true, ...created }, { status: 201 });
  } catch (error) {
    return approvalsApiError(error, "Failed to start the bulk send.");
  }
}
