// scripts/lib/owner-ops-fence.ts
// ---------------------------------------------------------------------------
// THE DRY RUN OF scripts/owner-ops.ts IS THE APP'S OWN "RUNS FULLY, SAVES NOTHING" FENCE.
//
// The test-account fence (src/lib/auth/test-dry-run.ts, owner 2026-11-06) already answers every
// write a request makes without sending it: a PostgREST insert/update/delete is answered as PostgREST
// would answer it, a VOLATILE database function runs inside phx_test_dry_run_rpc and is rolled back,
// storage writes and every e-mail, Telegram, push or WhatsApp call are answered "done" and never sent.
// Reads pass untouched. Reusing it means a dry run here goes through the SAME domain function, with
// every check and refusal the real save has — so a dry run that passes is a write that would pass —
// instead of a hand-written "what I think it would do".
//
// 🔴 INSTALL IT BEFORE ANY DOMAIN MODULE IS IMPORTED. The runner imports the domain code dynamically
// after this, so even a module that captured `fetch` at import time captures the fenced one. Here the
// fence is told "this is a dry run" for every call — there is no request to mark.
// ---------------------------------------------------------------------------

import { testDryRunFetch } from "../../src/lib/auth/test-dry-run.ts";

export type FencedWrite = { method: string; target: string; detail: string };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const OWNER_OPS_FENCE = Symbol.for("phoenix.ownerOps.dryRunFence");
const DETAIL_MAX = 400;

/**
 * 🔴 THE TABLET SERVER'S SIGN-IN IS A POST THAT CHANGES NOTHING, AND FENCING IT MADE EVERY TABLET
 * JOB'S DRY RUN BLIND. `POST /rest/public/jwt/login` mints the session token every Headwind read then
 * carries (`src/lib/devices/headwind/auth.ts`), so with it fenced the dry run of a tablet job cannot
 * even LIST the fleet: it fails at the sign-in and reports a credential fault that is not there.
 * A dry run that cannot read is worse than no dry run — it says "could not reach the tablet server"
 * about a server that is up, which is exactly the sentence that gets a real `--apply` run instead.
 *
 * So this ONE path passes through as the read it is. It is matched by its exact pathname, never by
 * host or by prefix: every other POST or PUT to the tablet server — a configuration, a version row, a
 * push to a device — stays fenced and listed, which is the whole point of the dry run.
 */
const PASS_THROUGH_PATHS = new Set(["/rest/public/jwt/login"]);

function passesThroughAsRead(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (methodOf(input, init) !== "POST") return false;
  const url = urlOf(input);
  return !!url && PASS_THROUGH_PATHS.has(url.pathname);
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function urlOf(input: RequestInfo | URL): URL | null {
  try {
    return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return null;
  }
}

function clip(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)} [+${text.length - DETAIL_MAX} characters]` : text;
}

/** One line saying what a write would have done, for the dry run's list. */
export function describeFencedWrite(input: RequestInfo | URL, init?: RequestInit): FencedWrite {
  const method = methodOf(input, init);
  const url = urlOf(input);
  const body = typeof init?.body === "string" ? init.body : "";
  if (!url) return { method, target: "(unreadable address)", detail: clip(body) };
  const rest = /^\/rest\/v1\/(.+)$/.exec(url.pathname);
  if (rest) {
    const rpc = /^rpc\/(.+)$/.exec(rest[1]!);
    // A function call is a POST whether it reads or writes: the fence lets a STABLE one through as the
    // read it is, and runs a VOLATILE one inside phx_test_dry_run_rpc and rolls it back.
    if (rpc) return { method: "RPC", target: rpc[1]!, detail: clip(`a read passes, a write is rolled back; args ${body}`) };
    const filters = [...url.searchParams.entries()]
      .filter(([key]) => key !== "select" && key !== "columns")
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    return { method, target: rest[1]!, detail: clip([filters && `where ${filters}`, body].filter(Boolean).join("  ")) };
  }
  if (url.pathname.startsWith("/storage/v1/")) return { method, target: `storage ${url.pathname.slice(12)}`, detail: "" };
  return { method, target: `${url.hostname}${url.pathname}`, detail: "not sent" };
}

/**
 * Wrap `globalThis.fetch` so every write is answered by the fence and recorded in `log`. Returns false
 * when it was already installed. `real` is the fetch it wraps (a stand-in in the test).
 */
export function installOwnerOpsDryRunFence(log: FencedWrite[], real: typeof fetch = globalThis.fetch): boolean {
  const current = globalThis.fetch as typeof fetch & Record<symbol, unknown>;
  if (current && current[OWNER_OPS_FENCE] === true) return false;
  const fenced = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (passesThroughAsRead(input, init)) return real(input as RequestInfo, init);
    if (!READ_METHODS.has(methodOf(input, init))) log.push(describeFencedWrite(input, init));
    return testDryRunFetch(input, init, real, async () => true);
  }) as typeof fetch & Record<symbol, unknown>;
  fenced[OWNER_OPS_FENCE] = true;
  globalThis.fetch = fenced;
  return true;
}
