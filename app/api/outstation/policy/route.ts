import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { getOutstationPolicies, updateOutstationPolicies } from "@/lib/outstation/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import type { OutstationPolicyRule } from "@/lib/outstation/types";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One rule row from Outstation Policy (outstation-policy-admin.tsx). The role it belongs to is the row's key;
 * every figure is read by the service's own numberValue/Boolean, so a figure the screen sends as null (a
 * cleared box) reaches it exactly as before.
 */
const PolicyRuleBodySchema = z.looseObject({
  roleName: z.string(),
});

const PolicyUpdateBodySchema = z.object({
  rules: z.array(PolicyRuleBodySchema).nullable().optional(),
});

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "read");
    const policies = await getOutstationPolicies();
    return NextResponse.json({ policies });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to load outstation policy.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_policy_load_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "update");

    const parsedBody = await parseJsonBody(request, PolicyUpdateBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    const rules = (body.rules ?? []) as Array<Partial<OutstationPolicyRule> & { roleName: string }>;
    const policies = await updateOutstationPolicies(rules);
    return NextResponse.json({ policies });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to update outstation policy.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_policy_update_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
