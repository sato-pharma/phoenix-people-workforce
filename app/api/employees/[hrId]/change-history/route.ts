import { NextResponse } from "next/server";

import { assertPermission, canSeeEmployee } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { changeHistoryIncludesMoney, loadEmployeeChangeHistory } from "@/lib/employees/change-history-service";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorStatus(error: unknown): { message: string; status: number } {
  const message = clientSafeErrorMessage(error, "Unexpected error.");
  if (isForbiddenError(error)) return { message, status: 403 };
  const lower = message.toLowerCase();
  if (lower.includes("not authenticat") || lower.includes("unauthenticat")) return { message, status: 401 };
  if (lower.includes("not found")) return { message, status: 404 };
  return { message, status: 500 };
}

async function loadTarget(hrId: string) {
  const keys = hrIdLookupKeys(hrId);
  if (keys.length === 0) throw new Error(`Employee ${hrId} was not found.`);
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, manager_hr_id")
    .in("hr_id", keys)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Employee ${hrId} could not be read.`);
  if (!data) throw new Error(`Employee ${hrId} was not found.`);
  return data as { hr_id: string; manager_hr_id: string | null };
}

/**
 * One employee's change history: the employee record's log and, for a viewer who may see pay, the
 * salary log. The same door as the person's photo: signed in, `employees` read, and able to see
 * this person in the directory. Read-only; nothing here writes either log.
 */
export async function GET(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    // resolveAccessContext falls back to a guest context instead of throwing, so the guest is
    // refused here, as the photo route does.
    if (access.source === "guest") throw new Error("Not authenticated.");
    await assertPermission(access, "employees", "read");
    const { hrId } = await params;
    const target = await loadTarget(hrId);
    if (!canSeeEmployee(access, { hrId: target.hr_id, managerHrId: target.manager_hr_id })) {
      throw new Error("Forbidden: you do not have access to this employee.");
    }
    const payload = await loadEmployeeChangeHistory(target.hr_id, {
      includeMoney: changeHistoryIncludesMoney(access, target.hr_id),
    });
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
