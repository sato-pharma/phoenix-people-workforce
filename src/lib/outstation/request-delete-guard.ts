import type { AccessContext } from "@/lib/auth/permissions";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import { forbiddenError } from "@/lib/http/api-errors";

/**
 * 🔴 ONLY THE OWNER DELETES AN EXPENSE REQUEST, BY HIS OWN PRESS — THE SYSTEM NEVER DOES (owner, 24 Nov 2026,
 * about 01:20 Cairo: "leave the delete the button i meant u never delete automatic only i from system can
 * delete").
 *
 * A delete is his decision, made in the app: Delete expense on Outstation Requests, or the System Cleanup
 * Center. So the caller must be a real signed-in Super Admin session: never a system context (a cron, a job,
 * a script's built context), never a dev-preview, a View as Seat or a test account. The database says the same:
 * a row leaves outstation_expense_requests only through phx_owner_delete_outstation_request, which the
 * trigger phx_outstation_requests_never_deleted lets through, and a plain DELETE or a TRUNCATE is refused.
 */
export function assertOwnerDeletesRequest(
  access: Pick<AccessContext, "role" | "source" | "seatView" | "testPersona">,
): void {
  if (access.source !== "session" || access.role !== "Super Admin" || access.testPersona) {
    throw forbiddenError(
      "Only the Super Admin, in their own signed-in session, can delete an expense request. The system never deletes one.",
    );
  }
  assertRealSessionForDecision(access, "delete an expense request");
}

