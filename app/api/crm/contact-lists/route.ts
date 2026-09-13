import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  applyContactListChangeDirectly,
  assertContactListAccess,
  cancelContactListChange,
  decideContactListChange,
  getContactListView,
  requestContactListChange,
  searchContactListDoctors,
} from "@/lib/crm/contact-lists/service";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown, fallback: string) {
  const apiError = toApiError(error, fallback);
  const status = isForbiddenError(error) ? 403 : apiError.status;
  return NextResponse.json(
    { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
    { status },
  );
}

// GET  = the page: the signed-in rep's own list and requests, the requests waiting for his answer as
//        manager, and for the SFE Manager or administrator the rep they picked (?rep=). With ?search=
//        it answers the doctor search for an add instead.
// POST = action "request" (a rep asks for a change to his own list), "apply" (the SFE Manager or the
//        administrator changes a rep's list directly), "decide" (the stored manager answers) or
//        "cancel" (the rep withdraws his own). A rep and a manager are always the session; each
//        service function checks its own permission and scope.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertContactListAccess(access);
    const url = new URL(request.url);
    const search = url.searchParams.get("search");
    if (search != null) {
      const doctors = await searchContactListDoctors(access, { query: search });
      return NextResponse.json({ doctors, success: true });
    }
    const view = await getContactListView(access, { repHrId: url.searchParams.get("rep") });
    return NextResponse.json({ view, success: true });
  } catch (error) {
    return failure(error, "Could not load the doctor list.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertContactListAccess(access);
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === "request") {
      const result = await requestContactListChange(access, body.change as Record<string, unknown>);
      return NextResponse.json({ ...result, success: true });
    }
    if (body.action === "apply") {
      const result = await applyContactListChangeDirectly(access, body.change as Record<string, unknown>);
      return NextResponse.json({ ...result, success: true });
    }
    if (body.action === "decide") {
      const result = await decideContactListChange(access, {
        changeId: body.changeId,
        decision: body.decision,
        note: body.note,
      });
      return NextResponse.json({ ...result, success: true });
    }
    if (body.action === "cancel") {
      const result = await cancelContactListChange(access, { changeId: body.changeId });
      return NextResponse.json({ ...result, success: true });
    }
    throw validationError("Choose what to do.");
  } catch (error) {
    return failure(error, "Could not save that.");
  }
}
