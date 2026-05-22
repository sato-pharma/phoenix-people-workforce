import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  decidePendingApproval,
  type PendingApprovalWorkflow,
} from "@/lib/pending-approvals/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const workflows = new Set<PendingApprovalWorkflow>([
  "contract-renewal",
  "excuse",
  "expense",
  "offer",
  "outstation",
  "payroll-batch",
  "resignation",
  "sales-import",
  "vacation",
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; workflow: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthorized", message: "Authentication is required." }, { status: 401 });
    }

    const { id, workflow } = await params;
    if (!workflows.has(workflow as PendingApprovalWorkflow)) {
      return NextResponse.json({ error: "unsupported_workflow", message: "Unsupported approval workflow." }, { status: 400 });
    }

    const body = await request.json().catch(() => ({})) as { comment?: unknown; decision?: unknown };
    const decision = String(body.decision ?? "").trim().toLowerCase();
    if (decision !== "approve" && decision !== "reject") {
      return NextResponse.json({ error: "invalid_decision", message: "Decision must be approve or reject." }, { status: 400 });
    }

    const result = await decidePendingApproval(access, workflow as PendingApprovalWorkflow, id, {
      comment: body.comment === undefined || body.comment === null ? null : String(body.comment),
      decision,
    });

    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update pending approval.";
    const status = message.toLowerCase().includes("forbidden") ? 403 : 400;
    return NextResponse.json({ error: "pending_approval_decision_failed", message }, { status });
  }
}
