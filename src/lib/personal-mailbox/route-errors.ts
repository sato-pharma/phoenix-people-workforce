// Personal mailbox — the ONE catch block for its routes, modeled on the compliance monitor's
// (src/lib/mailbox-monitor/route-errors.ts): expected refusals go back as-is and are not recorded;
// a mail server that stopped answering, a database error or anything unclassified is recorded in
// the error monitor, so a broken mailbox is visible on the server and not only in one browser.
//
// What is recorded is the failure, never the mail: no subject, address list, body or attachment
// ever reaches logAppError from here — only the thrown error's own description.

import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { logAppError } from "@/lib/error-monitor/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { PersonalMailboxError } from "@/lib/personal-mailbox/rules";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

const MODULE_KEY = "personal_mailbox";
const MODULE_LABEL = "My email";

export async function personalMailboxErrorResponse(input: {
  access: AccessContext | null;
  error: unknown;
  fallbackMessage: string;
  request: Request;
  /** A LITERAL route template, so recurring failures group under one signature. */
  route: string;
}): Promise<NextResponse> {
  const { access, error, fallbackMessage, request, route } = input;

  if (isApiRateLimitError(error)) {
    return NextResponse.json(
      {
        message: "Too many tries in a minute — wait a moment and try again.",
        retryAfterSeconds: (error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 60,
      },
      { status: 429 },
    );
  }
  if (error instanceof PersonalMailboxError && !error.diagnostic) {
    return NextResponse.json({ message: error.message }, { status: error.statusCode });
  }

  const status = error instanceof PersonalMailboxError ? error.statusCode : 500;
  await logAppError({
    hrId: access?.hrId ?? null,
    loginId: access?.loginId ?? null,
    message: describeThrown(error),
    moduleKey: MODULE_KEY,
    moduleLabel: MODULE_LABEL,
    role: access?.role ?? null,
    route,
    routeType: "route-handler",
    source: "server",
    stack: error instanceof Error ? error.stack ?? null : null,
    userAgent: request.headers.get("user-agent"),
  }).catch(() => {
    // The response below must always go out, whatever the logger does.
  });

  return NextResponse.json(
    {
      message: error instanceof PersonalMailboxError ? error.message : clientSafeErrorMessage(error, fallbackMessage),
    },
    { status },
  );
}
