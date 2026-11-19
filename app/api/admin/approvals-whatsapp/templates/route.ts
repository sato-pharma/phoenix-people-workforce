import { NextResponse } from "next/server";

import {
  approvalsActor,
  approvalsApiError,
  approvalsProblem,
  approvalsWhatsAppForbidden,
  readJsonBody,
} from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { buildTemplateSubmission } from "@/lib/approvals-whatsapp/rules";
import { listAllTemplates, submitWhatsAppTemplate } from "@/lib/whatsapp-inbox/graph";
import { whatsAppApprovalsLine } from "@/lib/whatsapp-inbox/lines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function lineOrProblem() {
  const line = whatsAppApprovalsLine();
  return line ? { line } : { problem: approvalsProblem("The approvals line is not set up on this server.", 503) };
}

/**
 * Every wording on the approvals line's account with Meta's status (Pending, Approved, Rejected with Meta's reason), and
 * the approved ones mapped for the composer — only an approved wording can be sent. Super Admin only.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const resolved = lineOrProblem();
    if (resolved.problem) return resolved.problem;
    const listings = await listAllTemplates(resolved.line.businessAccountId);
    return NextResponse.json({
      approved: listings.flatMap((listing) => (listing.approved && !listing.approved.unsupportedReason ? [listing.approved] : [])),
      templates: listings.map(({ approved, ...listing }) => ({ ...listing, sendable: Boolean(approved && !approved.unsupportedReason) })),
    });
  } catch (error) {
    return approvalsApiError(error, "WhatsApp did not return the wordings.");
  }
}

/** Submits a new wording to Meta for review: name, Arabic or English, Utility or Marketing, body with named fields. */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const resolved = lineOrProblem();
    if (resolved.problem) return resolved.problem;
    const body = await readJsonBody(request);
    const built = buildTemplateSubmission({
      body: body.body,
      category: body.category,
      examples: body.examples,
      language: body.language,
      name: body.name,
    });
    if (!built.ok) return approvalsProblem(built.problems.join(" "), 400, { problems: built.problems });
    const submitted = await submitWhatsAppTemplate(resolved.line.businessAccountId, built.request);
    await writeRequiredAuditLog({
      actorLoginId: approvalsActor(access),
      entityId: submitted.id,
      entityType: "approvals_whatsapp_template",
      newValues: { category: built.submission.category, language: built.submission.language, name: built.submission.name, status: submitted.status },
      summary: `Submitted the WhatsApp wording ${built.submission.name} to Meta from the approvals line.`,
    });
    return NextResponse.json({ success: true, ...submitted }, { status: 201 });
  } catch (error) {
    return approvalsApiError(error, "Meta did not take the wording.");
  }
}
