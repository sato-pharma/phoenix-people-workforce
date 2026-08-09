import { NextResponse } from "next/server";

import { notificationConfigWarnings } from "@/lib/observability/config-drift";
import { getDeployRevision } from "@/lib/observability/deploy-identity";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { auditWorkflowRegistryModules } from "@/lib/workflow-registry/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

// Readiness probe: verifies the process can actually serve requests — required config is
// present AND Supabase is reachable with a cheap head query. Returns 503 (not ready) when
// a dependency is down so orchestration/uptime checks can react. Public + unauthenticated,
// but it returns only booleans/status — never data or secret values. Not called per user
// request, so a light DB ping is acceptable.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PHOENIX_AUTH_SECRET",
];

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
    // Cheap connectivity check: HEAD count on a small system table (no rows returned).
    const { error } = await getSupabaseAdmin({ requestTimeoutMs: 4000 })
      .from("app_error_events")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (error) {
      databaseError = error.message;
    } else {
      databaseOk = true;
    }
  } catch (error) {
    databaseError = clientSafeErrorMessage(error, "supabase unreachable");
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
  let skippedModules: Array<{ moduleKey: string; reason: string }> = [];
  let registryCheckError: string | null = null;
  try {
    ({ skipped: skippedModules } = await auditWorkflowRegistryModules());
    if (skippedModules.length > 0) {
      logWarning("Workflow registry modules failed validation and are being skipped", {
        labels: { event: "workflow_registry_modules_skipped", count: String(skippedModules.length) },
        context: { skipped: skippedModules },
      });
    }
  } catch (error) {
    registryCheckError = clientSafeErrorMessage(error, "registry unreadable");
  }

  const ready = missingEnv.length === 0 && databaseOk;
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      checks: {
        env: missingEnv.length === 0,
        // Only the NAMES of any missing vars — never values.
        missingEnv,
        database: databaseOk,
        databaseError: databaseOk ? null : databaseError,
          // A skipped module reads to users as a MISSING one. Naming it here turns a silent
          // outage into a one-request diagnosis.
        workflowRegistry: skippedModules.length === 0 && !registryCheckError,
        skippedWorkflowModules: skippedModules,
        registryCheckError,
      },
      // Non-fatal notification-config drift (email flag / Resend key unset in prod). Present
      // so an operator or synthetic monitor can catch a silent-email regression early.
      warnings,
      revision: getDeployRevision(),
      time: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
