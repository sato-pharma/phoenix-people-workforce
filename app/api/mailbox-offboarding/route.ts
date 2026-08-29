import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isDevelopment } from "@/lib/env";
import {
  getMailboxOffboardingDashboardData,
  isMailboxBulkStep,
  isMailboxOffboardingSchemaMissing,
  isMailboxStep,
  mailboxOffboardingErrorMessage,
  openMailboxOffboardingTask,
  MAILBOX_BULK_MAX,
  recordMailboxOffboardingStep,
  recordMailboxOffboardingStepsBulk,
} from "@/lib/mailbox-offboarding/service";
import type { MailboxDisposition } from "@/lib/mailbox-offboarding/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Gated on `clearance`, not on a new resource of its own.
 *
 * A leaver's mailbox IS clearance — the "IT & System Access" station on every checklist reads
 * "email, Phoenix and all system access revoked", and this register is that sentence given a
 * table. Minting a `mailbox_offboarding` resource would have to be granted to exactly the roles
 * that already hold `clearance`, would add a fourth CI gate to trip, and would create a second
 * place where an offboarding grant can drift out of step with the first.
 */
function mailboxApiError(error: unknown) {
  if (isForbiddenError(error)) return { message: mailboxOffboardingErrorMessage(error), status: 403 };
  if (isMailboxOffboardingSchemaMissing(error)) {
    return {
      message: isDevelopment
        ? mailboxOffboardingErrorMessage(error)
        : "The mailbox offboarding register is not ready.",
      status: 409,
    };
  }
  return { message: mailboxOffboardingErrorMessage(error), status: 500 };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "clearance", "read");
    return NextResponse.json(await getMailboxOffboardingDashboardData());
  } catch (error) {
    const { message, status } = mailboxApiError(error);
    return NextResponse.json({ error: "mailbox_offboarding_load_failed", message }, { status });
  }
}

/**
 * Two mutations, separated by `action`.
 *
 * `record` is gated on `update` and `open` on `create`, matching the clearance route exactly. The
 * page hides the controls when the permission is absent, but that is UX — this is the boundary.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const payload = (await request.json()) as {
      action?: "open" | "record" | "record_bulk";
      employeeHrId?: string;
      taskId?: string;
      taskIds?: string[];
      step?: string;
      disposition?: MailboxDisposition;
      forwardingTo?: string | null;
      forwardingExpiresOn?: string | null;
      reason?: string | null;
      note?: string | null;
    };

    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    if (payload.action === "open") {
      await assertPermission(access, "clearance", "create");
      if (!payload.employeeHrId) {
        return NextResponse.json(
          { error: "missing_employee", message: "An employee is required to open a mailbox task." },
          { status: 400 },
        );
      }
      await openMailboxOffboardingTask(payload.employeeHrId, actor, "sweep");
      return NextResponse.json(await getMailboxOffboardingDashboardData());
    }

    if (payload.action === "record") {
      await assertPermission(access, "clearance", "update");
      if (!payload.taskId || !isMailboxStep(payload.step)) {
        return NextResponse.json(
          { error: "missing_step", message: "A task and a known step are required." },
          { status: 400 },
        );
      }
      await recordMailboxOffboardingStep(
        {
          taskId: payload.taskId,
          step: payload.step,
          disposition: payload.disposition ?? null,
          forwardingTo: payload.forwardingTo ?? null,
          forwardingExpiresOn: payload.forwardingExpiresOn ?? null,
          reason: payload.reason ?? null,
          note: payload.note ?? null,
        },
        actor,
      );
      return NextResponse.json(await getMailboxOffboardingDashboardData());
    }

    /**
     * One step, many tasks, ONE round trip.
     *
     * Gated on `clearance:update`, exactly like `record` — bulk is a shortcut through the same
     * work, never a second door into it, so it must not be reachable by anyone who cannot record
     * a single row.
     *
     * It answers **200 with a per-row report even when some rows failed**, because a bulk write is
     * partial by nature: the alternative, a 500 that names one bad row, would leave the admin
     * unable to tell which of the other rows landed. The caller reads `outcomes` and says so.
     */
    if (payload.action === "record_bulk") {
      await assertPermission(access, "clearance", "update");
      const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds : [];
      if (taskIds.length === 0 || !isMailboxBulkStep(payload.step)) {
        return NextResponse.json(
          { error: "missing_step", message: "At least one task and a bulk-recordable step are required." },
          { status: 400 },
        );
      }
      if (taskIds.length > MAILBOX_BULK_MAX) {
        return NextResponse.json(
          {
            error: "too_many_tasks",
            message: `A bulk recording is limited to ${MAILBOX_BULK_MAX} rows at a time.`,
          },
          { status: 400 },
        );
      }
      if (payload.step === "disposition" && !payload.disposition) {
        return NextResponse.json(
          { error: "missing_disposition", message: "A mailbox outcome is required to record it in bulk." },
          { status: 400 },
        );
      }
      const outcomes = await recordMailboxOffboardingStepsBulk(
        {
          taskIds,
          step: payload.step,
          disposition: payload.disposition ?? null,
          forwardingTo: payload.forwardingTo ?? null,
          forwardingExpiresOn: payload.forwardingExpiresOn ?? null,
          note: payload.note ?? null,
        },
        actor,
      );
      return NextResponse.json({ ...(await getMailboxOffboardingDashboardData()), outcomes });
    }

    return NextResponse.json(
      { error: "unknown_action", message: "Unknown mailbox offboarding action." },
      { status: 400 },
    );
  } catch (error) {
    const { message, status } = mailboxApiError(error);
    return NextResponse.json({ error: "mailbox_offboarding_action_failed", message }, { status });
  }
}
