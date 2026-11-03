import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isForbiddenError } from "@/lib/auth/server";
import { OFFER_SEAT_REQUIRED_MESSAGE, OFFER_START_DATE_REQUIRED_MESSAGE } from "@/lib/offers/joining-form";
import { isOfferNotFound, isOfferSchemaMissing } from "@/lib/offers/service";

/**
 * One error shape for every offers route.
 *
 * `isOfferSchemaMissing` gets its own answer on purpose. The migration is new, and an environment
 * that has the code but not the tables would otherwise return a raw PostgREST message naming
 * `public.offer_templates` — which both leaks the schema and tells HR nothing they can act on.
 */
export function offerJsonError(error: unknown, fallback: string, defaultStatus = 500) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ message: (error as Error).message, success: false }, { status: 403 });
  }
  if (isOfferSchemaMissing(error)) {
    return NextResponse.json(
      {
        message: "The job-offer module is not set up in this environment yet. Its database migration has not been applied.",
        success: false,
      },
      { status: 503 },
    );
  }
  if (isOfferNotFound(error)) {
    return NextResponse.json({ message: (error as Error).message, success: false }, { status: 404 });
  }

  const message = clientSafeErrorMessage(error, fallback);
  // HR's own letter is missing a seat or a date, in sentences none of the words below match — so both
  // answered 500 and read as a server fault (1 Nov 2026, the seat one). A refusal, by name.
  if (message === OFFER_SEAT_REQUIRED_MESSAGE || message === OFFER_START_DATE_REQUIRED_MESSAGE) {
    return NextResponse.json({ message, success: false }, { status: 400 });
  }
  const lower = message.toLowerCase();
  if (lower.includes("not authenticated")) return NextResponse.json({ message, success: false }, { status: 401 });
  if (lower.includes("forbidden")) return NextResponse.json({ message, success: false }, { status: 403 });
  if (lower.includes("not found") || lower.includes("does not exist")) {
    return NextResponse.json({ message, success: false }, { status: 404 });
  }
  if (
    lower.includes("invalid") ||
    lower.includes("required") ||
    lower.includes("cannot") ||
    lower.includes("already")
  ) {
    return NextResponse.json({ message, success: false }, { status: 400 });
  }
  return NextResponse.json({ message, success: false }, { status: defaultStatus });
}
