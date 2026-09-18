import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import {
  AndroidManagementNotConfiguredError,
  AndroidManagementRequestError,
} from "@/lib/devices/android-web-app";
import { TabletPolicyNotSavedError } from "@/lib/devices/rep-tablets-service";
import { TabletPolicyInputError } from "@/lib/devices/tablet-policy";

/**
 * One error mapping for the three Rep Tablets routes, so the page reads the same status for the
 * same cause whichever button was pressed.
 *
 * A missing enterprise binding is a SETUP state — 400 with `setupRequired`, which the page turns
 * into instructions — the same choice the Managed Google Play and Action1 routes make. A mistake in
 * what was typed is 400 with a sentence meant for the person who typed it; asking for a code before
 * the rules exist is 409; Google refusing is 502, carrying Google's own reason.
 */
export function repTabletsErrorResponse(error: unknown, fallback: string): NextResponse {
  if (isForbiddenError(error)) {
    return NextResponse.json({ message: (error as Error).message }, { status: 403 });
  }
  if (error instanceof AndroidManagementNotConfiguredError) {
    return NextResponse.json({ message: error.message, setupRequired: true }, { status: 400 });
  }
  if (error instanceof TabletPolicyInputError) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }
  if (error instanceof TabletPolicyNotSavedError) {
    return NextResponse.json({ message: error.message }, { status: 409 });
  }
  if (error instanceof AndroidManagementRequestError) {
    return NextResponse.json({ message: error.message }, { status: 502 });
  }
  return NextResponse.json(
    { message: error instanceof Error ? error.message : fallback },
    { status: 500 },
  );
}
