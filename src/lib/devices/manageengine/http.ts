import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { ManageEngineNotConfiguredError } from "@/lib/devices/manageengine/auth";
import { ManageEngineRequestError } from "@/lib/devices/manageengine/client";
import { ManageEngineCommandInputError } from "@/lib/devices/manageengine/commands";

/**
 * One error mapping for the ManageEngine bridge routes, so the page reads the same status for the
 * same cause whichever button was pressed.
 *
 * No credential yet is a SETUP state — 400 with `setupRequired`, which the page turns into "connect
 * the bridge" instructions, the same choice the Rep Tablets and Managed Google Play routes make. A
 * mistake in what was sent is 400 with a sentence for the person; ManageEngine refusing is 502,
 * carrying its own reason.
 */
export function manageEngineErrorResponse(error: unknown, fallback: string): NextResponse {
  if (isForbiddenError(error)) {
    return NextResponse.json({ message: (error as Error).message }, { status: 403 });
  }
  if (error instanceof ManageEngineNotConfiguredError) {
    return NextResponse.json({ message: error.message, setupRequired: true }, { status: 400 });
  }
  if (error instanceof ManageEngineCommandInputError) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }
  if (error instanceof ManageEngineRequestError) {
    return NextResponse.json({ message: error.message }, { status: 502 });
  }
  return NextResponse.json({ message: error instanceof Error ? error.message : fallback }, { status: 500 });
}
