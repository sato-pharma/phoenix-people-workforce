/**
 * One employee's change history, as the Employee Master's details panel shows it.
 *
 * THE SOURCES. Two append-only logs that database triggers fill on every write
 * (`.claude/rules/employees.md`): `v_employee_change_log` (the employee record) and
 * `v_employee_salary_change_log` (the compensation row). Nothing here writes either; this file only
 * turns their rows into lines a person can read.
 *
 * WHAT IT NEVER SHOWS.
 * - A value the log did not keep. The record log names salary figures and personal identifiers in
 *   `masked_fields` and stores neither value, so those fields read "changed, value not kept".
 * - Money to a viewer the Employee Master already withholds it from. `includeMoney: false` drops
 *   every pay field from the record log and the whole salary log, so a salary-blind seat does not
 *   even learn that a figure moved. The route decides it with the master's own rule.
 * - A code where a name exists. Manager, department, line, area, position and team arrive as ids
 *   and leave as names; an id the lookup could not resolve says so instead of printing a UUID.
 * - Plumbing. Timestamps the database stamps on every save are left out.
 *
 * HOW A WRITE ARRIVED. Since 19 Nov 2026 each row records its channel; older rows say so plainly.
 *
 * WHO MADE IT. The person's display name; when no person was named but a scheduled job was
 * (`actor_job`, since 20261119132416), "Scheduled job: <its name>"; only when neither, "No person
 * recorded".
 */

import { cairoDate, cairoDateTime } from "@/lib/format/cairo-datetime";
import { findDailyJob } from "@/lib/scheduled-jobs/daily-jobs";

/** One row of `v_employee_change_log`, as the route selects it. */
export type RecordChangeRow = {
  id: string;
  changed_at: string;
  change_kind: string | null;
  actor_login_id: string | null;
  actor_hr_id: string | null;
  /** The view's full name for the actor — the last resort, never ahead of the display name. */
  actor_name: string | null;
  actor_source: string | null;
  changed_fields: string[] | null;
  masked_fields: string[] | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  write_channel: string | null;
  /** The scheduled job that made the write when no person did (since 20261119132416). */
  actor_job?: string | null;
};

/** One row of `v_employee_salary_change_log`, as the route selects it. */
export type SalaryChangeRow = {
  id: string;
  changed_at: string;
  actor_login_id: string | null;
  /** Exposed on the view since 20261119111338; absent on a row read before it. */
  actor_hr_id?: string | null;
  actor_name: string | null;
  actor_source: string | null;
  changed_fields: string[] | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  write_channel: string | null;
  /** The scheduled job that made the write when no person did (since 20261119132416). */
  actor_job?: string | null;
};

export type ChangeHistoryField = {
  field: string;
  label: string;
  /** null = empty. Absent when `kept` is false. */
  before: string | null;
  after: string | null;
  /** false = the log recorded that the field changed and deliberately stored neither value. */
  kept: boolean;
};

export type ChangeHistoryEntry = {
  id: string;
  at: string;
  /** Pre-formatted in Cairo time, so server and browser print the same words. */
  atLabel: string;
  log: "record" | "salary";
  kind: "created" | "changed";
  who: string;
  how: string;
  fields: ChangeHistoryField[];
};

export type ChangeHistoryPayload = {
  entries: ChangeHistoryEntry[];
  moneyIncluded: boolean;
  /** true when the newest `limit` rows were returned and older ones exist. */
  truncated: boolean;
};

/** Ids that must be read back as names, by the column that holds them. */
export type ReferenceNames = {
  /** A display name (nickname, else full name) by HR id, any spelling. */
  person(hrId: string): string | null;
  /** The HR id behind a login, from `app_auth_users` — the record view's own way to name a login-only actor. */
  loginHrId(loginId: string): string | null;
  department(id: string): string | null;
  line(id: string): string | null;
  area(id: string): string | null;
  position(id: string): string | null;
  team(id: string): string | null;
};

/**
 * Every pay figure on the employee record — the Employee Master's own salary-blind list
 * (`SALARY_BLIND_OMITTED_KEYS`), in the database's spelling.
 */
export const MONEY_FIELDS: ReadonlySet<string> = new Set([
  "base_salary",
  "basic_salary",
  "extra_cost_of_living",
  "fuel_allowance",
  "gross_salary",
  "medical_insurance",
  "net_salary",
  "social_insurance",
  "social_insurance_wage",
  "taxes",
]);

/** Stamped by the database on every save; a reader learns nothing from them. */
const HIDDEN_FIELDS: ReadonlySet<string> = new Set(["created_at", "updated_at", "photo_updated_at"]);

/** The details panel's own words where it has them, so one field never carries two names. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  hr_id: "Employee ID",
  full_name: "Full Name",
  nickname: "Nickname",
  name_ar: "Arabic Name",
  national_id: "National ID",
  gender: "Gender",
  birth_date: "Birth Date",
  birth_place: "Birth Place",
  department_id: "Department",
  line_id: "Line",
  area_id: "Area",
  team_id: "Team",
  job_title: "Title",
  position_id: "Position",
  manager_hr_id: "Direct Manager",
  work_email: "Email",
  personal_email: "Personal Email",
  mobile_number: "Phone",
  residence_area: "Residence Area",
  residence_city: "Residence City",
  residence_address: "Residence Address",
  crm_id: "CRM ID",
  crm_username: "CRM Username",
  basic_salary: "Basic Salary",
  base_salary: "Base Salary",
  gross_salary: "Gross Salary",
  net_salary: "Net Salary",
  fuel_allowance: "Fuel Allowance",
  extra_cost_of_living: "Extra Cost of Living",
  medical_insurance: "Medical Insurance",
  social_insurance: "Social Insurance",
  social_insurance_wage: "Social Insurance Wage",
  taxes: "Taxes",
  payment_mode: "Payment Mode",
  has_bank_account: "Has Bank Account",
  bank_name: "Bank Name",
  bank_account: "Bank Account",
  social_insurance_status: "Social Insurance Status",
  payroll_eligible: "Payroll Eligible",
  organogram_visible: "Organogram Visible",
  employment_status: "Employment Status",
  onboarding_status: "Onboarding Status",
  hire_date: "Hire Date",
  region_name: "Region",
  photo_path: "Photo",
  work_half: "Work Half",
};

export function fieldLabel(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  return field
    .split("_")
    .filter(Boolean)
    .map((word) => (word === "id" ? "ID" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  api: "Through Phoenix",
  database_job: "Scheduled database job",
  direct_sql: "Direct database change",
};

/** How the write reached the database. NULL means the row predates the channel columns. */
export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return "Not recorded (before 19 Nov 2026)";
  return CHANNEL_LABELS[channel] ?? "Not recorded";
}

function referenceName(field: string, value: string, names: ReferenceNames): string {
  const lookup =
    field === "manager_hr_id"
      ? names.person(value)
      : field === "department_id"
        ? names.department(value)
        : field === "line_id"
          ? names.line(value)
          : field === "area_id"
            ? names.area(value)
            : field === "position_id"
              ? names.position(value)
              : field === "team_id"
                ? names.team(value)
                : value;
  // Names, never codes: an id the lookup could not name (deleted, or the name read failed) says so
  // instead of printing an HR id or a UUID.
  return lookup || "Name not available";
}

const REFERENCE_FIELDS: ReadonlySet<string> = new Set([
  "manager_hr_id",
  "department_id",
  "line_id",
  "area_id",
  "position_id",
  "team_id",
]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function moneyText(value: number): string {
  return `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** A stored value in words. null = empty. */
export function valueText(field: string, value: unknown, names: ReferenceNames): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return MONEY_FIELDS.has(field) ? moneyText(value) : String(value);
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (REFERENCE_FIELDS.has(field)) return referenceName(field, text, names);
    if (MONEY_FIELDS.has(field) && /^-?\d+(\.\d+)?$/.test(text)) return moneyText(Number(text));
    if (DATE_ONLY.test(text)) return cairoDate(`${text}T12:00:00Z`);
    if (INSTANT.test(text)) return cairoDateTime(text);
    return text;
  }
  return JSON.stringify(value);
}

/** Words the route names spell in capitals. */
const JOB_WORD_CAPITALS: Readonly<Record<string, string>> = {
  crm: "CRM",
  cv: "CV",
  db: "database",
  fx: "FX",
  hr: "HR",
  roi: "ROI",
  sla: "SLA",
  sos: "SOS",
  whatsapp: "WhatsApp",
};

function jobWords(slug: string): string {
  const words = slug
    .split(/[/_-]+/)
    .filter(Boolean)
    .map((word) => JOB_WORD_CAPITALS[word.toLowerCase()] ?? word.toLowerCase());
  if (words.length === 0) return "Unnamed job";
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/**
 * A scheduled job's name in words. The log keeps the name the job gives the shared cron guard
 * (src/lib/security/cron-auth.ts): "cron/probation-milestones", "cron/daily/resignation-sla". A
 * morning job reads by its own name in the daily-jobs list, the morning fan-out that runs them all
 * as "Morning jobs", and any other job as its route in words.
 */
export function scheduledJobName(job: string): string {
  const route = job.trim().replace(/^\/+|\/+$/g, "");
  const daily = /^cron\/daily\/(.+)$/.exec(route);
  if (daily) return findDailyJob(daily[1])?.name ?? jobWords(daily[1]);
  if (route === "notifications/daily" || route === "cron/daily") return "Morning jobs";
  return jobWords(route.replace(/^cron\//, ""));
}

/**
 * "unattributed" is the log's word for a write that named nobody: a script, a sync that ran while a
 * page was opened, or SQL run by hand. Say that, never "Unknown user". A scheduled job names itself
 * since 19 Nov 2026 (owner: "Name scheduled jobs"), and a person always comes first.
 */
function whoLabel(actorName: string | null, actorJob?: string | null): string {
  const person = actorName?.trim();
  if (person) return person;
  const job = actorJob?.trim();
  if (job) return `Scheduled job: ${scheduledJobName(job)}`;
  return "No person recorded";
}

/**
 * The actor's DISPLAY name (nickname, else full name — employees.md, every screen). The HR id is the
 * row's own, else the one behind its login; only when neither names anybody does the view's full
 * name stand in, because a name is better than "No person recorded" for a person who was recorded.
 */
function actorDisplayName(
  row: { actor_hr_id?: string | null; actor_login_id: string | null; actor_name: string | null },
  names: ReferenceNames,
): string | null {
  const hrId = row.actor_hr_id?.trim() || (row.actor_login_id ? names.loginHrId(row.actor_login_id) : null);
  return (hrId ? names.person(hrId) : null) ?? row.actor_name;
}

function fieldsOf(
  row: { changed_fields: string[] | null; old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null },
  masked: ReadonlySet<string>,
  includeMoney: boolean,
  names: ReferenceNames,
): ChangeHistoryField[] {
  const out: ChangeHistoryField[] = [];
  for (const field of row.changed_fields ?? []) {
    if (HIDDEN_FIELDS.has(field)) continue;
    if (!includeMoney && MONEY_FIELDS.has(field)) continue;
    const label = fieldLabel(field);
    if (masked.has(field)) {
      out.push({ field, label, before: null, after: null, kept: false });
      continue;
    }
    out.push({
      field,
      label,
      before: valueText(field, row.old_values?.[field], names),
      after: valueText(field, row.new_values?.[field], names),
      kept: true,
    });
  }
  return out;
}

/**
 * The two logs as one list, newest first. A change whose every field this viewer may not see is
 * dropped whole, so a salary-blind seat never meets an empty "changed" line where pay moved.
 */
export function buildChangeHistoryEntries(input: {
  recordRows: readonly RecordChangeRow[];
  salaryRows: readonly SalaryChangeRow[];
  includeMoney: boolean;
  names: ReferenceNames;
}): ChangeHistoryEntry[] {
  const entries: ChangeHistoryEntry[] = [];

  for (const row of input.recordRows) {
    const masked = new Set(row.masked_fields ?? []);
    const fields = fieldsOf(row, masked, input.includeMoney, input.names);
    if (fields.length === 0) continue;
    entries.push({
      id: `record-${row.id}`,
      at: row.changed_at,
      atLabel: cairoDateTime(row.changed_at),
      log: "record",
      kind: row.change_kind === "insert" ? "created" : "changed",
      who: whoLabel(actorDisplayName(row, input.names), row.actor_job),
      how: channelLabel(row.write_channel),
      fields,
    });
  }

  if (input.includeMoney) {
    for (const row of input.salaryRows) {
      const fields = fieldsOf(row, new Set(), true, input.names);
      if (fields.length === 0) continue;
      entries.push({
        id: `salary-${row.id}`,
        at: row.changed_at,
        atLabel: cairoDateTime(row.changed_at),
        log: "salary",
        kind: "changed",
        who: whoLabel(actorDisplayName(row, input.names), row.actor_job),
        how: channelLabel(row.write_channel),
        fields,
      });
    }
  }

  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

/**
 * Every id in the rows that must be read back as a name, grouped by what it names. `logins` must be
 * turned into HR ids first; the service adds those to `people` before it reads any name.
 */
export function referenceIdsOf(
  rows: ReadonlyArray<RecordChangeRow>,
  salaryRows: ReadonlyArray<SalaryChangeRow> = [],
): {
  logins: Set<string>;
  people: Set<string>;
  department: Set<string>;
  line: Set<string>;
  area: Set<string>;
  position: Set<string>;
  team: Set<string>;
} {
  const ids = {
    logins: new Set<string>(),
    people: new Set<string>(),
    department: new Set<string>(),
    line: new Set<string>(),
    area: new Set<string>(),
    position: new Set<string>(),
    team: new Set<string>(),
  };
  const bucket: Record<string, Set<string>> = {
    manager_hr_id: ids.people,
    department_id: ids.department,
    line_id: ids.line,
    area_id: ids.area,
    position_id: ids.position,
    team_id: ids.team,
  };
  for (const row of [...rows, ...salaryRows]) {
    const actorHrId = row.actor_hr_id?.trim();
    if (actorHrId) ids.people.add(actorHrId);
    else if (row.actor_login_id?.trim()) ids.logins.add(row.actor_login_id.trim());
  }
  for (const row of rows) {
    for (const field of row.changed_fields ?? []) {
      const target = bucket[field];
      if (!target) continue;
      for (const values of [row.old_values, row.new_values]) {
        const value = values?.[field];
        if (typeof value === "string" && value.trim()) target.add(value.trim());
      }
    }
  }
  return ids;
}
