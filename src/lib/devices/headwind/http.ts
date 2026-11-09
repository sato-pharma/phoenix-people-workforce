import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { HeadwindActionError } from "@/lib/devices/headwind/actions";
import { HeadwindAppInputError } from "@/lib/devices/headwind/apps";
import { HeadwindNotConfiguredError } from "@/lib/devices/headwind/auth";
import { HeadwindRequestError } from "@/lib/devices/headwind/client";
import { HeadwindCommandInputError, HeadwindCommandUnconfirmedError } from "@/lib/devices/headwind/commands";
import { HeadwindConfigurationError } from "@/lib/devices/headwind/configurations";
import { HeadwindDeviceNotFoundError } from "@/lib/devices/headwind/devices";
import { HeadwindEnrollmentError } from "@/lib/devices/headwind/enrollment";
import { HeadwindLocationError } from "@/lib/devices/headwind/locations";
import { HeadwindRemoteScreenIdError } from "@/lib/devices/headwind/remote-screen-id";
import { HeadwindUploadError } from "@/lib/devices/headwind/uploads";
import { HeadwindUserError } from "@/lib/devices/headwind/users";
import { HeadwindWipeError } from "@/lib/devices/headwind/wipe";
import { RustDeskNotConfiguredError } from "@/lib/devices/rustdesk/config";

/**
 * One error mapping for the Headwind bridge routes, so the page reads the same status for the same
 * cause whichever button was pressed — the shape the retired ManageEngine bridge set.
 *
 * No credential yet is a SETUP state — 400 with `setupRequired`, which the page turns into "connect
 * the bridge" instructions rather than an error. A mistake in what was sent is 400 with a sentence
 * for the person; the Headwind server refusing is 502, carrying its own reason.
 *
 * 🔴 AN ACTION WHOSE WIRE NAME IS NOT CONFIRMED YET IS 501, NOT 400 OR 502. It is neither the
 * person's mistake nor the server's refusal: it is Phoenix not knowing the word to send, and saying
 * so plainly is the whole point of `HEADWIND_MESSAGE_TYPES` — an action must never be silently
 * dropped, nor reported as a failure of the tablet.
 */
export function headwindErrorResponse(error: unknown, fallback: string): NextResponse {
  if (isForbiddenError(error)) {
    return NextResponse.json({ message: (error as Error).message }, { status: 403 });
  }
  if (error instanceof HeadwindNotConfiguredError || error instanceof RustDeskNotConfiguredError) {
    return NextResponse.json({ message: error.message, setupRequired: true }, { status: 400 });
  }
  if (error instanceof HeadwindCommandUnconfirmedError) {
    return NextResponse.json({ message: error.message, notConfirmed: true }, { status: 501 });
  }
  // 🔴 A PART-SENT WIPE IS THE SERVER'S FAILURE, NOT THE CALLER'S — 502, and it must be read BEFORE
  // the 400 branch below, because it is the same class with a flag.
  if (error instanceof HeadwindWipeError && error.partial) {
    return NextResponse.json({ message: error.message, partial: true }, { status: 502 });
  }
  if (
    error instanceof HeadwindCommandInputError ||
    error instanceof HeadwindAppInputError ||
    error instanceof HeadwindWipeError ||
    error instanceof HeadwindActionError ||
    error instanceof HeadwindConfigurationError ||
    error instanceof HeadwindDeviceNotFoundError ||
    error instanceof HeadwindEnrollmentError ||
    error instanceof HeadwindLocationError ||
    // 🔴 It was missing until 9 Nov 2026 (F15): a remote screen ID that is a sentence, or a tablet
    // nobody named, answered 500 — "the server broke" — for the person's own typo.
    error instanceof HeadwindRemoteScreenIdError ||
    error instanceof HeadwindUploadError ||
    error instanceof HeadwindUserError
  ) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }
  if (error instanceof HeadwindRequestError) {
    return NextResponse.json({ message: error.message }, { status: 502 });
  }
  return NextResponse.json({ message: error instanceof Error ? error.message : fallback }, { status: 500 });
}
