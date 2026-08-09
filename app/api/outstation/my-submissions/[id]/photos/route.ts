import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getOwnOutstationSubmissionPhotos } from "@/lib/outstation/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Signed URLs for the two evidence photos on ONE of the caller's own submissions.
 *
 * Split out of the list read on purpose: the Expense Submissions page shows dozens of trips, and
 * minting a storage URL for every photo of every one of them would cost dozens of calls to render
 * a page where at most one detail is open.
 *
 * Ownership is enforced in the SERVICE, not here — `getOwnOutstationSubmissionPhotos` compares the
 * request's employee against the caller's own HR ID, so a second caller cannot skip it by reaching
 * the domain function another way.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "expenses", "read");

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const photos = await getOwnOutstationSubmissionPhotos(access, id);
    return NextResponse.json(photos);
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to load the photos.");
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_submission_photos_failed",
        message,
      },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
