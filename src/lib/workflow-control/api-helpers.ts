/**
 * Workflow Control Center — Phase 3D API route helpers.
 * Super-Admin guard + Result→HTTP-status mapper. No Supabase, no fetch.
 */

import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { canUseWorkflowDraftEditor } from "@/lib/auth/permissions";
import type { AccessContext } from "@/lib/auth/permissions";
import type { WorkflowControlActor, WorkflowControlResult } from "@/lib/workflow-control/types";

export async function requireWorkflowControlAdmin(
  request: Request,
): Promise<{ ok: true; access: AccessContext } | { ok: false; response: NextResponse }> {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "unauthenticated", message: "Authentication required." },
          { status: 401 },
        ),
      };
    }
    if (!canUseWorkflowDraftEditor(access)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "forbidden", message: `Forbidden: ${access.role} cannot manage Workflow Control.` },
          { status: 403 },
        ),
      };
    }
    return { ok: true, access };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to resolve access context.";
    return {
      ok: false,
      response: NextResponse.json({ error: "access_context_failed", message }, { status: 500 }),
    };
  }
}

export function actorFromAccess(access: AccessContext): WorkflowControlActor {
  return { hrId: access.hrId, loginId: access.loginId ?? null, role: access.role };
}

const RESULT_STATUS_MAP: Record<string, number> = {
  forbidden: 403,
  invalid_payload: 400,
  not_found: 404,
  noop: 409,
  persistence_disabled: 503,
  publish_disabled: 503,
  rollback_disabled: 503,
};

export function serviceResultToResponse<T>(result: WorkflowControlResult<T>, okStatus = 200): NextResponse {
  if (result.ok) {
    return NextResponse.json({ data: result.data, success: true }, { status: okStatus });
  }
  const status = RESULT_STATUS_MAP[result.code] ?? 500;
  return NextResponse.json({ error: result.code, message: result.error }, { status });
}

export async function readJsonBody<T = unknown>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function invalidBodyResponse(message: string): NextResponse {
  return NextResponse.json({ error: "invalid_body", message }, { status: 400 });
}
