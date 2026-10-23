// Keeps the sockets to Supabase alive between requests.
//
// WHY. Phoenix makes ~8 PostgREST round trips per authenticated request (176,110 of them in a
// 118-minute production window, 2026-10-10), every one an HTTPS call from Railway
// (europe-west4, Netherlands) to Supabase (eu-central-1, Frankfurt). Measured the same day
// against the production endpoint, from one client, same origin:
//
//   fresh connection   TCP 59-67 ms  + TLS 82 ms  -> 212-290 ms total   (~3.2 x RTT)
//   reused connection  no handshake at all        ->  70- 82 ms total   (~1.1 x RTT)
//
// So a handshake costs about 2 extra RTT — roughly 20 ms on the Frankfurt hop — and Node's
// built-in fetch closes an idle socket after just 4 seconds (undici's default
// keepAliveTimeout). Raising that keeps the connection pool warm across the gaps between
// requests, which is the whole change.
//
// 🔴 THE POOL IS DELIBERATELY LEFT UNBOUNDED. Undici's default is `connections: null`, meaning
// unlimited sockets per origin, and bounding it would make requests QUEUE once the bound is
// reached. Phoenix's worst symptom is a 15-second stall tail (p99 14,875 ms), and a stalled
// request holds its socket for the full `supabaseRequestTimeoutMs` — so a bounded pool is
// exactly how a handful of stalls would become a queue for everyone. Extending the idle
// timeout has no such failure mode: it can only avoid handshakes, never add waiting.
//
// 🔴 NO `undici` DEPENDENCY, ON PURPOSE. `setGlobalDispatcher` lives in the npm package, which
// is not installed here (and cannot be added from a worktree — pnpm purges the node_modules
// junction, AGENTS.md §5). Node's built-in fetch stores its dispatcher on a well-known global
// symbol, so the Agent class is reachable through the instance Node already made. Verified on
// node v24.15.0: a fetch through the swapped dispatcher reaches Supabase normally.
//
// Whether it worked is not assumed — it is reported, logged by the caller, and visible in the
// `supabase.fetch` p50/p95 split that src/lib/supabase/server.ts records.

/** Where Node's built-in fetch keeps its dispatcher. Public by convention, not by API. */
const GLOBAL_DISPATCHER_SYMBOL = Symbol.for("undici.globalDispatcher.1");

/** Node's default is 4_000 ms, which is shorter than the gap between many of our requests. */
const KEEP_ALIVE_TIMEOUT_MS = 60_000;

/** Undici's own default. Set explicitly so the ceiling is visible beside the idle timeout. */
const KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;

export type KeepAlivePinResult =
  | { pinned: true; keepAliveTimeoutMs: number }
  | { pinned: false; reason: string };

let pinned: KeepAlivePinResult | null = null;

type DispatcherLike = { constructor?: unknown };

/**
 * Forces the lazy creation of Node's global dispatcher, without making an outbound call.
 *
 * Node builds the dispatcher on the FIRST fetch, so until something has fetched, the symbol
 * holds nothing. A connection to a closed local port fails immediately (ECONNREFUSED, measured
 * at 31 ms) and creates it. The timeout is belt-and-braces in case anything is listening there.
 */
async function ensureDispatcherExists(): Promise<void> {
  if ((globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER_SYMBOL]) return;
  try {
    // Loopback to a closed port on purpose: nothing leaves the machine, so there is no wire to secure.
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    await fetch("http://127.0.0.1:1/", { signal: AbortSignal.timeout(250) });
  } catch {
    // Expected — the point is the side effect, not the response.
  }
}

/**
 * Replaces Node's global fetch dispatcher with one that holds connections open.
 *
 * Never throws and never retries: on any unexpected shape it reports `pinned: false` with the
 * reason and leaves Node's own dispatcher in place, because a slower Phoenix is always better
 * than one that will not boot. Safe to call more than once — the first result is reused.
 */
export async function pinKeepAliveDispatcher(): Promise<KeepAlivePinResult> {
  if (pinned) return pinned;

  try {
    await ensureDispatcherExists();

    const globals = globalThis as Record<symbol, unknown>;
    const current = globals[GLOBAL_DISPATCHER_SYMBOL] as DispatcherLike | undefined;
    if (!current) {
      pinned = { pinned: false, reason: "no global dispatcher on globalThis" };
      return pinned;
    }

    const Agent = current.constructor as (new (options: Record<string, unknown>) => unknown) | undefined;
    if (typeof Agent !== "function") {
      pinned = { pinned: false, reason: "global dispatcher has no constructor" };
      return pinned;
    }

    globals[GLOBAL_DISPATCHER_SYMBOL] = new Agent({
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
    });

    pinned = { pinned: true, keepAliveTimeoutMs: KEEP_ALIVE_TIMEOUT_MS };
    return pinned;
  } catch (error) {
    pinned = { pinned: false, reason: error instanceof Error ? error.message : String(error) };
    return pinned;
  }
}

/** The pin's outcome, or null if it has not been attempted. For tests and the health line. */
export function keepAlivePinState(): KeepAlivePinResult | null {
  return pinned;
}
