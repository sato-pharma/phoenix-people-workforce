import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isPortalSosActionsRole } from "@/lib/sales/portal-sos-dashboard";
import { loadPortalMonthPace } from "@/lib/sales/sos-month-pace-loader";
import { loadPortalPharmacyActions } from "@/lib/sales/sos-pharmacy-actions-loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Read-only feed for the pharmacy action lists and the weekly month-pace strip on the portal Source
// of Sales page. Scope is resolved from the SESSION; the only query parameter is the line the viewer
// picked, and pickPortalClosingLine refuses a line outside his scope rather than substituting one.

/**
 * The month-pace inputs in the form loadPortalMonthPace reads them — the line exactly, the areas and
 * products as upper-cased sets (null, "no bound", kept apart from an empty list) — so two inputs with
 * one key produce one strip.
 */
function paceInputsKey(inputs: {
  line: string;
  areaCodes: readonly string[] | null;
  productCodes: readonly string[] | null;
}): string {
  const asSet = (codes: readonly string[] | null) =>
    codes === null ? null : [...new Set(codes.map((code) => code.toUpperCase()))].sort();
  return JSON.stringify([inputs.line, asSet(inputs.areaCodes), asSet(inputs.productCodes)]);
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");
    if (!isPortalSosActionsRole(access.role)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const requestedLine = searchParams.get("line")?.trim() || null;

    // STARTED BESIDE THE CLOSING READS (2026-10-01, "slow to transfer between page and page"). For a
    // Medical Rep the loader knows the strip's line and areas before it reads a single closing row, and
    // hands them over at that moment, so the strip no longer waits for the action lists to finish. It
    // is used only when those are exactly the inputs the strip is given below; otherwise the strip runs
    // afterwards, as it always did.
    const early: { key: string; pace: ReturnType<typeof loadPortalMonthPace> }[] = [];
    const data = await loadPortalPharmacyActions({
      access,
      requestedLine,
      onPaceInputsKnown: (inputs) => {
        early.push({ key: paceInputsKey(inputs), pace: loadPortalMonthPace({ access, ...inputs }).catch(() => null) });
      },
    });

    // The pace strip needs a line, and a rep needs his area — without it he would be measured against
    // nothing, so it is simply not shown. Weekly failing never takes the action lists down with it.
    const canPace = Boolean(data.line) && (access.role !== "Medical Rep" || Boolean(data.areaCodes?.length));
    const paceInputs = canPace && data.line
      ? { line: data.line, areaCodes: data.areaCodes, productCodes: data.productCodes }
      : null;
    const earlyPace = paceInputs
      ? early.find((entry) => entry.key === paceInputsKey(paceInputs))?.pace
      : undefined;
    const pace = paceInputs
      ? await (earlyPace ?? loadPortalMonthPace({ access, ...paceInputs }).catch(() => null))
      : null;

    return NextResponse.json({ success: true, data, pace });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load your pharmacy actions.") },
      { status: 500 },
    );
  }
}
