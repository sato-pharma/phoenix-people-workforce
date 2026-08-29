import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { claimArrival, dismissArrival, listArrivals } from "@/lib/sales/inbox/arrivals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The distributor workbooks that arrived by email and are still waiting for a person.
 *
 * Gated on `sales:import` — identically to the upload and commit routes it sits beside, because
 * offering a file to somebody who may not import it is offering them nothing, and the arrivals
 * carry sender names and subject lines from the company mailbox.
 *
 * `distributor` narrows to the wizard's open step. Arrivals whose distributor could not be
 * detected are returned by the unfiltered call only, so an unrecognised workbook surfaces in the
 * list of everything rather than silently attaching itself to whichever step happens to be open.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const url = new URL(request.url);
    const distributor = url.searchParams.get("distributor");
    const arrivals = await listArrivals({
      distributorCode: distributor ? distributor.trim() : null,
      status: "arrived",
    });

    return NextResponse.json({ success: true, data: arrivals });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Could not read the arrived files.") },
      { status: 500 },
    );
  }
}

/**
 * Close out one arrival.
 *
 * `claim` is called after the wizard's commit succeeds. It is not decoration: commit DELETES the
 * storage object it read, so an arrival left open would keep being offered while pointing at a
 * file that no longer exists — the one way this feature could cost more time than it saves.
 *
 * `dismiss` is a person saying this is not a sales file (or is a second send of one already
 * imported). It removes the stored object with it.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

    const body = (await request.json().catch(() => ({}))) as {
      id?: string;
      action?: string;
      period?: string | null;
      batchId?: string | null;
      reason?: string | null;
    };
    const id = String(body?.id ?? "").trim();
    const action = String(body?.action ?? "").trim();
    if (!id) {
      return NextResponse.json({ success: false, error: "An arrival id is required." }, { status: 400 });
    }

    if (action === "dismiss") {
      await dismissArrival(id, { by: actor, reason: body?.reason ? String(body.reason) : null });
    } else if (action === "claim") {
      await claimArrival(id, {
        batchId: body?.batchId ? String(body.batchId) : null,
        by: actor,
        period: body?.period ? String(body.period) : null,
      });
    } else {
      return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Could not update the arrived file.") },
      { status: 500 },
    );
  }
}
