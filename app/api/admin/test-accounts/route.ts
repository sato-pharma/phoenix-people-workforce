import { NextResponse } from "next/server";

import {
  assertTestAccountAdmin,
  createTestAccount,
  loadTestAccounts,
  updateTestAccount,
} from "@/lib/admin/test-accounts";
import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Test accounts (src/lib/auth/test-persona.ts): the Super Admin's own logins that live inside a real
// employee's portal and never save as her. GET lists them and the people they may mirror; POST makes
// one; PATCH points one at somebody else or switches it on or off. Super Admin only, every verb.

function failure(error: unknown) {
  const apiError = toApiError(error, "The test accounts request failed.");
  return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertTestAccountAdmin(access);
    return NextResponse.json({ ...(await loadTestAccounts()), success: true });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertTestAccountAdmin(access);
    const body = await bodyOf(request);
    const created = await createTestAccount({ loginId: body.loginId, mirrorsHrId: body.mirrorsHrId }, access);
    return NextResponse.json({ ...created, success: true }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertTestAccountAdmin(access);
    const body = await bodyOf(request);
    const updated = await updateTestAccount({ loginId: body.loginId, mirrorsHrId: body.mirrorsHrId, isActive: body.isActive }, access);
    return NextResponse.json({ ...updated, success: true });
  } catch (error) {
    return failure(error);
  }
}
