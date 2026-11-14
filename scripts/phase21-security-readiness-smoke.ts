import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

loadLocalEnv();

const checks: Array<{ details?: unknown; label: string; ok: boolean }> = [];
const warnings: string[] = [];

const criticalTables = [
  "app_auth_users",
  "role_permission_overrides",
  "user_access_profiles",
  "employees",
  "employee_compensation",
  "employee_locations",
  "position_vacancies",
  "job_offers",
  "job_offer_audit_logs",
  "audit_logs",
  "salary_batches",
  "salary_records",
  "outstation_expenses",
  "outstation_expense_reports",
  // The phase-2 expense projection. It carries the same employee expense data as the two tables
  // above (claimed/approved totals, HR IDs, trip destinations), so it belongs in this sweep even
  // though nothing writes to it directly — phx_refresh_expense_claims rebuilds it from them.
  "expense_claims",
  "sales_import_batches",
  "sales_records",
  "employee_resignations",
  "employee_probation",
  "probation_evaluations",
  "probation_history",
  "employee_contracts",
  "contract_renewal_requests",
  "contract_renewal_history",
  "v2_vacation_requests",
  "v2_vacation_request_events",
  "outstation_expense_requests",
  "outstation_location_audit_logs",
  "hiring_document_definitions",
  "hiring_document_statuses",
  "hiring_document_employee_notes",
  "email_templates",
  "email_template_recipient_rules",
  "email_delivery_events",
];

const intentionallyPublicMutationRoutes = [
  "app/api/auth/login/route.ts",
  "app/api/auth/logout/route.ts",
  "app/api/auth/password-setup/[token]/route.ts",
  "app/api/offers/[offerRef]/accept/route.ts",
  "app/api/offers/[offerRef]/reject/route.ts",
  "app/api/webhooks/resend/route.ts",
];

function loadLocalEnv() {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Environment variables may be injected by the runner.
  }
}

function addCheck(label: string, ok: boolean, details?: unknown) {
  checks.push({ details, label, ok });
  if (!ok) throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
}

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

function readSource(path: string) {
  return readFileSync(path, "utf8");
}

function listFiles(root: string, predicate: (path: string) => boolean) {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const fullPath = join(dir, name);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (name === ".next" || name === "node_modules") continue;
        walk(fullPath);
      } else if (predicate(fullPath.replace(/\\/g, "/"))) {
        files.push(fullPath.replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  return files;
}

const mutationMethods = ["POST", "PUT", "PATCH", "DELETE"] as const;

function routeExportsMethod(source: string, method: typeof mutationMethods[number]) {
  return new RegExp(`export\\s+async\\s+function\\s+${method}\\b`).test(source);
}

function methodIsExplicitlyUnsupported(source: string, method: typeof mutationMethods[number]) {
  return new RegExp(
    `export\\s+async\\s+function\\s+${method}\\b[\\s\\S]{0,900}(unsupported_method|status:\\s*405)`,
  ).test(source);
}

function routeHasMutation(source: string) {
  return mutationMethods.some(
    (method) => routeExportsMethod(source, method) && !methodIsExplicitlyUnsupported(source, method),
  );
}

function routeHasGuard(source: string) {
  return /resolveAccessContext|requireCoachingPermission|requireCoachingManagementPermission|isAuthorized|isCronAuthorized|verifyResendSignature|verifyPasswordSetupToken|verifySessionToken|decideOffer/.test(source);
}

function routeIsPublic(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return intentionallyPublicMutationRoutes.some((route) => normalized.endsWith(route));
}

function staticRouteAudit() {
  const routeFiles = listFiles("app/api", (path) => path.endsWith("/route.ts"));
  const mutationRoutes = routeFiles
    .map((path) => ({ path, source: readSource(path) }))
    .filter((route) => routeHasMutation(route.source));

  const unguarded = mutationRoutes.filter((route) => !routeIsPublic(route.path) && !routeHasGuard(route.source));
  addCheck("all non-public mutation routes resolve auth or explicit authorization", unguarded.length === 0, unguarded.map((route) => route.path));

  const probationDecision = readSource("app/api/probation/cases/[caseId]/decision/route.ts");
  const bulkAction = readSource("app/api/admin/users/bulk-action/route.ts");
  const notificationTest = readSource("app/api/notifications/test/route.ts");
  const emailReplySend = readSource("app/api/admin/email-reply/send/route.ts");

  addCheck("probation case decision route uses the permission matrix and the decision authority", /assertPermission\(access, "probation", "read"\)/.test(probationDecision) && /decideProbation\(access, caseId,/.test(probationDecision));
  addCheck("bulk access mutation requires authenticated user admin update permission", /Authentication is required/.test(bulkAction) && /assertPermission\(access, "user_admin", "update"\)/.test(bulkAction));
  addCheck("notification test email requires admin update permission", /assertPermission\(access, "admin", "update"\)/.test(notificationTest));
  addCheck("HR reply email send requires communication update permission", /assertPermission\(access, "communication", "update"\)/.test(emailReplySend));
}

function serviceRoleBoundaryAudit() {
  const clientFacingFiles = [
    ...listFiles("src/components", (path) => /\.(ts|tsx)$/.test(path)),
    ...listFiles("app", (path) => /\.(tsx)$/.test(path)),
  ];
  const exposed = clientFacingFiles
    .filter((path) => {
      const source = readSource(path);
      return /getSupabaseAdmin|SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey/.test(source) && /"use client"|'use client'/.test(source);
    });

  addCheck("service-role key is not imported into client components", exposed.length === 0, exposed);
  const supabaseServer = readSource("src/lib/supabase/server.ts");
  addCheck("service-role client is server-only helper and never NEXT_PUBLIC", /SUPABASE_SERVICE_ROLE_KEY/.test(supabaseServer) && !/NEXT_PUBLIC_SUPABASE_SERVICE/.test(supabaseServer));
}

async function databaseSecurityAudit() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    warnings.push("SUPABASE_DB_URL is missing; skipped live RLS posture audit.");
    return;
  }

  const sql = postgres(dbUrl, { max: 1, prepare: false });
  try {
    const tableRows = await sql<{
      relforcerowsecurity: boolean;
      relname: string;
      relrowsecurity: boolean;
    }[]>`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and c.relname = any(${criticalTables})
      order by c.relname
    `;

    // Check presence FIRST. A table that no longer exists is simply absent from the row set above,
    // not an error, so every check that follows would pass vacuously for it. That is how
    // payroll_expenses stayed green here for a month after 20260713120000 renamed it away (#2074).
    const absentTables = criticalTables.filter((table) => !tableRows.some((row) => row.relname === table));
    addCheck("every critical table in the list still exists", absentTables.length === 0, {
      absentTables,
      expected: criticalTables.length,
      found: tableRows.length,
    });

    const missingRls = tableRows.filter((row) => !row.relrowsecurity).map((row) => row.relname);
    addCheck("critical public tables have RLS enabled", missingRls.length === 0, { missingRls, checked: tableRows.length });

    const anonGrants = await sql<{
      grantee: string;
      privilege_type: string;
      table_name: string;
    }[]>`
      select grantee, table_name, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee = 'anon'
        and table_name = any(${criticalTables})
      order by table_name, privilege_type
    `;
    addCheck("critical tables do not grant direct anon privileges", anonGrants.length === 0, anonGrants);

    const exposedSecurityDefiners = await sql<{
      args: string;
      authenticated_can_execute: boolean;
      name: string;
      public_can_execute: boolean;
    }[]>`
      select
        p.proname as name,
        pg_get_function_identity_arguments(p.oid) as args,
        has_function_privilege('public', p.oid, 'execute') as public_can_execute,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and (
          p.proname like 'phx_%'
          or p.proname like '%employee%'
          or p.proname like '%payroll%'
          or p.proname like '%salary%'
          or p.proname like '%offer%'
          or p.proname like '%vacancy%'
        )
      order by p.proname
    `;
    const unsafeDefiners = exposedSecurityDefiners.filter((fn) => {
      if (fn.public_can_execute) return true;
      if (fn.name.startsWith("current_access_")) return false;
      return fn.authenticated_can_execute;
    });
    addCheck("sensitive SECURITY DEFINER functions are not executable by public/authenticated roles", unsafeDefiners.length === 0, unsafeDefiners);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  staticRouteAudit();
  serviceRoleBoundaryAudit();
  await databaseSecurityAudit();

  console.log(JSON.stringify({
    checks,
    policy: {
      auth: "All non-public mutations must resolve Phoenix access context and enforce permission/resource checks or explicit signed-token/cron authorization.",
      rls: "Critical public tables must keep RLS enabled; direct anon grants are blocked for sensitive business tables.",
      serviceRole: "Service-role usage remains server-only and is guarded by API/page permission checks.",
    },
    warnings,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: message(error), warnings }, null, 2));
  process.exitCode = 1;
});
