import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { addDeductionsReply } from "@/lib/deductions/comments.ts";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { listPublishedDeductionCommentThreads } from "@/lib/deductions/portal.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The admin Disputes inbox: every employee comment on a published deduction, company-wide and
// month-independent. A deduction comment mails HR a link that lands here, so this is the read
// behind that destination. Company-wide data, admin audience only — the same gate as every other
// /api/admin/deductions read, asserted on top of the RBAC action (see permissions.ts).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    assertDeductionsReadActor(access);

    const threads = await listPublishedDeductionCommentThreads();
    return NextResponse.json({ success: true, threads });
  } catch (error) {
    return jsonError(error, "Failed to load deduction comments.");
  }
}

// An HR reply on a dispute — the other side of the conversation the GET above lists. Super Admin
// only (assertDeductionsDecisionActor, inside addDeductionsReply — the owner's call, 2026-10-06);
// CSRF-protected because it writes. The reply is delivered to the employee's portal, opening a
// two-way thread.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");

    const body = await request.json();
    const candidateId = String(body.candidateId ?? "").trim();
    if (!candidateId) {
      return NextResponse.json({ success: false, error: "candidateId is required." }, { status: 400 });
    }

    // `delivery` says who the reply was addressed to and whether Telegram can reach them, so the
    // Disputes inbox shows the sender what the reply did (owner, 2026-10-08).
    const { comment, delivery } = await addDeductionsReply({ access, body: String(body.body ?? ""), candidateId });
    return NextResponse.json({ success: true, comment, delivery });
  } catch (error) {
    return jsonError(error, "Failed to save the reply.");
  }
}
