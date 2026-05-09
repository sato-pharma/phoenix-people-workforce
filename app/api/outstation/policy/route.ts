import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { getOutstationPolicies, updateOutstationPolicies } from "@/lib/outstation/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "read");
    const policies = await getOutstationPolicies();
    return NextResponse.json({ policies });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load outstation policy.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_policy_load_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "update");

    const body = await request.json();
    const policies = await updateOutstationPolicies(Array.isArray(body.rules) ? body.rules : []);
    return NextResponse.json({ policies });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update outstation policy.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_policy_update_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
