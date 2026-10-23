import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { clientSafeErrorMessage } from "../src/lib/http/api-errors.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A LOGIN THAT SUCCEEDS MUST LEAVE NO ERROR ROW BEHIND.
//
// `clientSafeErrorMessage` logs as a side effect: redacting an infrastructure error writes an
// `api_error_redacted` ERROR line and, through it, an `app_error_events` row. That is right when
// the error is on its way back to a caller and wrong when the caller is about to recover.
//
// app/api/auth/login/route.ts called it to DECIDE whether to repair the Supabase bridge, then
// repaired the bridge and signed the person in — so a successful login still left "Failed to
// create Supabase auth session" in the error table. Measured on production 2026-10-23: seven such
// rows between 11:20 and 12:58 Cairo, six real people (Mariam Younan, Hassan Elsherbiny, Mohamed
// Ahmed Hafez, Samir Saad, Maria Sobhy, Dina Hamdy), every matching login recorded success 68–242
// ms later. Not one person was kept out, and three of the rows cost an investigation apiece —
// in the one table used to judge whether production is healthy.
//
// Two halves are pinned: the option exists and really suppresses the log, and the login route
// decides whether to repair WITHOUT rendering a message at all, while still reporting where
// recovery fails.
//
// The second half moved on 23 Oct 2026. The first repair passed `{ report: false }` to the
// classifying call, which silenced the row; the follow-up found the classification was reading the
// REDACTED sentence — so it could never match GoTrue's words and the repair was skipped for every
// user who already had an identity. The decision now goes through
// `shouldRepairSupabaseAuthBridge`, which reads the raw message and renders nothing, so there is no
// classifying call left to silence. That is strictly stronger than the option, and the two tests
// would otherwise pin opposite shapes of the same line.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors supabase-js's AuthApiError closely enough for isInfrastructureError to classify it. */
function authApiError(message: string) {
  const error = new Error(message);
  error.name = "AuthApiError";
  return Object.assign(error, { code: "PGRST301", status: 400 });
}

function captureConsoleError(run: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

export function runLoginBridgeRepairLogsOnlyWhenItFailsTests() {
  const FALLBACK = "Failed to create Supabase auth session.";
  const error = authApiError("Invalid login credentials");

  // ── half one: the option suppresses the log and changes nothing else ──────
  let classified = "";
  const quiet = captureConsoleError(() => {
    classified = clientSafeErrorMessage(error, FALLBACK, { report: false });
  });

  assert.deepEqual(
    quiet,
    [],
    "classifying an error with { report: false } must write NO log line — the caller is about to recover from it, and the row it would leave outlives the recovery",
  );
  assert.equal(
    classified,
    FALLBACK,
    "{ report: false } suppresses the log only — the redaction itself is unchanged, so the real text still never reaches a caller",
  );

  // ── half two: the login route classifies without rendering a message at all ──
  const routePath = path.join(process.cwd(), "app", "api", "auth", "login", "route.ts");
  const source = stripComments(readFileSync(routePath, "utf8"));

  assert.ok(
    /const shouldRepairBridge = shouldRepairSupabaseAuthBridge\(/.test(source.replace(/\s+/g, " ")),
    "the login route's bridge decision must go through shouldRepairSupabaseAuthBridge — it reads the raw error and renders no message, so the classification cannot log a failure the login then recovers from",
  );
  assert.ok(
    !/clientSafeErrorMessage\([^)]*\{\s*report:\s*false\s*\}\s*\)/.test(source.replace(/\s+/g, " ")),
    "no call in the login route may classify through clientSafeErrorMessage again, silenced or not — redaction throws GoTrue's words away, which is what skipped the repair for every user who already had an identity",
  );

  // The branch that gives up without repairing is a real failure and must still be reported.
  assert.ok(
    /supabaseBridgeWarning = clientSafeErrorMessage\(\s*error,\s*"Failed to create Supabase auth session\.",?\s*\)/.test(
      source.replace(/\s+/g, " "),
    ),
    "when no repair is attempted the login route must still report — suppressing the log everywhere would hide a genuine bridge failure instead of a recovered one",
  );

  // And the two paths where recovery itself fails keep their own reporting calls.
  assert.ok(
    source.includes("Failed to create Supabase auth session after bridge repair."),
    "a repair that runs and still cannot mint a session must stay reported — that one is a real failure",
  );
  assert.ok(
    source.includes("Failed to repair Supabase auth bridge."),
    "a repair that throws must stay reported",
  );
}
