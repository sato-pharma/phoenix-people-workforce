import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { confirmDmDoubleVisit, DmVisitConfirmationError } from "@/lib/outstation/dm-work-allowance-server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A District Manager confirms a double visit a rep logged with him (owner, 28 Nov 2026): the press sends
 * where he is. Who may confirm is decided in the service — only the visit's own manager, only on its own
 * day, only with a position (`confirmDmDoubleVisit`). The rep never sees it.
 */
const coordinate = z.union([z.number(), z.string()]).nullable().optional();
const BodySchema = z.object({
  accuracyMeters: coordinate,
  latitude: coordinate,
  longitude: coordinate,
  visitId: z.string().uuid(),
});

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
};

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const parsed = await parseJsonBody(request, BodySchema);
    if (!parsed.ok) return NextResponse.json({ error: "invalid_request_body", message: parsed.message }, { status: 400 });

    const result = await confirmDmDoubleVisit(access, {
      accuracyMeters: toNumber(parsed.data.accuracyMeters),
      latitude: toNumber(parsed.data.latitude),
      longitude: toNumber(parsed.data.longitude),
      visitId: parsed.data.visitId,
    });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    if (error instanceof DmVisitConfirmationError) {
      return NextResponse.json({ error: "confirmation_refused", message: error.message }, { status: 400 });
    }
    const status = isForbiddenError(error) ? 403 : 500;
    const message = clientSafeErrorMessage(error, "The double visit could not be confirmed.");
    return NextResponse.json({ error: "confirmation_failed", message }, { status });
  }
}
