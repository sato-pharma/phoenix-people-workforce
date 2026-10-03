import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { personKey } from "@/lib/phoenix-crm/scope";
import { recordTouchTrail } from "@/lib/phoenix-crm/server/touch-trail";
import { parseTouchTrailBatch } from "@/lib/phoenix-crm/touch-trail";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = one flush of the Phoenix CRM touch trail (owner, 2026-10-03: "anything touches him,
//        automatically saved"). The browser posts every few seconds and on its way out; this writes
//        the rows and says nothing back.
//
// 🔴 IT ALWAYS ANSWERS 204, AND THAT IS THE POINT. A rep must not be able to tell this table exists
// (golden rule #1), so a readable body — a count, an id, an error — is exactly what must not be here.
// The only non-204 is the shared CSRF refusal, which is not this route's to invent.
//
// 🔴 `sendBeacon` IS A FIRST-CLASS CALLER, so the body is read as TEXT and parsed. A beacon's
// content type is the browser's to choose and `request.json()` would refuse the one case this table
// most needs — the flush from a page that is already closing.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    // READ, not create: looking at the module is the whole permission this needs, and a rep who may
    // open Phoenix CRM is a rep whose taps belong in its trail.
    await assertPermission(access, "phoenix_crm", "read");
    const actorHrId = personKey(access.hrId);
    if (!actorHrId) return new NextResponse(null, { status: 204 });

    const raw = await request.text();
    const batch = parseTouchTrailBatch(((): unknown => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })());
    if (!batch) return new NextResponse(null, { status: 204 });

    await recordTouchTrail({
      actorHrId,
      batch,
      // The session decides, and the body may only ADD the flag (rule 4 in the writer): a test
      // persona's taps are test taps whatever the browser says, and a real rep cannot hide in the
      // test world by claiming he is in it.
      isTest: Boolean(access.testPersona) || batch.test,
    });
    return new NextResponse(null, { status: 204 });
  } catch {
    // Not `phoenixCrmFailure`: a readable error here is the one thing that would tell a rep this
    // route exists. A refused or broken flush is a hole in the trail and nothing else.
    return new NextResponse(null, { status: 204 });
  }
}
