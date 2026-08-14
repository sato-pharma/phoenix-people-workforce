/**
 * The error serializer that decides whether an app_error_events row is evidence or a shrug.
 *
 * Production holds 19 rows whose entire message is the literal string "[object Object]": 12 on
 * /api/admin/outstation/expenses (2026-08-12) and 7 on /api/auth/heartbeat (2026-07-17..07-28).
 * Every one of them was a real failure that can never now be diagnosed. The cause is one
 * expression — `String(error)` over a Supabase PostgrestError, which is a plain object and not an
 * Error, so it stringifies to the useless constant.
 *
 * The expenses route grew a private fix (#2062). instrumentation.ts — the app-wide onRequestError
 * catch-all sitting under EVERY route handler and server component — did not, which is where the
 * heartbeat rows came from. This pins the shared function and, separately, pins that every writer
 * actually calls it: a correct serializer nothing routes through fixes nothing.
 *
 * Three writers reach app_error_events — instrumentation.ts, the expenses route, and the browser's
 * report-client-error.ts. #2129 fixed the first two; the browser reporter was still stringifying
 * its own throws, so the same bug survived on the client path. All three are pinned below.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { describeThrown } from "../src/lib/error-monitor/describe-thrown.ts";

export function runDescribeThrownTests() {
  // ── The headline: the exact shape that produced the production rows ────────────────────────
  // supabase-js hands back a plain object, NOT an Error. This is the 42501 verbatim from
  // app_error_events, hint included — that hint is the whole diagnosis and must survive.
  const postgrestError = {
    code: "42501",
    details: null,
    hint: "Grant the required privileges to the current role with: GRANT SELECT ON public.expense_claims TO authenticated;",
    message: "permission denied for table expense_claims",
  };
  const described = describeThrown(postgrestError);

  assert.notEqual(described, "[object Object]", "a PostgrestError must never serialize to the constant that made 19 production rows undiagnosable");
  assert.match(described, /permission denied for table expense_claims/, "the real message is the point of capturing the row at all");
  assert.match(described, /42501/, "the Postgres code must survive — it is what identifies the failure class");
  assert.match(described, /GRANT SELECT ON public\.expense_claims TO authenticated/, "the hint carried its own fix; dropping it is how a 3.5-hour outage stays unexplained");

  // ── Errors keep the behavior the expenses route already shipped ────────────────────────────
  assert.equal(describeThrown(new Error("boom")), "boom", "an Error's .message IS the real message; nothing to reconstruct");

  // An Error with no message still has to say SOMETHING: /api/errors/client skips a falsy message
  // outright, so an empty string is not a poor row, it is a dropped one.
  assert.notEqual(describeThrown(new Error("")).trim(), "", "an empty message would be silently dropped before it is ever written");
  assert.equal(describeThrown(new TypeError("")), "TypeError", "falls back to the error's name, which still narrows the failure");

  // ── A cyclic throw must not turn one bad log line into a second failure ─────────────────────
  const cyclic: Record<string, unknown> = { code: "CYCLE", message: "self-referential" };
  cyclic.self = cyclic;
  const cyclicDescribed = describeThrown(cyclic);
  assert.notEqual(cyclicDescribed, "[object Object]", "the JSON.stringify guard must still produce real content, not fall back to the shrug");
  assert.match(cyclicDescribed, /self-referential/, "the message survives the cyclic fallback path");
  assert.match(cyclicDescribed, /CYCLE/, "so does the code");

  // ── Nothing may ever come back blank ───────────────────────────────────────────────────────
  // Every one of these is dropped or rewritten to "Unknown error" downstream if it returns empty.
  for (const [label, thrown] of [
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
    ["empty string", ""],
  ] as Array<[string, unknown]>) {
    const result = describeThrown(thrown);
    assert.equal(typeof result, "string", `${label} must still yield a string`);
    assert.notEqual(result.trim(), "", `${label} must not yield a blank message — a blank row is a lost row`);
  }

  assert.equal(describeThrown("plain string throw"), "plain string throw", "a thrown string is already the message");

  // ── The catch-all must actually route through it ───────────────────────────────────────────
  // instrumentation.ts is the net under every route. It held the broken `String(error)` version
  // while the expenses route had its own fix, so a serializer test alone would have gone green
  // across the entire window those heartbeat rows were being written.
  const instrumentation = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");

  assert.match(
    instrumentation,
    /import \{ describeThrown \} from "@\/lib\/error-monitor\/describe-thrown"/,
    "instrumentation.ts must use the shared serializer, not a private copy that can drift",
  );
  assert.match(instrumentation, /message: describeThrown\(error\)/, "the forwarded message must be the described throw");
  assert.doesNotMatch(
    instrumentation,
    /message:\s*error instanceof Error \? error\.message : String\(error\)/,
    "the String(error) forwarding bug must not come back — this is the exact expression that wrote the heartbeat rows",
  );

  // ── …and so must the browser's own reporter, the third writer ──────────────────────────────
  // Three code paths write into app_error_events: this one, instrumentation.ts, and the expenses
  // route. #2129 fixed the two server-side ones and left the client reporter still calling
  // String(error) — a serializer only helps the callers that actually reach it, so pin all three.
  const clientReporter = readFileSync(new URL("../src/lib/error-monitor/report-client-error.ts", import.meta.url), "utf8");

  assert.match(
    clientReporter,
    /import \{ describeThrown \} from "@\/lib\/error-monitor\/describe-thrown"/,
    "report-client-error.ts must use the shared serializer, not its own stringification",
  );
  assert.match(clientReporter, /const message = describeThrown\(error\)/, "the reported message must be the described throw");
  assert.doesNotMatch(
    clientReporter,
    /const message = error instanceof Error \? error\.message : String\(error\)/,
    "a browser throw is often a plain object; this expression is what turns it into '[object Object]'",
  );

  // The edge-safety constraint is load-bearing: instrumentation.ts is bundled for the Edge
  // Runtime, so the module it now imports must stay import-free or the edge build breaks.
  const serializer = readFileSync(new URL("../src/lib/error-monitor/describe-thrown.ts", import.meta.url), "utf8");
  const serializerImports = serializer.match(/^\s*import\s/gm) ?? [];
  assert.equal(serializerImports.length, 0, "describe-thrown.ts must import nothing — instrumentation.ts is bundled for the Edge Runtime");

  console.log("  describeThrown: PostgrestError keeps message/code/hint, never '[object Object]', never blank");
  console.log("  describeThrown: instrumentation.ts routes through it and stays import-free for the edge build");
  console.log("  describeThrown: the browser reporter routes through it too — all three writers pinned");
}
