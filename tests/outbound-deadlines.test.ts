import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

import { __testables } from "../src/lib/google-maps/server.ts";
import { stripComments } from "./support/comment-strip.ts";

// Every outbound call to Google carries a deadline. A rep's Phoenix CRM save awaits a reverse
// geocode, and the public apply form awaits reCAPTCHA — an unbounded hang on Google's side held
// both requests open with nothing to end them.

const FILES = ["src/lib/google-maps/server.ts", "src/lib/security/recaptcha.ts"] as const;

function read(path: string) {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

/** The full text of every `fetch(...)` call in `source`, parentheses balanced. */
function fetchCalls(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(/\bfetch\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(match.index, end + 1));
  }
  return calls;
}

async function listenAndHangUp() {
  // Accepts the connection and drops it at once, so the node:https fallback fails fast and offline.
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  return { port: address.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export async function runOutboundDeadlinesTests() {
  // --- every fetch in both files is bounded ----------------------------------------------------
  for (const path of FILES) {
    const calls = fetchCalls(read(path));
    assert.ok(calls.length > 0, `${path}: expected at least one fetch( call to check`);
    for (const call of calls) {
      assert.ok(
        call.includes("signal:"),
        `${path}: every fetch( must carry a signal: deadline — this one has none:\n${call}`,
      );
    }
  }

  const maps = read("src/lib/google-maps/server.ts");
  assert.match(
    maps,
    /const GOOGLE_MAPS_TIMEOUT_MS = \d+;/,
    "google-maps/server.ts must define GOOGLE_MAPS_TIMEOUT_MS",
  );

  // --- the node:https fallback has its own deadline, and a timeout never reaches it ------------
  const fallbackStart = maps.indexOf("async function postJsonWithHttpsFallback");
  const fallbackEnd = maps.indexOf("function getServerKey", fallbackStart);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart, "expected postJsonWithHttpsFallback to exist");
  const fallback = maps.slice(fallbackStart, fallbackEnd);
  assert.match(
    fallback,
    /req\.setTimeout\(GOOGLE_MAPS_TIMEOUT_MS,/,
    "the node:https fallback request must call req.setTimeout(GOOGLE_MAPS_TIMEOUT_MS, ...)",
  );
  assert.match(
    fallback,
    /req\.destroy\(Object\.assign\(new Error\([^)]*\), \{ name: "TimeoutError" \}\)\)/,
    "the node:https deadline must be named TimeoutError, or the route ladder reads it as a rejection and asks three more times",
  );
  const rethrowAt = fallback.indexOf("if (isTimeoutAbort(error)) throw error;");
  const httpsAt = fallback.indexOf('import("node:https")');
  assert.ok(
    rethrowAt > 0 && rethrowAt < httpsAt,
    "the catch must rethrow a timeout BEFORE importing node:https, or a slow Google costs the wait twice",
  );

  const recaptcha = read("src/lib/security/recaptcha.ts");
  assert.match(
    recaptcha,
    /signal: AbortSignal\.timeout\(RECAPTCHA_TIMEOUT_MS\)/,
    "the siteverify fetch must be bounded by RECAPTCHA_TIMEOUT_MS",
  );

  // --- behaviour: a timeout is rethrown untouched; any other fetch failure still falls back ----
  const realFetch = globalThis.fetch;
  const server = await listenAndHangUp();
  const url = `https://127.0.0.1:${server.port}/v1/test`;
  const init = { body: "{}", headers: { "Content-Type": "application/json" }, method: "POST" as const };
  try {
    for (const name of ["TimeoutError", "AbortError"]) {
      const deadline = new DOMException("deadline", name);
      let sawSignal = false;
      globalThis.fetch = (async (_input: unknown, options?: RequestInit) => {
        sawSignal = options?.signal instanceof AbortSignal;
        throw deadline;
      }) as typeof fetch;
      await assert.rejects(
        __testables.postJsonWithHttpsFallback(url, init),
        (error) => {
          assert.equal(
            error,
            deadline,
            `a ${name} must be rethrown as-is, never handed to the node:https fallback (got ${String(error)})`,
          );
          return true;
        },
      );
      assert.ok(sawSignal, "postJsonWithHttpsFallback must pass an AbortSignal to fetch");
    }

    const connectFailure = new TypeError("fetch failed");
    globalThis.fetch = (async () => {
      throw connectFailure;
    }) as typeof fetch;
    await assert.rejects(__testables.postJsonWithHttpsFallback(url, init), (error) => {
      assert.notEqual(
        error,
        connectFailure,
        "a non-timeout fetch failure must still fall back to node:https (it reached the hang-up server)",
      );
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }

  // --- the route ladder: a rejection tries the simpler variants, a deadline stops at once ---------
  // Four variants each bounded by 8 s held an outstation request ~32 s when Google stopped answering.
  const realKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  process.env.GOOGLE_MAPS_SERVER_KEY = "test-key";
  const origin = { lat: 30.04, lng: 31.23 };
  const destination = { lat: 31.2, lng: 29.91 };
  try {
    for (const deadline of [new DOMException("deadline", "TimeoutError"), Object.assign(new Error("Google Maps request timed out"), { name: "TimeoutError" })]) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        throw deadline;
      }) as typeof fetch;
      await assert.rejects(__testables.computeRoutes(origin, destination), (error) => {
        assert.equal(error, deadline, "a timed-out route lookup must surface the timeout itself");
        return true;
      });
      assert.equal(calls, 1, `a route lookup that times out must not try the other variants (made ${calls} calls)`);
    }

    // Google REJECTS the first three asks and answers the fourth: the ladder still climbs to it.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 4) return new Response('{"error":{"status":"INVALID_ARGUMENT"}}', { status: 400 });
      return new Response(JSON.stringify({ routes: [{ distanceMeters: 220_000, duration: "9000s", staticDuration: "8800s" }] }), { status: 200 });
    }) as typeof fetch;
    const answered = await __testables.computeRoutes(origin, destination);
    assert.equal(calls, 4, "a rejected request must still fall through every simpler variant");
    assert.equal(answered.distanceMeters, 220_000, "the variant that answered must be the one returned");

    // Every variant rejected: the FIRST error is the one thrown, as before the change.
    calls = 0;
    const statuses = [403, 400, 400, 400];
    globalThis.fetch = (async () => {
      const status = statuses[calls] ?? 400;
      calls += 1;
      return new Response("{}", { status });
    }) as typeof fetch;
    const errors: string[] = [];
    await assert.rejects(__testables.computeRoutes(origin, destination), (error) => {
      errors.push(String(error));
      return true;
    });
    assert.equal(calls, 4, "with no deadline involved every variant is still tried");
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    await assert.rejects(__testables.computeRoutes(origin, destination), (error) => {
      assert.equal(String(error), errors[0], "when every variant fails, the first variant's error must be the one thrown");
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_MAPS_SERVER_KEY;
    else process.env.GOOGLE_MAPS_SERVER_KEY = realKey;
  }
}
