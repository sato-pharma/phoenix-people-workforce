import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { writeAuditLog } from "@/lib/admin/audit";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { completeCrmAccountSetup, dismissCrmAccountSetup } from "@/lib/crm/account-setup";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record a new hire's CRM account, or rule that they do not need one.
 *
 * DELIBERATELY NOT `/api/employees`. That route requires `employees:update` and rewrites the whole
 * employee row from its payload — the SFE Manager holds neither the grant nor any business editing
 * salary or employment status. This one is gated on the CRM workspace (Super Admin + SFE Manager,
 * the same predicate as every other CRM tool) and can write exactly two columns.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (!canUseAdminCrmWorkspace(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "This action is limited to the admin CRM workspace roles.", success: false },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      crmCode?: unknown;
      crmUsername?: unknown;
      hrId?: unknown;
      note?: unknown;
    };

    const hrId = typeof body.hrId === "string" ? body.hrId.trim() : "";
    if (!hrId) {
      return NextResponse.json(
        { error: "invalid_input", message: "An employee HR ID is required.", success: false },
        { status: 400 },
      );
    }

    if (body.action === "dismiss") {
      const note = typeof body.note === "string" ? body.note : null;
      await dismissCrmAccountSetup({ actorHrId: access.hrId ?? null, hrId, note });
      // writeAuditLog, not writeRequiredAuditLog: the throwing variant would report a FAILURE for a
      // decision that has already been recorded, and the durable "who did this" is the task row's
      // own resolved_by_hr_id, which the table's CHECK refuses to leave empty.
      await writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: hrId,
        entityType: "crm_account_setup",
        newValues: { note, status: "not_applicable" },
        summary: `Recorded that ${hrId} needs no CRM account`,
      });
      return NextResponse.json({ hrId, status: "not_applicable", success: true });
    }

    if (body.action !== "save") {
      return NextResponse.json(
        { error: "invalid_input", message: "Action must be save or dismiss.", success: false },
        { status: 400 },
      );
    }

    const saved = await completeCrmAccountSetup({
      actorHrId: access.hrId ?? null,
      crmCode: typeof body.crmCode === "string" ? body.crmCode : null,
      crmUsername: typeof body.crmUsername === "string" ? body.crmUsername : null,
      hrId,
    });

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: hrId,
      entityType: "crm_account_setup",
      newValues: { crmId: saved.crmId, crmUsername: saved.crmUsername, status: "completed" },
      summary: `Recorded the CRM account for ${hrId}`,
    });

    return NextResponse.json({ ...saved, status: "completed", success: true });
  } catch (error) {
    // 400, not 500: every failure this route can reach is a refusal a person can act on — a CRM id
    // already assigned to somebody else, an HR ID that no longer exists, a dismissal with no reason.
    const message = clientSafeErrorMessage(error, "Failed to save this CRM account setup.");
    return NextResponse.json({ error: "crm_account_setup_failed", message, success: false }, { status: 400 });
  }
}
