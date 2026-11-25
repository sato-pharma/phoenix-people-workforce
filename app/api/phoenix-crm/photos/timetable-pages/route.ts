import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { timetablePagesForViewer } from "@/lib/phoenix-crm/server/timetable-pages";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the other photos of each timetable named (owner, 25 Nov 2026: "every photo appear"). A read,
// sent as a POST like photos/sign because a batch of paths does not belong in a URL; a timetable outside
// the viewer's reach answers no pages.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const paths = body && typeof body === "object" ? (body as Record<string, unknown>).paths : null;
    const pages = await timetablePagesForViewer(viewer, paths);
    return NextResponse.json({ pages, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the timetable photos.");
  }
}
