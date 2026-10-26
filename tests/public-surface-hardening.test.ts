import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import type { SingleFlightEntry } from "../src/lib/crm/ttl-single-flight.ts";
import { callerMayReadEmailHealthDetail, publicEmailHealthBody } from "../src/lib/email/email-health-access.ts";
import {
  WORKFLOW_REGISTRY_AUDIT_TTL_MS,
  cachedWorkflowRegistryAudit,
  type WorkflowRegistryAudit,
} from "../src/lib/workflow-registry/audit-cache.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE PUBLIC, UNAUTHENTICATED SURFACE ANSWERS LESS AND COSTS LESS (26 Oct 2026 deep audit, lane D).
 *
 *  - /api/readyz no longer asks Postgres for an exact count of an append-only table on every poll,
 *    and reads the workflow registry at most once a minute — and never keeps a failed read.
 *  - No response carries `X-Powered-By: Next.js`.
 *  - /api/health/email tells an anonymous caller only { status, timestamp }; the full report (which
 *    mail variables are set, whether mail is diverted to the test inboxes, the provider chain) needs
 *    the cron secret or a signed-in system administrator.
 */

/** /api/readyz: a bounded existence read, and a registry audit cached on success only. */
export async function checkReadyzProbeLoad(): Promise<void> {
  const readyz = stripComments(readFileSync("app/api/readyz/route.ts", "utf8"));

  assert.doesNotMatch(
    readyz,
    /count:\s*["']exact["']/,
    "🔴 /api/readyz asks for an exact count again. The probe is public and polled through every deploy; an exact count makes Postgres count the whole app_error_events table per call. Read one id instead.",
  );
  assert.match(
    readyz,
    /\.from\("app_error_events"\)\s*\.select\("id"\)\s*\.limit\(1\)/,
    "the readiness DB ping must be a bounded existence read: select one id, limit 1",
  );
  assert.match(
    readyz,
    /withDeadline\(\s*cachedWorkflowRegistryAudit\(auditWorkflowRegistryModules\)/,
    "🔴 /api/readyz reads the workflow registry on every call again — it must go through cachedWorkflowRegistryAudit, still inside withDeadline",
  );

  // The cache itself, on an injected clock.
  const store = new Map<string, SingleFlightEntry<WorkflowRegistryAudit>>();
  let clock = 1_000;
  const now = () => clock;
  let loads = 0;
  let failNext = false;
  const load = async (): Promise<WorkflowRegistryAudit> => {
    loads += 1;
    if (failNext) {
      failNext = false;
      throw new Error("database restarting");
    }
    return { loaded: ["leave"], skipped: [] };
  };

  assert.equal(WORKFLOW_REGISTRY_AUDIT_TTL_MS, 60_000, "the registry audit is kept for one minute");

  await cachedWorkflowRegistryAudit(load, now, store);
  assert.equal(loads, 1, "the first probe reads the registry");

  clock += WORKFLOW_REGISTRY_AUDIT_TTL_MS - 1;
  await cachedWorkflowRegistryAudit(load, now, store);
  assert.equal(loads, 1, "🔴 a probe inside the minute must reuse the last successful audit, not re-read the table");

  clock += 1;
  await cachedWorkflowRegistryAudit(load, now, store);
  assert.equal(loads, 2, "a probe after the minute reads the registry again");

  // A failed read is never kept: the very next probe reads again, even inside the minute.
  clock += WORKFLOW_REGISTRY_AUDIT_TTL_MS;
  failNext = true;
  await assert.rejects(cachedWorkflowRegistryAudit(load, now, store), /database restarting/);
  assert.equal(loads, 3);
  const afterFailure = await cachedWorkflowRegistryAudit(load, now, store);
  assert.equal(loads, 4, "🔴 a failed registry read was kept — a cache never keeps a failed read");
  assert.deepEqual(afterFailure.loaded, ["leave"]);

  // Probes that arrive together share one read.
  clock += WORKFLOW_REGISTRY_AUDIT_TTL_MS;
  await Promise.all([
    cachedWorkflowRegistryAudit(load, now, store),
    cachedWorkflowRegistryAudit(load, now, store),
    cachedWorkflowRegistryAudit(load, now, store),
  ]);
  assert.equal(loads, 5, "concurrent probes share one registry read");
}

/** next.config.ts: no X-Powered-By header on any response. */
export function checkPoweredByHeaderOff(): void {
  const config = stripComments(readFileSync("next.config.ts", "utf8"));
  assert.match(
    config,
    /\bpoweredByHeader:\s*false\b/,
    "🔴 next.config.ts must set poweredByHeader: false — otherwise every response names the framework (X-Powered-By: Next.js)",
  );
}

/** /api/health/email: an anonymous caller gets the verdict only; the detail needs the cron secret or a Super Admin. */
export async function checkEmailHealthDetailGate(): Promise<void> {
  const guest = { role: "Employee", scope: "self" } as Pick<AccessContext, "role" | "scope">;
  const superAdmin = { role: "Super Admin", scope: "system" } as Pick<AccessContext, "role" | "scope">;
  const ceo = { role: "CEO", scope: "company" } as Pick<AccessContext, "role" | "scope">;

  let cronCalls = 0;
  const deps = (who: Pick<AccessContext, "role" | "scope">, cronOk = false) => ({
    cronAuthorized: () => {
      cronCalls += 1;
      return cronOk;
    },
    resolveAccess: async () => who,
  });
  const anonymous = new Request("https://phoenix.test/api/health/email");
  const withBearer = new Request("https://phoenix.test/api/health/email", { headers: { authorization: "Bearer x" } });

  assert.equal(await callerMayReadEmailHealthDetail(anonymous, deps(guest)), false, "🔴 an anonymous caller must not read the email health detail");
  assert.equal(cronCalls, 0, "an anonymous poll is not a cron call — the cron guard (which logs every refusal) is never asked");
  assert.equal(await callerMayReadEmailHealthDetail(withBearer, deps(guest, true)), true, "the cron secret reads the detail");
  assert.equal(await callerMayReadEmailHealthDetail(withBearer, deps(guest, false)), false, "🔴 a wrong bearer reads nothing");
  assert.equal(await callerMayReadEmailHealthDetail(anonymous, deps(superAdmin)), true, "a signed-in Super Admin reads the detail");
  assert.equal(await callerMayReadEmailHealthDetail(anonymous, deps(ceo)), false, "🔴 only a system administrator reads the detail, not every senior role");
  assert.equal(
    await callerMayReadEmailHealthDetail(anonymous, {
      cronAuthorized: () => false,
      resolveAccess: async () => {
        throw new Error("Forbidden: session revoked");
      },
    }),
    false,
    "a session that cannot be resolved is not an administrator",
  );

  const leaky = {
    checks: [{ name: "RESEND_API_KEY", present: false }],
    forceTesting: true,
    status: "degraded",
    timestamp: "2026-10-26T10:00:00.000Z",
  };
  assert.deepEqual(
    Object.keys(publicEmailHealthBody(leaky)).sort(),
    ["status", "timestamp"],
    "🔴 the anonymous answer carries status and timestamp and nothing else",
  );

  const route = stripComments(readFileSync("app/api/health/email/route.ts", "utf8"));
  assert.match(route, /export async function GET\(request: Request\)/, "the route reads the request to decide who is asking");
  assert.match(
    route,
    /callerMayReadEmailHealthDetail\(request, \{\s*cronAuthorized: \(req\) => assertCronAuthorized\(req, "health\/email"\) === null,\s*resolveAccess: resolveAccessContext,\s*\}\)/,
    "🔴 the detail is gated on the shared cron guard or the caller's resolved session",
  );
  assert.match(
    route,
    /if \(!detail\) \{\s*return NextResponse\.json\(publicEmailHealthBody\(\{ status, timestamp \}\), init\);\s*\}/,
    "🔴 a caller without the detail right gets the public body before any detail reaches a response",
  );
  assert.match(route, /status: degraded \? 503 : 200/, "every caller keeps the 200 / 503 a monitor polls for");
  assert.match(route, /"cache-control": "no-store"/, "no cache keeps an administrator's full report for the next caller");
}

export async function runPublicSurfaceHardeningTests(): Promise<void> {
  await checkReadyzProbeLoad();
  checkPoweredByHeaderOff();
  await checkEmailHealthDetailGate();
}
