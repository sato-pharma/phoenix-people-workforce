import { NextResponse, type NextRequest } from "next/server";

import {
  RESET_SWITCHED_OFF_REASON,
  ResetSwitchedOffError,
  executeReset,
  type ResetScope,
} from "@/lib/admin/data-reset";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const VALID_SCOPES: ResetScope[] = ["sales", "weekly", "marketing", "all"];
const REQUIRED_CONFIRMATION = "CONFIRM DELETE";

function isValidScope(value: unknown): value is ResetScope {
  return typeof value === "string" && (VALID_SCOPES as string[]).includes(value);
}

export async function POST(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }

    assertSystemAdministratorWorkspaceAccess(access, "data-reset");

    // Switched off by the owner (see RESET_SWITCHED_OFF_REASON). executeReset refuses too; this
    // answers before the body is even read, with the reason the page shows him.
    if (RESET_SWITCHED_OFF_REASON) {
      return NextResponse.json({ error: "switched_off", message: RESET_SWITCHED_OFF_REASON }, { status: 423 });
    }

    const body: unknown = await request.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "bad_request", message: "Request body required." }, { status: 400 });
    }

    const { scope, confirmation } = body as Record<string, unknown>;

    if (!isValidScope(scope)) {
      return NextResponse.json(
        { error: "bad_request", message: `Invalid scope. Must be one of: ${VALID_SCOPES.join(", ")}.` },
        { status: 400 },
      );
    }

    if (confirmation !== REQUIRED_CONFIRMATION) {
      return NextResponse.json(
        { error: "bad_request", message: `Confirmation text must be exactly: "${REQUIRED_CONFIRMATION}"` },
        { status: 400 },
      );
    }

    const result = await executeReset(scope, access.loginId ?? access.hrId ?? "system");

    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    if (error instanceof ResetSwitchedOffError) {
      return NextResponse.json({ error: "switched_off", message: error.message }, { status: 423 });
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden") },
        { status: 403 },
      );
    }
    const message = clientSafeErrorMessage(error, "Reset failed.");
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}
