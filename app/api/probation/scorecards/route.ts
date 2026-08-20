import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  listScorableProbationers,
  openManualScorecard,
} from "@/lib/probation/intelligence/manual-dv-day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mapError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? error);
  const lower = message.toLowerCase();
  if (isForbiddenError(error) || lower.includes("forbidden")) return { status: 403, message };
  if (lower.includes("not found")) return { status: 404, message };
  if (lower.includes("conflict")) return { status: 409, message };
  if (lower.includes("validation failed")) return { status: 400, message };
  return { status: 500, message };
}

// Probationers this caller may open a scorecard for. Coarse gate is probation:read — the real
// boundary (active undecided case + probation read scope + an eligible evaluator role for THIS rep)
// lives in the service, mirroring the DV feedback routes.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");
    const probationers = await listScorableProbationers(access);
    return NextResponse.json({ probationers }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, message } = mapError(error);
    return NextResponse.json({ error: message }, { status });
  }
}

// Open (or reuse) the caller's DV-Day for a probationer and return the id the structured scorecard
// form is keyed on. The body carries only WHO is being scored — the evaluator identity and role are
// re-derived server-side from the caller's own access context, never trusted from the request.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "read");

    const body = await request.json().catch(() => ({}));
    const employeeHrId = String((body as { employeeHrId?: unknown })?.employeeHrId ?? "").trim();
    if (!employeeHrId) {
      return NextResponse.json({ error: "Validation failed: employeeHrId is required." }, { status: 400 });
    }

    const result = await openManualScorecard(access, employeeHrId);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    const { status, message } = mapError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
