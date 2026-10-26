import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { SessionVerificationUnavailableError } from "../src/lib/auth/session-lifecycle.ts";
import {
  isSessionVerificationUnavailableDigest,
  nextSessionCheckRetryDelay,
  SESSION_CHECK_RETRY_WINDOW_MS,
  SESSION_VERIFICATION_UNAVAILABLE_DIGEST,
} from "../src/lib/auth/session-unavailable-digest.ts";
import { reportClientError } from "../src/lib/error-monitor/report-client-error.ts";
import { isRedactedServerRenderError } from "../src/lib/error-monitor/redacted-server-render.ts";

/**
 * A page whose sign-in check could not reach the database shows a calm "retrying" state, not a
 * crash card, and the browser does not file it a second time.
 *
 * Measured 25 Oct 2026, 16:14–16:15 Cairo: the production database restarted, `resolveSessionState`
 * threw `SessionVerificationUnavailableError` from the page render for three Medical Representatives
 * on Employee 360 and Field CRM, and the browser received only React's redacted "Minified React
 * error #441". The portal drew "Employee portal unavailable" and one person filed 8 crash rows that
 * said nothing but "#441" — the same pattern as every #441 on Milestones and Field CRM in the 14
 * days before.
 */
export async function runSessionUnavailableCrashScreenTests() {
  // 1. The server error carries the fixed digest, the only part of it a production browser receives.
  const thrown = new SessionVerificationUnavailableError();
  assert.equal(
    (thrown as unknown as { digest?: string }).digest,
    SESSION_VERIFICATION_UNAVAILABLE_DIGEST,
    "SessionVerificationUnavailableError must carry the fixed digest — without it the browser sees only #441 and draws a crash card",
  );
  assert.equal(isSessionVerificationUnavailableDigest(thrown), true);

  // 2. Next.js keeps a digest the thrown error already has, and returns it as what the browser gets.
  //    Read from the installed Next, so an upgrade that starts re-hashing it fails here, not in production.
  const require = createRequire(import.meta.url);
  const { createReactServerErrorHandler } = require("next/dist/server/app-render/create-error-handler.js") as {
    createReactServerErrorHandler: (
      shouldFormatError: boolean,
      isBuildTimePrerendering: boolean,
      reactServerErrors: Map<string, Error>,
      onReactServerRenderError: (error: Error, silenceLog: boolean) => void,
    ) => (thrownValue: unknown) => string | undefined;
  };
  const reported: Error[] = [];
  const onError = createReactServerErrorHandler(false, false, new Map(), (error) => reported.push(error));
  assert.equal(
    onError(new SessionVerificationUnavailableError()),
    SESSION_VERIFICATION_UNAVAILABLE_DIGEST,
    "Next must hand the browser this digest unchanged",
  );
  assert.equal(reported.length, 1, "the server must still record the real error through onRequestError");
  assert.equal(reported[0].message, "Session verification is temporarily unavailable.");
  assert.notEqual(
    onError(new Error("Some other render failure")),
    SESSION_VERIFICATION_UNAVAILABLE_DIGEST,
    "only this error may wear the digest",
  );

  // 3. What the browser's boundary receives is recognised; any other #441 is not.
  const browserCopy = Object.assign(new Error("Minified React error #441; visit https://react.dev/errors/441"), {
    digest: SESSION_VERIFICATION_UNAVAILABLE_DIGEST,
  });
  assert.equal(isSessionVerificationUnavailableDigest(browserCopy), true);
  assert.equal(
    isSessionVerificationUnavailableDigest(Object.assign(new Error("Minified React error #441"), { digest: "1635479752" })),
    false,
    "a #441 from any other server failure is still a crash and must still be reported",
  );
  assert.equal(isSessionVerificationUnavailableDigest(null), false);
  assert.equal(isSessionVerificationUnavailableDigest("PHX_SESSION_VERIFICATION_UNAVAILABLE"), false);

  // 4. The browser does not file it again; every other error still goes out.
  const originalFetch = globalThis.fetch;
  const posted: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    posted.push(String(init?.body ?? ""));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    reportClientError({ digest: browserCopy.digest, error: browserCopy, route: "/employee-portals/employee-360" });
    assert.equal(posted.length, 0, "a sign-in check the database could not answer must not be filed as a browser crash");
    reportClientError({ digest: SESSION_VERIFICATION_UNAVAILABLE_DIGEST, error: "opaque", route: "/x" });
    assert.equal(posted.length, 0, "the digest alone is enough to recognise it");
    reportClientError({ digest: "1635479752", error: new Error("Minified React error #441"), route: "/employee-portals/milestones" });
    assert.equal(posted.length, 1, "any other server-render failure is still reported");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 5. The card retries by itself on a backing-off schedule, and stops after ten minutes.
  const t0 = 1_000_000;
  let step = nextSessionCheckRetryDelay(null, t0);
  assert.equal(step.delayMs, 3_000, "the first retry comes after three seconds");
  const delays: Array<number | null> = [step.delayMs];
  let now = t0;
  for (let i = 0; i < 6; i += 1) {
    now += step.delayMs ?? 0;
    step = nextSessionCheckRetryDelay(step.run, now);
    delays.push(step.delayMs);
  }
  assert.deepEqual(delays, [3_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
  while (step.delayMs !== null) {
    now += step.delayMs;
    step = nextSessionCheckRetryDelay(step.run, now);
  }
  assert.ok(now - t0 >= SESSION_CHECK_RETRY_WINDOW_MS, "automatic retries stop only after the ten-minute window");
  assert.ok(now - t0 < SESSION_CHECK_RETRY_WINDOW_MS + 30_000);
  assert.equal(
    nextSessionCheckRetryDelay(step.run, now + 2 * 60_000).delayMs,
    3_000,
    "a later outage, after two quiet minutes, starts a fresh run",
  );

  // 6. The shared card renders the calm state and skips the report; the portal leaves the retry to it.
  const card = readFileSync(new URL("../src/components/ui/route-error-state.tsx", import.meta.url), "utf8");
  assert.match(card, /if \(error && !sessionCheckUnavailable\) \{\s*reportClientError/);
  assert.match(card, /We could not confirm your sign-in just now/);
  assert.match(card, /You are still signed in/);
  const portal = readFileSync(new URL("../app/employee-portals/error.tsx", import.meta.url), "utf8");
  assert.match(portal, /if \(isSessionVerificationUnavailableDigest\(error\)\) return;/);

  // 7. Sentry's browser forwarder recognises the redacted copy in the spelling browsers really send.
  assert.equal(
    isRedactedServerRenderError(
      "Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment",
    ),
    true,
    "the minified wording is what every #441 row in the error table carries",
  );
  assert.equal(isRedactedServerRenderError("An error occurred in the Server Components render. The specific message is omitted"), true);
  assert.equal(isRedactedServerRenderError("Minified React error #418"), false, "a hydration mismatch is a real browser error");
  assert.equal(isRedactedServerRenderError("Minified React error #4410"), false);
}
