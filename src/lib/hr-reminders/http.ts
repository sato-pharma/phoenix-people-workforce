// HR Reminders — one place that turns a thrown error into the response a person should read.
//
// The routes keep their own guard calls inline (the access-registry coverage test reads each method
// block for a literal `assertPermission(access, "hr_reminders", "<action>")`); only the catch is
// shared, so the three route files cannot drift apart on what a refusal sounds like.

import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isReminderServiceError } from "@/lib/hr-reminders/service";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export function reminderErrorResponse(error: unknown, fallback: string): NextResponse {
  if (isApiRateLimitError(error)) {
    return NextResponse.json(
      { error: "rate_limited", message: "You are going a little fast. Wait a moment and try again.", retryAfterSeconds: error.retryAfterSeconds },
      { status: 429 },
    );
  }
  if (isReminderServiceError(error)) {
    return NextResponse.json({ message: error.message }, { status: error.status });
  }
  if (isForbiddenError(error)) {
    return NextResponse.json({ message: (error as Error).message }, { status: 403 });
  }
  return NextResponse.json({ message: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}
