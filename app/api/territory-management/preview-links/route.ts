import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  createTerritoryPreviewLink,
  listTerritoryPreviewLinks,
  revokeTerritoryPreviewLink,
} from "@/lib/territory-management/preview-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The authenticated side that mints and kills preview links. The links themselves are served by
// /api/share/territory/[token]/… which is deliberately unauthenticated and passcode-free.
//
// Publishing geography past the login wall is the strongest export there is, so the gate is
// sales:export and never sales:read. It is asserted TWICE, on purpose:
//
//   * here in the handler, because the route handler is this repo's security boundary and
//     access-registry-coverage enforces that every session route carries its own assertPermission
//     rather than trusting whatever it happens to call;
//   * again inside the domain, which additionally requires Super Admin.
//
// The duplication is the point. A later refactor that swaps the domain call for a different helper
// still cannot accidentally publish the company's territory, and one that strips this line still
// hits the domain — neither slip alone opens the door.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    const links = await listTerritoryPreviewLinks(access);
    return NextResponse.json({ links, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load preview links.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (String(body.action ?? "") === "revoke") {
      await revokeTerritoryPreviewLink(access, String(body.linkId ?? ""));
      return NextResponse.json({ success: true });
    }

    const result = await createTerritoryPreviewLink(access, {
      expiresInDays: body.expiresInDays == null ? null : Number(body.expiresInDays),
      label: body.label ? String(body.label) : null,
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not create the preview link.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
