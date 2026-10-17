import assert from "node:assert/strict";

import { getSupabaseAdmin } from "../src/lib/supabase/server.ts";

/**
 * Two ways a Supabase blip used to freeze a page, both measured on production 2026-10-10.
 *
 * ── 1. A TIMEOUT WAS RETRIED FOUR TIMES, SO ONE STALLED READ COST ABOUT A MINUTE ──────────────
 * `fetchWithTimeout` aborts an attempt at `supabaseRequestTimeoutMs` (15s) and used to rethrow it
 * as a plain `new Error("Supabase request timed out.")`. postgrest-js wraps every request in its
 * own `executeWithRetry`, whose first guard is `if (fetchError?.name === "AbortError") throw` — a
 * deliberate refusal to retry a request that already spent its whole budget. A plain Error is named
 * "Error", so that guard missed and the SDK took its NETWORK-error path instead: 3 more attempts
 * for a GET at 1s/2s/4s backoff. 4 × 15s + 7s ≈ 67 seconds for one `.select()`, measured here as
 * four fetch attempts. The message is unchanged — `isSupabaseTimeout` matches the words "timed
 * out" and the heartbeat's 503 branch depends on it — only the name is restored.
 *
 * ── 2. A CLOUDFLARE 521 WAS NEVER RETRIED AT ALL ──────────────────────────────────────────────
 * The hosted endpoint sits behind Cloudflare, and when it stops answering the edge serves its own
 * HTML page: 521 "Web server is down", 525 "SSL handshake failed". Our wrapper retried exactly one
 * thing, a PostgREST `PGRST002` body, and looked for it behind a `content-type: application/json`
 * check that `text/html` can never satisfy — so the page fell past it and became a broken screen.
 * The SDK does not cover the gap either: its `RETRYABLE_STATUS_CODES` is `[520, 503]` only.
 * Production served 15 "Web server is down" and 6 "unknown error" pages on 10-07 across nine
 * unrelated routes, and 2 more plus an SSL handshake failure inside the 11:03–11:17 Cairo window —
 * while the Railway container sat at 1% of 24 vCPU and the database at 3 active connections of 200.
 * Neither end was busy; the path between them was not answering.
 *
 * ── WHAT IS DELIBERATELY NOT DONE, each pinned below ──────────────────────────────────────────
 *   - 520 and 503 are NOT in our set: the SDK already retries them, and our wrapper sits inside its
 *     loop, so covering a status twice means 3 attempts here then 3 again outside, each re-entering
 *     this wrapper — 16 attempts for one read.
 *   - A WRITE is never retried on a gateway 5xx: a 521 says nothing about whether PostgREST already
 *     applied the row, so a retry could apply it twice. PGRST002 is the opposite case (PostgREST
 *     could not reach Postgres, so nothing ran) and keeps its all-method retry.
 *   - A genuine PostgREST error is returned at once, never retried.
 *
 * `.retry(false)` is used wherever the point is OUR wrapper's own behaviour: it switches the SDK's
 * loop off so the attempt count belongs to this layer alone.
 */
export async function runSupabaseGatewayRetryTests() {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const realFetch = globalThis.fetch;

  /** Each stubbed reply in order; the last repeats once the list runs out. */
  function stubFetch(replies: Array<() => Response>) {
    const methods: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method =
        (typeof init?.method === "string" && init.method) ||
        (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
      methods.push(method.toUpperCase());
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls += 1;
      return reply();
    }) as typeof globalThis.fetch;
    return {
      get calls() {
        return calls;
      },
      methods,
    };
  }

  const edgePage = (status: number) => () =>
    new Response(`<html><head><title>${status}: edge</title></head><body>${status}</body></html>`, {
      status,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  const okEmptyRows = () =>
    new Response("[]", { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  const pgrst002 = () =>
    new Response(JSON.stringify({ code: "PGRST002", message: "Could not query the database. Retrying." }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const realPostgrestError = () =>
    new Response(JSON.stringify({ code: "42P01", message: "relation does not exist" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  /** A fresh client each time: the memo is keyed on URL + key, so a new URL rebuilds it. */
  let clientSeq = 0;
  function freshAdminClient() {
    clientSeq += 1;
    process.env.NEXT_PUBLIC_SUPABASE_URL = `https://gateway-retry-${clientSeq}.example.supabase.co`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-gateway-retry";
    return getSupabaseAdmin();
  }

  try {
    // ── 1. HEADLINE: a timeout is attempted ONCE, with the SDK's own retry left switched on ────
    {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        const abort = new Error("The operation was aborted.");
        abort.name = "AbortError";
        throw abort;
      }) as typeof globalThis.fetch;
      const realLog = console.log;
      const logged: string[] = [];
      console.log = (line?: unknown) => {
        logged.push(String(line));
      };
      const { error } = await (async () => {
        try {
          return await freshAdminClient().from("employees").select("hr_id").eq("hr_id", "B-10").limit(1);
        } finally {
          console.log = realLog;
        }
      })();
      assert.equal(
        calls,
        1,
        "a timed-out Supabase read must be attempted ONCE — rethrowing the abort as a plain Error "
          + "defeated postgrest-js's `name === \"AbortError\"` guard and bought 3 more attempts at "
          + "the full 15s budget plus 1s/2s/4s backoff, about 67 seconds of frozen page per hang",
      );
      assert.ok(error, "the timeout must still surface to the caller");
      assert.match(
        String((error as { message?: string } | null)?.message ?? ""),
        /timed out/i,
        "the message must still say \"timed out\" — isSupabaseTimeout matches those words and the "
          + "heartbeat's 503 branch depends on it",
      );

      // The timeout also names itself in the log: which table, never the filter that rode in the query string.
      const timeoutLines = logged.filter((line) => line.includes('"event":"supabase_timeout"'));
      assert.equal(timeoutLines.length, 1, "one timed-out call writes exactly one supabase_timeout line");
      const entry = JSON.parse(timeoutLines[0] as string) as { severity: string; context: { method: string; path: string; uptimeS: number } };
      assert.equal(entry.severity, "WARNING", "WARNING, so it never writes an error row of its own");
      assert.equal(entry.context.method, "GET");
      assert.equal(entry.context.path, "/rest/v1/employees", "the table is named");
      assert.ok(Number.isFinite(entry.context.uptimeS), "the process age is recorded");
      assert.ok(!timeoutLines[0]?.includes("B-10"), "a filter value never reaches the log");
    }

    // ── 2. HEADLINE: a Cloudflare 521 on a read IS retried by this wrapper ─────────────────────
    {
      const stub = stubFetch([edgePage(521), okEmptyRows]);
      const { error } = await freshAdminClient().from("employees").select("hr_id").limit(1).retry(false);
      assert.equal(
        stub.calls,
        2,
        "a Cloudflare 521 on a READ must be retried — it is text/html, so it could never satisfy "
          + "the application/json check the only retry sat behind, and the SDK's own list is "
          + "[520, 503], so nothing anywhere retried the status production actually served",
      );
      assert.equal(error, null, "the retry's successful answer must be the one handed back");
    }

    // ── 3. The rest of the gap the SDK leaves unretried ────────────────────────────────────────
    for (const status of [525, 502, 504, 522]) {
      const stub = stubFetch([edgePage(status), okEmptyRows]);
      const { error } = await freshAdminClient().from("employees").select("hr_id").limit(1).retry(false);
      assert.equal(stub.calls, 2, `a ${status} from the edge on a read must be retried like the 521`);
      assert.equal(error, null, `a ${status} must not survive as an error once the retry succeeds`);
    }

    // ── 4. 520 and 503 are LEFT TO THE SDK — covering them twice costs 16 attempts ─────────────
    for (const status of [520, 503]) {
      const stub = stubFetch([edgePage(status), okEmptyRows]);
      await freshAdminClient().from("employees").select("hr_id").limit(1).retry(false);
      assert.equal(
        stub.calls,
        1,
        `a ${status} must NOT be retried by this wrapper: postgrest-js already retries it `
          + "(RETRYABLE_STATUS_CODES = [520, 503]) and this wrapper sits INSIDE that loop, so "
          + "retrying it in both places means 3 attempts here then 3 again outside, each "
          + "re-entering this wrapper — 16 attempts for one read",
      );
    }

    // ── 5. A WRITE is never retried on a gateway 5xx — it may already have been applied ────────
    {
      const stub = stubFetch([edgePage(521), okEmptyRows]);
      await freshAdminClient().from("employees").insert({ hr_id: "B-TEST-GATEWAY" });
      assert.equal(
        stub.calls,
        1,
        "a WRITE must NOT be retried on a gateway 5xx: the edge answering 521 carries no evidence "
          + "about whether PostgREST already applied the row, so a retry could apply it twice",
      );
      assert.deepEqual(stub.methods, ["POST"], "the insert must have gone out as a POST");
    }

    // ── 6. PGRST002 keeps its existing retry (nothing ran, so it is safe) ──────────────────────
    {
      const stub = stubFetch([pgrst002, okEmptyRows]);
      const { error } = await freshAdminClient().from("employees").select("hr_id").limit(1).retry(false);
      assert.equal(stub.calls, 2, "the pre-existing PGRST002 retry must still fire");
      assert.equal(error, null, "a PGRST002 followed by success must read as success");
    }

    // ── 7. A genuine error is returned at once — the retry must not hide real faults ───────────
    {
      const stub = stubFetch([realPostgrestError]);
      const { error } = await freshAdminClient().from("employees").select("hr_id").limit(1).retry(false);
      assert.equal(
        stub.calls,
        1,
        "a genuine PostgREST error must NOT be retried — retrying real faults hides them and "
          + "multiplies the wait",
      );
      assert.ok(error, "the caller must still receive the real error");
    }
  } finally {
    globalThis.fetch = realFetch;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
}
