import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isMedicalRepExpenseViewer } from "@/lib/outstation/medical-rep-expense-viewer";
import {
  fetchPlacePredictions,
  isPlacesNotConfiguredError,
} from "@/lib/outstation/places-autocomplete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Destination suggestions for someone FILING an expense, as opposed to approving one.
 *
 * Why this exists beside the admin route rather than replacing it, and why the gate is what it is:
 *
 * The medical rep manual expense path (`submitMedicalRepSimpleExpenseRequest`) had a free-text
 * destination box, and the one submission ever made through it stored `"Baniseaf"` — a
 * misspelling of Beni Suef — as the trip's destination. The obvious fix was to reuse
 * `PlacesAutocompleteInput`, but that component calls the ADMIN route, which asserts
 * `assertOutstationAdminAccess(access, "approve")`. A rep would have received 403 and an empty
 * dropdown, with no indication why.
 *
 * 🔴 The gate here is `outstation:create` — **exactly the permission the rep already needs to
 * submit the expense this destination belongs to** (see
 * `app/api/outstation/medical-rep-expenses/route.ts`). That is deliberate and it is the whole
 * security argument: this route grants NO capability its caller did not already have. Someone who
 * may file a trip may search for the place they travelled to. It must never be widened to a
 * looser gate, and it must never be left ungated because "it is only autocomplete" — it spends
 * billable Google Places calls under the company's key.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    // 🔴 SECOND GATE, and it is the one that matters. `outstation:create` alone admits TWELVE
    // roles — District Manager, Product Manager, SFE Manager and the generic **Employee** among
    // them — because it is the permission for filing ANY outstation expense. The submission this
    // route serves is narrower: `submitMedicalRepSimpleExpenseRequest` also calls
    // `assertMedicalRepExpenseRole`, so only a Medical Rep can actually file one.
    //
    // Matching only the permission and not the second check left every Employee able to spend
    // billable Google Places calls on the company key while being unable to file the expense
    // those calls are for. Measured against the live permission matrix on 2026-09-28, after the
    // first version of this route had already merged (#4644).
    //
    // The check is the SESSION role, deliberately — the same one that gates the page this picker
    // renders on (`app/employee-portals/expense-dashboard/page.tsx`). Whoever can SEE the field
    // can use it, and nobody else. It is also a plain in-memory read: the submit path's
    // job-function lookup hits the employee record, which is far too heavy for a route that fires
    // on every keystroke. Where the two disagree, this one is the stricter, so it fails closed.
    if (!isMedicalRepExpenseViewer(access)) {
      return NextResponse.json(
        {
          error: "forbidden",
          message: "Only Medical Rep users can search destinations for a simple expense.",
        },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(request.url);
    const predictions = await fetchPlacePredictions(
      searchParams.get("input") ?? "",
      searchParams.get("sessiontoken"),
    );

    return NextResponse.json({ predictions });
  } catch (error) {
    if (isPlacesNotConfiguredError(error)) {
      return NextResponse.json(
        { error: "maps_unavailable", message: error.message },
        { status: 503 },
      );
    }

    const message = clientSafeErrorMessage(error, "Places autocomplete failed.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "places_autocomplete_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
