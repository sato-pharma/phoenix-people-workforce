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
}
