import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { ruleOnAddressFinding, scanAddressFindings } from "@/lib/sales/normalizer/address-findings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function actor(access: Awaited<ReturnType<typeof resolveAccessContext>>): string {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

// GET: one page of the walk. Every customer's name and address, nationally, so the same gate as the
// Mapping Database page itself.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: the wrong-town finder is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");
    const after = Number(new URL(request.url).searchParams.get("after"));
    const page = await scanAddressFindings({ after: Number.isFinite(after) && after > 0 ? after : 0 });
    return NextResponse.json({ success: true, ...page });
  } catch (error) {
    return fail(error, "Failed to read the wrong-town list.");
  }
}

// POST: one ruling, Move or Keep here.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: the wrong-town finder is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");
    const body = (await request.json().catch(() => ({}))) as {
      decision?: string;
      expectedBrickId?: string;
      expectedTargetBrickId?: string | null;
      expectedUpdatedAt?: string | null;
      id?: number;
    };
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0 || !body.expectedBrickId || (body.decision !== "move" && body.decision !== "keep")) {
      return NextResponse.json({ success: false, error: "A mapping, its brick and a decision are required." }, { status: 400 });
    }
    const result = await ruleOnAddressFinding({
      actorLoginId: actor(access),
      decision: body.decision,
      expectedBrickId: body.expectedBrickId,
      expectedTargetBrickId: body.expectedTargetBrickId ?? null,
      expectedUpdatedAt: body.expectedUpdatedAt ?? null,
      id,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return fail(error, "Failed to save the ruling.");
  }
}
