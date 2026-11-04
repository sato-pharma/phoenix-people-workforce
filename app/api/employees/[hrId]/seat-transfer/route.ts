import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  listSeatTransferOptions,
  transferEmployeeSeat,
  type SeatTransferInput,
} from "@/lib/employees/seat-transfer";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiError(error: unknown) {
  const message = clientSafeErrorMessage(error, "Seat transfer failed.");
  const lowered = message.toLowerCase();
  if (isForbiddenError(error) || lowered.startsWith("forbidden")) {
    return { message, status: 403 };
  }
  if (lowered.includes("not found")) {
    return { message, status: 404 };
  }
  if (lowered.includes("already occupie")) {
    return { message, status: 409 };
  }
  if (
    lowered.startsWith("transfer:") ||
    lowered.startsWith("line move:") ||
    lowered.includes("required") ||
    lowered.includes("must be")
  ) {
    return { message, status: 400 };
  }
  return { message, status: 500 };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hrId: string }> },
) {
  try {
    const { hrId } = await params;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "read");

    const options = await listSeatTransferOptions(decodeURIComponent(hrId), access);
    return NextResponse.json({ success: true, data: options });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "seat_transfer_options_failed", message }, { status });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ hrId: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { hrId } = await params;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "update");

    const payload = (await request.json()) as { transfer?: SeatTransferInput };
    if (!payload.transfer) {
      return NextResponse.json(
        { error: "missing_transfer", message: "Transfer payload is required." },
        { status: 400 },
      );
    }

    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const result = await transferEmployeeSeat(decodeURIComponent(hrId), payload.transfer, actor, access);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "seat_transfer_failed", message }, { status });
  }
}
