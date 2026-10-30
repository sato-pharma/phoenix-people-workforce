import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { addDayInterview, loadDayInterviews } from "@/lib/phoenix-crm/server/interview-cvs";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The interviews on an Interviews day (owner, 2026-10-29: "if interviews attach the cvs and scheduled time").
//
// GET  = with `date`, a recorded day as it was saved, for anyone who reads the territory; without it,
//        today's entry for the person recording it — the interviews booked for him in the hiring
//        calendar, read live, beside the ones he added.
// POST = add one interview by hand to TODAY, as multipart form data: `seatId`, `test`, `candidateName`,
//        `time` ("14:30") and `cv`. Today only, exactly like the day activity it belongs to.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const interviews = await loadDayInterviews(viewer, {
      date: search.get("date"),
      seatId: search.get("seatId"),
      test: search.get("test"),
    });
    return NextResponse.json({ interviews, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the interviews.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "create");
    const viewer = await resolvePhoenixCrmViewer(access);
    const interview = await addDayInterview(viewer, await request.formData());
    return NextResponse.json({ interview, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not add the interview.");
  }
}
