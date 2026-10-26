import { NextResponse } from "next/server";

import { notificationConfigWarnings } from "@/lib/observability/config-drift";
import { getDeployRevision } from "@/lib/observability/deploy-identity";
import { readUrgentDeployRevision } from "@/lib/observability/urgent-deploy-marker";
import { logWarning } from "@/lib/observability/log";
import { evaluateReleaseGate, type ReleaseGateDecision } from "@/lib/platform/release-gate";
import { releaseGateHasRecord } from "@/lib/platform/release-gate-store";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cachedWorkflowRegistryAudit } from "@/lib/workflow-registry/audit-cache";
import { auditWorkflowRegistryModules } from "@/lib/workflow-registry/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

// Readiness probe: verifies the process can actually serve requests — required config is
// present AND Supabase is reachable with a one-row existence read. Returns 503 (not ready) when
// a dependency is down so orchestration/uptime checks can react. Public + unauthenticated,
// so it returns only booleans/status — never data, error text or variable names. Not called per user
// request, so a light DB ping is acceptable.
//
// 🔴 THIS IS RAILWAY'S DEPLOY HEALTHCHECK SINCE 2026-09-30 (`railway.json`, `healthcheckPath`), SO
// ITS WALL CLOCK IS NOW LOAD-BEARING. Before that it was only ever read by a human, and nothing
// bounded it: the DB ping is capped at 4s, but the workflow-registry audit below had no cap at all —
// it inherited the admin client's 15s default AND that client's transient-PGRST002 retry (3 attempts
// with 200/400/800ms sleeps), so a worst case ran well past a minute. A probe that can outlast the
// platform's own healthcheck window fails the deploy for a reason that has nothing to do with the
// deploy. Every dependency call in here is therefore bounded, and the registry audit is bounded as a
// WHOLE (`withDeadline`) rather than per fetch, because a per-fetch cap is multiplied by the retries.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PHOENIX_AUTH_SECRET",
];

/** How long the whole registry audit gets before the probe gives up on it and answers anyway. */
const REGISTRY_AUDIT_DEADLINE_MS = 4000;

/**
 * Resolve `work`, or reject once `ms` has passed — whichever happens first.
 *
 * Deliberately bounds TOTAL time rather than each attempt: the admin client retries a transient
 * PGRST002 three times with backoff, so a 4s per-request timeout still permits ~14s of wall clock.
 * The timer is cleared on both paths so a settled probe never holds the event loop open.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  const warnings = notificationConfigWarnings();
  // Only when there IS drift — keeps healthy readiness checks silent, makes drift loud/alertable.
  if (warnings.length > 0) {
    logWarning("Notification config drift detected on readiness check", {
      labels: { event: "config_drift" },
      context: { warnings },
    });
  }

  let databaseOk = false;
  let databaseError: string | null = null;
  try {
    // Cheap connectivity check: read at most ONE id. Never `count: "exact"` — this address is public
    // and polled through every deploy, and an exact count makes Postgres count the whole table on
    // every call (a full scan of an append-only error log) just to prove the database answers.
    const { error } = await getSupabaseAdmin({ requestTimeoutMs: 4000 })
      .from("app_error_events")
      .select("id")
      .limit(1);
    if (error) {
      databaseError = error.message;
    } else {
      databaseOk = true;
    }
  } catch (error) {
    databaseError = clientSafeErrorMessage(error, "supabase unreachable");
  }

  // THE RELEASE GATE (docs/deployment.md, "The release gate"). A production container is not ready until CI
  // has recorded that every required check passed on ITS commit, so Railway can build while the checks run
  // and still keep the old version serving until they pass. Anywhere that is not production on Railway this
  // is `required: false` and always passes. Bounded like every other dependency here: a gate that cannot be
  // read in time is the closed answer, never a hung probe.
  let releaseGate: ReleaseGateDecision;
  try {
    releaseGate = await withDeadline(
      evaluateReleaseGate({
        env: process.env,
        urgentRevision: readUrgentDeployRevision(),
        hasRecord: releaseGateHasRecord,
      }),
      4000,
      "release gate",
    );
  } catch {
    releaseGate = { required: true, passed: false, reason: "unreadable", sha: null };
  }

  // Which workflow modules the loader cannot load.
  //
  // An invalid module is SKIPPED — one bad row must not break every other module's transitions —
  // but that presents to users as "module is missing or inactive" with no visible signal. On
  // 2026-08-05 the direct_orders row declared 6 statuses while 5 of its actions referenced `held`
  // and `expired`; every rep trying to submit was refused, including plain `submit`, and the only
  // trace was a log line. It surfaced when a user complained. This makes it a one-request check.
  //
  // Deliberately does NOT flip readiness to 503: one broken module does not stop the process
  // serving, and cycling the container would fix nothing while taking the rest of the app down.
  //
  // A SUCCESSFUL audit is reused for a minute (`cachedWorkflowRegistryAudit`), a failed one never is:
  // the probe is public and polled through every deploy, and a module row only changes on an admin edit.
  let skippedModules: Array<{ moduleKey: string; reason: string }> = [];
  let registryCheckError: string | null = null;
  try {
    ({ skipped: skippedModules } = await withDeadline(
      cachedWorkflowRegistryAudit(auditWorkflowRegistryModules),
      REGISTRY_AUDIT_DEADLINE_MS,
      "workflow registry audit",
    ));
    if (skippedModules.length > 0) {
      logWarning("Workflow registry modules failed validation and are being skipped", {
        labels: { event: "workflow_registry_modules_skipped", count: String(skippedModules.length) },
        context: { skipped: skippedModules },
      });
    }
  } catch (error) {
    registryCheckError = clientSafeErrorMessage(error, "registry unreadable");
  }

  const ready = missingEnv.length === 0 && databaseOk && releaseGate.passed;
  const workflowRegistryOk = skippedModules.length === 0 && !registryCheckError;

  // 🔴 THE PUBLIC ANSWER IS BOOLEANS ONLY (23 Oct 2026 audit, Pass 5). This route is unauthenticated and
  // used to return the raw database and registry error text, the NAMES of missing environment
  // variables, the skipped workflow modules with their reasons and the notification-config warnings.
  // None of that is a secret value, but all of it is a map of the inside for anyone who asks. The
  // detail now goes to the server log (only when something is wrong), where an operator reads it; the
  // probe answers yes or no per dependency. The release gate keeps its fixed reason code (a closed list
  // in release-gate.ts, never error text), because the deploy runbooks read it.
  // A release gate that is merely waiting for CI is not logged: Railway polls this probe through the
  // whole wait, and the config warnings and skipped modules are already logged above.
  if (missingEnv.length > 0 || !databaseOk || registryCheckError) {
    logWarning("Readiness probe found a problem", {
      labels: { event: "readyz_not_clean", ready: String(ready) },
      context: { databaseError: databaseOk ? null : databaseError, missingEnv, registryCheckError },
    });
  }

  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      checks: {
        // `passed` is false only while CI has not released this commit (or could not be asked).
        releaseGate: { required: releaseGate.required, passed: releaseGate.passed, reason: releaseGate.reason },
        env: missingEnv.length === 0,
        database: databaseOk,
        // A skipped module reads to users as a MISSING one; the names are in the server log.
        workflowRegistry: workflowRegistryOk,
        // Non-fatal notification-config drift (email flag / Resend key unset in prod); the detail is logged.
        notificationConfig: warnings.length === 0,
      },
      // An urgent `railway up` deploy carries no git sha; it names itself in public/urgent-deploy.json,
      // which only an urgent upload ever contains, so it wins whenever it is there.
      revision: readUrgentDeployRevision() ?? getDeployRevision(),
      time: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
