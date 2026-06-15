import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { parseExpenseFiltersFromSearchParams } from "@/components/outstation/expense-shared/formatters";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { getOutstationExpenseCommandData } from "@/lib/outstation/expense-command";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "read");
    const filters = parseExpenseFiltersFromSearchParams(new URL(request.url).searchParams);
    const data = await getOutstationExpenseCommandData(access, filters);
    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load outstation expense command data.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_expense_command_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
