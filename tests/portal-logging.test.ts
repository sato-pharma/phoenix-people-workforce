import assert from "node:assert/strict";

import { logPortalFailure } from "../src/lib/observability/portal-logging.ts";

type ConsoleErrorArgs = unknown[];

/**
 * Runs `fn` with console.error replaced by a capturing stub, returning every
 * captured call. console.error is always restored, even if `fn` throws.
 */
function captureConsoleError(fn: () => void): ConsoleErrorArgs[] {
  const calls: ConsoleErrorArgs[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return calls;
}

/** Pulls the single JSON payload string out of a captured console.error call. */
function parseEmittedPayload(calls: ConsoleErrorArgs[]): Record<string, unknown> {
  assert.equal(calls.length, 1, "logPortalFailure should emit exactly one console.error call");
  const jsonArg = calls[0].find(
    (arg): arg is string => typeof arg === "string" && arg.trim().startsWith("{"),
  );
  assert.ok(jsonArg, "console.error call should include a JSON payload string");
  return JSON.parse(jsonArg) as Record<string, unknown>;
}

const baseContext = {
  route: "/employee-portals/sales",
  module: "sales",
  role: "Medical Rep",
  hrId: "MR-1",
};

export function runPortalLoggingTests() {
  // 1) Email addresses are scrubbed from the error message.
  {
    const payload = parseEmittedPayload(
      captureConsoleError(() =>
        logPortalFailure(baseContext, new Error("Lookup failed for user.name@example.com while loading")),
      ),
    );
    const message = String(payload.errorMessage);
    assert.doesNotMatch(message, /user\.name@example\.com/, "email address must be scrubbed");
    assert.match(message, /\[Filtered\]/, "scrubbed email should be replaced with the filtered marker");
  }

  // 2) JWT-shaped tokens are scrubbed.
  {
    const jwt = "abcdefghijklmnopqrstuvwx.0123456789ab.ZYXWVUT09876";
    const payload = parseEmittedPayload(
      captureConsoleError(() =>
        logPortalFailure(baseContext, new Error(`Token rejected: ${jwt}`)),
      ),
    );
    const message = String(payload.errorMessage);
    assert.doesNotMatch(message, /abcdefghijklmnopqrstuvwx/, "JWT token must be scrubbed");
    assert.match(message, /\[Filtered\]/, "scrubbed JWT should be replaced with the filtered marker");
  }

  // 3) Bearer / Basic auth values are scrubbed.
  {
    const bearerPayload = parseEmittedPayload(
      captureConsoleError(() =>
        logPortalFailure(baseContext, new Error("Upstream said: Bearer s3cr3tTokenValue123456")),
      ),
    );
    assert.doesNotMatch(
      String(bearerPayload.errorMessage),
      /s3cr3tTokenValue123456/,
      "Bearer auth value must be scrubbed",
    );

    const basicPayload = parseEmittedPayload(
      captureConsoleError(() =>
        logPortalFailure(baseContext, new Error("Auth header was Basic dXNlcjpwYXNzd29yZA")),
      ),
    );
    assert.doesNotMatch(
      String(basicPayload.errorMessage),
      /dXNlcjpwYXNzd29yZA/,
      "Basic auth value must be scrubbed",
    );
  }

  // 4) Never throws, even if console.error itself throws.
  {
    const original = console.error;
    console.error = () => {
      throw new Error("console.error blew up");
    };
    try {
      assert.doesNotThrow(
        () => logPortalFailure(baseContext, new Error("boom")),
        "logPortalFailure must not throw even when console.error throws",
      );
    } finally {
      console.error = original;
    }
  }

  // 5) Emits ONLY the safe fields — no extra keys leak through.
  {
    const payload = parseEmittedPayload(
      captureConsoleError(() =>
        logPortalFailure(baseContext, new Error("Forbidden: not allowed")),
      ),
    );
    const expectedKeys = [
      "event",
      "route",
      "module",
      "role",
      "hrId",
      "errorName",
      "errorMessage",
      "classification",
    ].sort();
    assert.deepEqual(
      Object.keys(payload).sort(),
      expectedKeys,
      "payload must contain only the safe diagnostic fields",
    );

    // Safe fields carry through unchanged; classification is a coarse bucket.
    assert.equal(payload.event, "employee_portal_failure");
    assert.equal(payload.route, baseContext.route);
    assert.equal(payload.module, baseContext.module);
    assert.equal(payload.role, baseContext.role);
    assert.equal(payload.hrId, baseContext.hrId);
    assert.equal(payload.errorName, "Error");
    assert.equal(payload.classification, "forbidden", "Forbidden errors classify as 'forbidden'");
  }

  // 6) Null role/hrId are preserved as null (not dropped, not stringified).
  {
    const payload = parseEmittedPayload(
      captureConsoleError(() =>
        logPortalFailure(
          { route: "/employee-portals", module: "shell", role: null, hrId: null },
          new Error("load failed"),
        ),
      ),
    );
    assert.equal(payload.role, null);
    assert.equal(payload.hrId, null);
    assert.equal(payload.classification, "error", "generic errors classify as 'error'");
  }
}
