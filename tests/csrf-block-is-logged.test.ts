import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertSameOriginMutation } from "../src/lib/security/api-csrf.ts";

const ROOT = process.cwd();

/** Runs `fn` with console.log captured, and returns the parsed structured lines it emitted. */
function capture(fn: () => void): Array<Record<string, unknown>> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => { lines.push(String(args[0])); };
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  try {
    fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines.flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

function post(origin: string | null): Request {
  const headers: Record<string, string> = { host: "phoenix-hr.satopharma.com" };
  if (origin) headers.origin = origin;
  return new Request("https://phoenix-hr.satopharma.com/api/employees?hrId=B-10&token=secret", {
    method: "POST",
    headers,
  });
}

/**
 * A cross-site refusal must SAY which origin it refused.
 *
 * WHY THIS EXISTS. Both CSRF guards returned a bare 403 and recorded nothing, anywhere. Not in the
 * app's own error events, which store a path and no host; not in the database, which has no origin,
 * referer or host column at all; and not in the deployment logs, which carry application output and
 * no HTTP access lines. So somebody whose every save was being refused produced no evidence of it —
 * reads worked, the app looked healthy, and the only way left to find out was to ask them what
 * their address bar said.
 *
 * That is what this fixes, and it is a property worth pinning: a security control that fires
 * silently cannot be diagnosed, and the silence is invisible precisely because nothing is wrong
 * from the inside.
 */
export function runCsrfBlockIsLoggedTests() {
  // ── 1. a refusal LOGS, and still refuses ─────────────────────────────────────────────────
  let response: unknown;
  const refused = capture(() => { response = assertSameOriginMutation(post("https://evil.example.com")); });
  assert.ok(response, "a cross-site mutation must still be refused");
  assert.equal((response as Response).status, 403);

  const entry = refused.find((row) => row.event === "csrf_failed");
  assert.ok(entry, "the refusal must emit a csrf_failed line — a silent 403 is the whole defect");

  // ── 2. it says WHY, not merely THAT ──────────────────────────────────────────────────────
  const context = entry.context as Record<string, unknown>;
  assert.equal(context.origin, "https://evil.example.com", "the refused origin is the whole point");
  assert.equal(context.host, "phoenix-hr.satopharma.com", "and the host it was refused against");
  assert.equal(context.method, "POST");
  assert.equal(context.path, "/api/employees");

  // ── 3. the QUERY STRING is never recorded ────────────────────────────────────────────────
  // The request above carries `?hrId=B-10&token=secret` deliberately. A log that took the whole
  // URL would write an identifier and a token into a line nobody treats as sensitive.
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes("token=secret"), "a query string must never reach the log");
  assert.ok(!serialized.includes("hrId=B-10"), "nor an identifier carried in the query");

  // ── 4. WARNING, never ERROR ──────────────────────────────────────────────────────────────
  // A genuine cross-site attempt is this guard working correctly. Logging it as an error would
  // page somebody every time the control does its job, and an alarm that cries wolf gets muted —
  // which would put us back where we started.
  assert.equal(entry.severity, "WARNING", "a working guard must not page anybody");

  // ── 5. a LEGITIMATE mutation logs NOTHING and is allowed ─────────────────────────────────
  // The negative control. Without it, a change that logged on every request would pass rules 1-4
  // while flooding the log — and a line that appears constantly is as useless as none.
  let allowed: unknown = "unset";
  const quiet = capture(() => { allowed = assertSameOriginMutation(post("https://phoenix-hr.satopharma.com")); });
  assert.equal(allowed, null, "a same-origin mutation must be allowed through");
  assert.equal(
    quiet.filter((row) => row.event === "csrf_failed").length,
    0,
    "an allowed mutation must log nothing at all",
  );

  // ── 6. the PROXY guard logs too, under its own event name ────────────────────────────────
  // Source-pinned because middleware cannot be invoked from here. Both sites are needed: the proxy
  // only guards `isSecurityProxyPath`, so a route outside that set is refused at the route and
  // nowhere else. Logging one and not the other leaves exactly the silent half.
  const proxy = readFileSync(join(ROOT, "proxy.ts"), "utf8");
  const logAt = proxy.indexOf('logStructured("WARNING", "Cross-site mutation blocked"');
  const returnAt = proxy.indexOf('{ error: "csrf_blocked"');
  assert.ok(logAt > 0, "the proxy refusal must log");
  assert.ok(returnAt > 0, "the proxy must still refuse");
  assert.ok(logAt < returnAt, "it must log BEFORE returning, or an early return skips the line");
  assert.match(proxy, /event: "csrf_blocked"/, "the proxy layer carries its own event name");
  assert.ok(
    !/nextUrl\.href|request\.url\b/.test(proxy.slice(logAt, returnAt)),
    "the proxy must log the pathname, never the full URL with its query string",
  );
}
