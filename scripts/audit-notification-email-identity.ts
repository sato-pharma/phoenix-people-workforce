import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "audit-notification-email-identity",
  entry: import.meta.url,
  known: ["--allow-production-readonly"],
});

const productionRef = "ozucdzovmcqvepbozvqf";
const pageSize = 1000;

type JsonObject = Record<string, unknown>;

type EmployeeRow = {
  full_name?: string | null;
  hr_id?: string | null;
  work_email?: string | null;
};

type NotificationOutboxRow = {
  attempts?: number | null;
  created_at?: string | null;
  id: string;
  max_attempts?: number | null;
  next_attempt_at?: string | null;
  payload?: JsonObject | null;
  sent_at?: string | null;
  status?: string | null;
  updated_at?: string | null;
};

type NotificationDeliveryRow = {
  channel?: string | null;
  created_at?: string | null;
  id: string;
  last_error?: string | null;
  metadata?: JsonObject | null;
  recipient_hr_id?: string | null;
  recipient_user_id?: string | null;
  sent_at?: string | null;
  status?: string | null;
  updated_at?: string | null;
};

type NotificationEventRow = {
  created_at?: string | null;
  employee_hr_id?: string | null;
  event_type?: string | null;
  id: string;
  metadata?: JsonObject | null;
  module?: string | null;
  recipients?: string[] | null;
  status?: string | null;
  subject?: string | null;
  updated_at?: string | null;
};

type FindingKind =
  | "conflicting_metadata"
  | "missing_subject_identity"
  | "pending_unsafe_send"
  | "recipient_subject_mismatch";

type Finding = {
  createdAt?: string | null;
  employeeHrId?: string | null;
  id: string;
  kind: FindingKind;
  module?: string | null;
  recipientHrId?: string | null;
  source: "notification_deliveries" | "notification_events" | "notification_outbox";
  status?: string | null;
  summary: string;
};

const employeeSubjectWorkflowModules = new Set([
  "contract_renewal",
  "deductions",
  "excuse",
  "excuses",
  "leave",
  "marketing_requests",
  "outstation",
  "probation",
  "resignations",
  "support_requests",
  "vacation",
  "weekly_plans",
]);

function loadEnvFile(path: string) {
  try {
    const file = readFileSync(path, "utf8");
    for (const line of file.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const key = match[1];
      if (process.env[key]) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Environment can be supplied by the shell in CI.
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function hrId(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizedName(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function metricValue(payload: JsonObject | null | undefined, label: string) {
  const metrics = Array.isArray(payload?.metrics) ? payload?.metrics : [];
  const expected = label.trim().toLowerCase();
  const metric = metrics.find((item) => {
    if (!item || typeof item !== "object") return false;
    return text((item as JsonObject).label).toLowerCase() === expected;
  }) as JsonObject | undefined;
  return text(metric?.value);
}

function employeeMetric(payload: JsonObject | null | undefined) {
  const employee = metricValue(payload, "Employee");
  const match = employee.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return {
    hrId: hrId(match?.[2]),
    name: text(match?.[1] ?? employee.replace(/\s+\([^)]*\)\s*$/, "")),
  };
}

function moduleRequiresSubject(moduleName: unknown, payload?: JsonObject | null) {
  const moduleKey = text(moduleName).toLowerCase();
  return employeeSubjectWorkflowModules.has(moduleKey) || Boolean(employeeMetric(payload).hrId);
}

function classifyEmailPayload(input: {
  attempts?: number | null;
  createdAt?: string | null;
  id: string;
  maxAttempts?: number | null;
  payload: JsonObject | null | undefined;
  recipientHrId?: string | null;
  source: Finding["source"];
  status?: string | null;
}, employeeNames: Map<string, string>): Finding[] {
  const payload = input.payload ?? {};
  const findings: Finding[] = [];
  const moduleName = text(payload.module);
  const employee = hrId(payload.employeeHrId);
  const recipient = hrId(payload.recipientHrId) || hrId(input.recipientHrId) || null;
  const metric = employeeMetric(payload);
  const guard = text(payload.identityGuard);
  const source = text(payload.subjectHrIdSource);
  const requiresSubject = guard === "subject_required" || moduleRequiresSubject(moduleName, payload);
  const status = text(input.status).toLowerCase();
  const attempts = Number(input.attempts ?? 0);
  const maxAttempts = Number(input.maxAttempts ?? 5);
  const failedCanRetry = status === "failed" && attempts < maxAttempts;
  const pending = ["pending", "retrying", "processing"].includes(status) || failedCanRetry;

  if (text(payload.identityError)) {
    findings.push({
      createdAt: input.createdAt,
      employeeHrId: employee || null,
      id: input.id,
      kind: "conflicting_metadata",
      module: moduleName || null,
      recipientHrId: recipient,
      source: input.source,
      status: input.status,
      summary: `Payload has identityError: ${text(payload.identityError)}`,
    });
  }

  if (requiresSubject && !employee) {
    findings.push({
      createdAt: input.createdAt,
      employeeHrId: null,
      id: input.id,
      kind: "missing_subject_identity",
      module: moduleName || null,
      recipientHrId: recipient,
      source: input.source,
      status: input.status,
      summary: "Official employee-subject email has no subject employee HR ID.",
    });
  }

  if (employee && metric.hrId && employee !== metric.hrId) {
    findings.push({
      createdAt: input.createdAt,
      employeeHrId: employee,
      id: input.id,
      kind: "recipient_subject_mismatch",
      module: moduleName || null,
      recipientHrId: recipient,
      source: input.source,
      status: input.status,
      summary: `Payload employeeHrId ${employee} conflicts with Employee metric HR ID ${metric.hrId}.`,
    });
  }

  if (requiresSubject && source === "recipient.self") {
    findings.push({
      createdAt: input.createdAt,
      employeeHrId: employee || null,
      id: input.id,
      kind: "recipient_subject_mismatch",
      module: moduleName || null,
      recipientHrId: recipient,
      source: input.source,
      status: input.status,
      summary: "Official employee-subject email uses recipient.self as the subject source.",
    });
  }

  const directoryName = employee ? employeeNames.get(employee) : null;
  if (employee && !directoryName) {
    findings.push({
      createdAt: input.createdAt,
      employeeHrId: employee,
      id: input.id,
      kind: "conflicting_metadata",
      module: moduleName || null,
      recipientHrId: recipient,
      source: input.source,
      status: input.status,
      summary: `Subject employee HR ID ${employee} was not found in employees.`,
    });
  } else if (employee && metric.name && directoryName && normalizedName(metric.name) !== normalizedName(directoryName)) {
    findings.push({
      createdAt: input.createdAt,
      employeeHrId: employee,
      id: input.id,
      kind: "conflicting_metadata",
      module: moduleName || null,
      recipientHrId: recipient,
      source: input.source,
      status: input.status,
      summary: `Employee metric name "${metric.name}" does not match directory name "${directoryName}".`,
    });
  }

  if (pending && findings.length > 0) {
    findings.push({
      createdAt: input.createdAt,
      employeeHrId: employee || metric.hrId || null,
      id: input.id,
      kind: "pending_unsafe_send",
      module: moduleName || null,
      recipientHrId: recipient,
      source: input.source,
      status: input.status,
      summary: "Unsafe identity finding exists on a pending/retryable email payload.",
    });
  }

  return findings;
}

function classifyEvent(row: NotificationEventRow, employeeNames: Map<string, string>): Finding[] {
  const metadata = row.metadata ?? {};
  const moduleName = text(row.module);
  const subjectHrId =
    hrId(metadata.employeeHrId) ||
    hrId(metadata.subjectHrId) ||
    hrId(metadata.requestOwnerHrId);
  const requiresSubject = moduleRequiresSubject(moduleName);
  const findings: Finding[] = [];

  if (requiresSubject && !subjectHrId) {
    findings.push({
      createdAt: row.created_at,
      employeeHrId: null,
      id: row.id,
      kind: "missing_subject_identity",
      module: moduleName || null,
      recipientHrId: hrId(row.employee_hr_id) || null,
      source: "notification_events",
      status: row.status,
      summary: "Notification event metadata has no subject employee HR ID for an employee-subject workflow.",
    });
  }

  if (subjectHrId && !employeeNames.has(subjectHrId)) {
    findings.push({
      createdAt: row.created_at,
      employeeHrId: subjectHrId,
      id: row.id,
      kind: "conflicting_metadata",
      module: moduleName || null,
      recipientHrId: hrId(row.employee_hr_id) || null,
      source: "notification_events",
      status: row.status,
      summary: `Event subject HR ID ${subjectHrId} was not found in employees.`,
    });
  }

  return findings;
}

// `orderColumn` must be the table's unique key: an unordered offset walk over 100,000+ rows skips and repeats rows.
async function selectAll<T>(supabase: SupabaseClient, table: string, columns: string, orderColumn: string) {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderColumn, { ascending: true })
      .range(from, to);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function countByKind(findings: Finding[]) {
  return findings.reduce<Record<string, number>>((acc, finding) => {
    acc[finding.kind] = (acc[finding.kind] ?? 0) + 1;
    return acc;
  }, {});
}

async function main() {
  loadEnvFile(".env.local");
  if (!process.argv.includes("--allow-production-readonly")) {
    throw new Error("Refusing production audit without --allow-production-readonly.");
  }

  const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const configuredRef = process.env.SUPABASE_PROJECT_REF?.trim();
  if (!supabaseUrl.includes(productionRef) && configuredRef !== productionRef) {
    throw new Error(`Refusing audit because target is not Phoenix production ref ${productionRef}.`);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    global: { headers: { "x-phoenix-audit": "notification-email-identity-readonly" } },
  });

  const [employees, outboxRows, deliveryRows, eventRows] = await Promise.all([
    selectAll<EmployeeRow>(supabase, "employees", "hr_id,full_name,work_email", "hr_id"),
    selectAll<NotificationOutboxRow>(supabase, "notification_outbox", "id,status,attempts,max_attempts,next_attempt_at,payload,created_at,updated_at,sent_at", "id"),
    selectAll<NotificationDeliveryRow>(supabase, "notification_deliveries", "id,channel,status,recipient_hr_id,recipient_user_id,metadata,last_error,created_at,updated_at,sent_at", "id"),
    selectAll<NotificationEventRow>(supabase, "notification_events", "id,module,event_type,employee_hr_id,recipients,subject,status,metadata,created_at,updated_at", "id"),
  ]);

  const employeeNames = new Map(
    employees
      .map((employee) => [hrId(employee.hr_id), text(employee.full_name)] as const)
      .filter(([id, name]) => Boolean(id && name)),
  );

  const outboxFindings = outboxRows.flatMap((row) =>
    classifyEmailPayload({
      createdAt: row.created_at,
      attempts: row.attempts,
      id: row.id,
      maxAttempts: row.max_attempts,
      payload: row.payload,
      source: "notification_outbox",
      status: row.status,
    }, employeeNames),
  );
  const deliveryFindings = deliveryRows
    .filter((row) => row.channel === "email")
    .flatMap((row) =>
      classifyEmailPayload({
        createdAt: row.created_at,
        id: row.id,
        payload: row.metadata?.emailInput as JsonObject | null | undefined,
        recipientHrId: row.recipient_hr_id,
        source: "notification_deliveries",
        status: row.status,
      }, employeeNames),
    );
  const eventFindings = eventRows.flatMap((row) => classifyEvent(row, employeeNames));
  const findings = [...outboxFindings, ...deliveryFindings, ...eventFindings];
  const pendingUnsafe = findings.filter((finding) => finding.kind === "pending_unsafe_send");
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "read-only production notification email identity audit",
    productionRef,
    scanned: {
      employees: employees.length,
      notificationDeliveries: deliveryRows.length,
      notificationEvents: eventRows.length,
      notificationOutbox: outboxRows.length,
    },
    summary: {
      byKind: countByKind(findings),
      findings: findings.length,
      pendingUnsafe: pendingUnsafe.length,
    },
    findings,
  };

  mkdirSync("outputs", { recursive: true });
  const outputPath = `outputs/notification-email-identity-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    scanned: report.scanned,
    summary: report.summary,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
