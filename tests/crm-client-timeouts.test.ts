import assert from "node:assert/strict";

import { IReports360ApiError, iReports360GetVisits } from "../src/lib/crm/client.ts";
import type { IReports360Config } from "../src/lib/crm/config.ts";

/**
 * The iReports360 HTTP boundary's failure modes.
 *
 * Written after 2026-09-02, when the rolling 10-day CRM sync burned 301 seconds — past its own
 * route's 300s maxDuration — against a vendor that had answered 200 and then stalled the response
 * BODY. `IREPORTS360_TIMEOUT_MS` was 120000 at the time and bounded nothing, because the abort
 * timer was cleared in a `finally` around the `fetch()` await alone, and that await resolves as
 * soon as response HEADERS arrive. The body read that followed had no deadline at all.
 *
 * Two invariants are pinned here, and the first is the expensive one:
 *   1. the abort timer stays armed across the BODY read, and a body-phase abort is reported as a
 *      TIMEOUT rather than as a network blip or a shape change;
 *   2. an empty / non-JSON body is told apart from a well-formed body that lacks `data` — the two
 *      have different causes and different fixes, and conflating them sent a reader hunting a
 *      vendor API change that had never happened.
 */

const config: IReports360Config = {
  baseUrl: "https://crm.invalid",
  password: "test-password",
  // Deliberately tiny: the passing path must abort in well under the guard timer below.
  timeoutMs: 150,
  username: "test-user",
};

type FetchStub = (input: string, init: { signal: AbortSignal }) => Promise<Response>;

async function withFetch(stub: FetchStub, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A 200 whose headers have landed but whose body never finishes — the exact shape of the vendor
 * stall. `failWith` models what the runtime raises when the request is aborted mid-body: undici
 * does NOT raise an AbortError there, it raises `TypeError: terminated`, so both spellings are
 * exercised below.
 */
function stalledBody(signal: AbortSignal, failWith: () => Error): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(failWith()));
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" }, status: 200 });
}

/** Runs a visits fetch that must not hang, and returns whatever it threw. */
async function captureFailure(): Promise<unknown> {
  const outcome = await Promise.race([
    iReports360GetVisits(config, "token", "2026-08-23", "2026-09-02").then(
      () => "RESOLVED" as const,
      (error: unknown) => error,
    ),
    sleep(4000).then(() => "HUNG" as const),
  ]);
  assert.notEqual(
    outcome,
    "HUNG",
    "the abort timer must stay armed across the body read — clearing it once headers arrive is what let one run sit for 301s against a stalled vendor",
  );
  assert.notEqual(outcome, "RESOLVED", "a stalled body must fail, never resolve");
  return outcome;
}

export async function runCrmClientTimeoutsTests() {
  // 1. A body-phase abort that surfaces as an AbortError.
  await withFetch(
    async (_url, init) => stalledBody(init.signal, () => new DOMException("The operation was aborted.", "AbortError")),
    async () => {
      const error = await captureFailure();
      assert.ok(error instanceof IReports360ApiError, "a stalled body must raise the module's own error type");
      assert.equal(error.status, 504, "a timeout is 504, not the 502 a shape problem carries");
      assert.match(
        error.message,
        /timed out after 150ms/,
        "the timeout must name the budget it blew, so the fix is obvious without reading the code",
      );
    },
  );

  // 2. The SAME abort as the real runtime raises it. `TypeError: terminated` is what undici throws
  //    when a request is aborted mid-body, so keying the verdict off the error NAME would report
  //    our own timeout as a random network failure. The signal, not the name, is the authority.
  await withFetch(
    async (_url, init) => stalledBody(init.signal, () => new TypeError("terminated")),
    async () => {
      const error = await captureFailure();
      assert.ok(error instanceof IReports360ApiError);
      assert.equal(error.status, 504, "an aborted body read is a TIMEOUT even when undici spells it `TypeError: terminated`");
      assert.match(error.message, /timed out after 150ms/);
    },
  );

  // 3. An empty 200 body — a cut connection. Must NOT read as a response-shape change.
  await withFetch(
    async () => new Response("", { status: 200 }),
    async () => {
      const error = await iReports360GetVisits(config, "token", "2026-08-23", "2026-09-02").then(
        () => null,
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof IReports360ApiError);
      assert.match(
        error.message,
        /body was empty or was not JSON/,
        "an empty body is a transport failure; calling it a shape change sends the reader to the vendor's API docs for nothing",
      );
    },
  );

  // 4. A non-JSON 200 — the shared host's own HTML error page.
  await withFetch(
    async () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 200 }),
    async () => {
      const error = await iReports360GetVisits(config, "token", "2026-08-23", "2026-09-02").then(
        () => null,
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof IReports360ApiError);
      assert.match(error.message, /body was empty or was not JSON/, "an HTML error page is not a shape change either");
    },
  );

  // 5. Well-formed JSON that genuinely lacks `data` — this one IS the shape message.
  await withFetch(
    async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    async () => {
      const error = await iReports360GetVisits(config, "token", "2026-08-23", "2026-09-02").then(
        () => null,
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof IReports360ApiError);
      assert.match(error.message, /contained no `data` array/, "parseable JSON missing `data` is the real shape-change case");
      assert.equal(error.status, 502);
    },
  );

  // 6. `data: []` is a genuinely quiet day and must still succeed — the guard must never turn an
  //    empty CRM window into an error, which would page someone every weekend.
  await withFetch(
    async () => new Response(JSON.stringify({ data: [], success: true }), { status: 200 }),
    async () => {
      const visits = await iReports360GetVisits(config, "token", "2026-08-23", "2026-09-02");
      assert.deepEqual(visits, [], "an empty `data` array is a valid quiet window, not a failure");
    },
  );

  // 7. A healthy response still returns its rows — the guard must not be load-bearing on the happy
  //    path it protects.
  await withFetch(
    async () => new Response(JSON.stringify({ data: [{ id: 7, visitDate: "2026-09-02" }], success: true }), { status: 200 }),
    async () => {
      const visits = await iReports360GetVisits(config, "token", "2026-08-23", "2026-09-02");
      assert.equal(visits.length, 1);
      assert.equal(visits[0].id, 7);
    },
  );

  // 8. The vendor's own message still wins when it says the request failed, so the panel shows the
  //    CRM's words rather than ours.
  await withFetch(
    async () => new Response(JSON.stringify({ message: "Invalid date range.", success: false }), { status: 200 }),
    async () => {
      const error = await iReports360GetVisits(config, "token", "2026-08-23", "2026-09-02").then(
        () => null,
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof IReports360ApiError);
      assert.equal(error.message, "Invalid date range.", "the vendor's own message outranks our fallback text");
    },
  );
}
