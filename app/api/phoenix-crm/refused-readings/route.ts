import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { parseBlockedPermissionReport } from "@/lib/phoenix-crm/refused-readings-rules";
import { personKey } from "@/lib/phoenix-crm/scope";
import { recordBlockedPermission } from "@/lib/phoenix-crm/server/refused-readings";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = one capture the BROWSER ended, reported by the browser itself: it blocked location or the
//        camera, so nothing was sent, no door refused it, and until this route existed no row of it
//        reached the refused-readings board at all.
//
// 🔴 IT IS A REPORT, NOT A REFUSAL, AND IT IS THE ONLY WRITE HERE THE SERVER DID NOT DECIDE. The
// three recorded reasons are judgements on a reading that arrived; this one is the phone saying its
// own permission is off. That is why it has a route of its own instead of riding a save — there is
// no save to ride.
//
// 🔴 IT ALWAYS ANSWERS 204. A rep must not be able to tell this table
// exists (golden rule #1), so a readable body — a count, an id, an error — is precisely what must
// not be here. The only non-204 is the shared CSRF refusal, which is not this route's to invent.
//
// THE REP IS THE SESSION'S. The body may name the seat and may ADD the test flag; it can never say
// whose phone this was. A blocked permission attributed from a body would be a board anybody could
// write anybody onto.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    // READ, not create: a rep who may open Phoenix CRM is a rep whose blocked permission belongs on
    // the board that exists to help him.
    await assertPermission(access, "phoenix_crm", "read");
    const actorHrId = personKey(access.hrId);
    if (!actorHrId) return new NextResponse(null, { status: 204 });

    // Read as TEXT and parsed, so a `sendBeacon` from a page that is already closing is readable
    // too: a beacon's content type is the browser's to choose and `request.json()` would refuse it.
    const raw = await request.text();
    const report = parseBlockedPermissionReport(((): unknown => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })());
    if (!report) return new NextResponse(null, { status: 204 });

    await recordBlockedPermission({
      subjectKind: report.subjectKind,
      permission: report.permission,
      seatId: report.seatId,
      repHrId: actorHrId,
      // The session decides, and the body may only ADD the flag: a test persona's blocked camera is
      // a test row whatever the browser says, and a real rep cannot hide in the test world.
      isTest: Boolean(access.testPersona) || report.test,
    });
    return new NextResponse(null, { status: 204 });
  } catch {
    // Not `phoenixCrmFailure`: a readable error here is the one thing that would tell a rep this
    // route exists. A refused or broken report is a hole in the board and nothing else.
    return new NextResponse(null, { status: 204 });
  }
}
