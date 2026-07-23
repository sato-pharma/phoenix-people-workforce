// Admin-defined custom email-template variables (owner request, 2026-07-22).
//
// An admin can create a new {{token}} without a code change by binding it to an existing
// column on `employees`; it resolves at render time from the SUBJECT employee's record.
//
// THE SECURITY CONTROL IS THIS FILE'S ALLOWLIST. `employees` also holds net_salary,
// basic_salary, gross_salary, taxes, bank_account, national_id, social/medical insurance
// numbers, mobile_number, residence_* and birth_date. A template can CC an entire line, so a
// token bound to any of those would be a salary/PII broadcast. Binding is therefore
// restricted to identity / org-placement / contract-milestone fields — the same classes of
// data that already appear in these emails today — and the check runs SERVER-SIDE on every
// save AND again on every resolve (defense in depth: a row written by any other means still
// cannot leak, because resolution re-checks the allowlist rather than trusting the row).

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/observability/log";

export type EmployeeVariableSource = {
  column: string;
  label: string;
  sample: string;
};

/**
 * The ONLY employees columns an admin may bind a custom email token to.
 * Deliberately excludes every salary/financial, government-ID, insurance-number, bank,
 * personal-contact and residence column. Do not add one of those here — see the file header.
 */
export const EMPLOYEE_VARIABLE_SOURCES: readonly EmployeeVariableSource[] = [
  { column: "full_name", label: "Full name", sample: "Mariam Adel" },
  { column: "nickname", label: "Nickname", sample: "Mimi" },
  { column: "name_ar", label: "Arabic name", sample: "مريم عادل" },
  { column: "hr_id", label: "HR ID", sample: "PHX-1024" },
  { column: "job_title", label: "Job title", sample: "Medical Representative" },
  { column: "line_name", label: "Line", sample: "Cardio Line" },
  { column: "area_name", label: "Area", sample: "Cairo East" },
  { column: "region_name", label: "Region", sample: "Greater Cairo" },
  { column: "department_name", label: "Department", sample: "Sales" },
  { column: "team_name", label: "Team", sample: "Cardio Team A" },
  { column: "manager_hr_id", label: "Manager HR ID", sample: "PHX-0450" },
  { column: "work_email", label: "Work email", sample: "mariam.adel@satopharma.com" },
  { column: "employment_status", label: "Employment status", sample: "Active" },
  { column: "contract_type", label: "Contract type", sample: "Full time" },
  { column: "hire_date", label: "Hire date", sample: "2026-06-01" },
  { column: "contract_start_date", label: "Contract start date", sample: "2026-06-01" },
  { column: "contract_renewal_date", label: "Contract renewal date", sample: "2027-06-01" },
  { column: "probation_end_date", label: "Probation end date", sample: "2026-09-01" },
];

const allowedSourceColumns = new Set(EMPLOYEE_VARIABLE_SOURCES.map((source) => source.column));

export function isAllowedVariableSourceColumn(column: string) {
  return allowedSourceColumns.has(String(column ?? "").trim());
}

const customVariablesTable = "email_custom_variables";

export type EmailCustomVariable = {
  createdAt: string;
  description: string | null;
  label: string;
  /** False when source_column is no longer on the allowlist — shown as invalid, resolves to "". */
  sourceAllowed: boolean;
  sourceColumn: string;
  token: string;
};

export class CustomVariableError extends Error {}

/**
 * Token grammar matches the renderer's own {{token}} regex ([a-zA-Z0-9_]+, must start with a
 * letter) so a saved token is always actually resolvable, and is length-capped so it stays
 * readable as an editor chip.
 */
const tokenPattern = /^[a-zA-Z][a-zA-Z0-9_]{1,39}$/;

function tableMissing(error: unknown) {
  const message = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    message.includes(customVariablesTable) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

type CustomVariableRow = {
  created_at?: string | null;
  description?: string | null;
  label?: string | null;
  source_column?: string | null;
  token?: string | null;
};

function mapRow(row: CustomVariableRow): EmailCustomVariable | null {
  const token = String(row.token ?? "").trim();
  const sourceColumn = String(row.source_column ?? "").trim();
  if (!token || !sourceColumn) return null;
  return {
    createdAt: row.created_at ?? new Date().toISOString(),
    description: row.description ?? null,
    label: String(row.label ?? "").trim() || token,
    sourceAllowed: isAllowedVariableSourceColumn(sourceColumn),
    sourceColumn,
    token,
  };
}

export async function listEmailCustomVariables(): Promise<EmailCustomVariable[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(customVariablesTable)
      .select("token,label,source_column,description,created_at")
      .order("token", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as CustomVariableRow[])
      .map(mapRow)
      .filter((variable): variable is EmailCustomVariable => Boolean(variable));
  } catch (error) {
    // Before the migration is applied this is simply "no custom variables" — never an error
    // that should break the whole template catalog/editor.
    if (tableMissing(error)) return [];
    logError("Email custom variables lookup failed", {
      labels: { event: "email_custom_variables_lookup_failed" },
      error,
    });
    return [];
  }
}

export async function saveEmailCustomVariable(
  input: { description?: string | null; label: string; sourceColumn: string; token: string },
  actor?: string | null,
  reservedTokens: ReadonlySet<string> = new Set(),
): Promise<EmailCustomVariable> {
  const token = String(input.token ?? "").trim();
  const sourceColumn = String(input.sourceColumn ?? "").trim();
  const label = String(input.label ?? "").trim();

  if (!tokenPattern.test(token)) {
    throw new CustomVariableError(
      "Variable name must start with a letter and use only letters, numbers or underscores (2-40 characters).",
    );
  }
  // A custom token must never shadow a built-in one: built-ins win at render time, so a
  // colliding custom token would silently never resolve and look broken to the admin.
  if (reservedTokens.has(token)) {
    throw new CustomVariableError(`"${token}" is already a built-in variable. Choose a different name.`);
  }
  if (!isAllowedVariableSourceColumn(sourceColumn)) {
    throw new CustomVariableError(
      "That employee field cannot be used in an email. Choose one of the approved fields (salary, national ID, bank, insurance and personal contact fields are never allowed).",
    );
  }
  if (!label) throw new CustomVariableError("Give the variable a human-readable name.");

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(customVariablesTable)
    .upsert(
      {
        created_by: actor ?? null,
        description: String(input.description ?? "").trim() || null,
        label,
        source_column: sourceColumn,
        token,
        updated_at: now,
      },
      { onConflict: "token" },
    )
    .select("token,label,source_column,description,created_at")
    .single();

  if (error) throw error;
  const mapped = mapRow((data ?? {}) as CustomVariableRow);
  if (!mapped) throw new CustomVariableError("The variable could not be saved.");
  return mapped;
}

export async function deleteEmailCustomVariable(token: string) {
  const clean = String(token ?? "").trim();
  if (!clean) throw new CustomVariableError("Variable name is required.");
  const { error } = await getSupabaseAdmin().from(customVariablesTable).delete().eq("token", clean);
  if (error) throw error;
}

/**
 * Sample values for admin previews and test sends, where there is no real subject employee.
 * Without this a custom token would render blank in the preview and look broken, even though
 * it resolves correctly on a real send.
 */
export async function sampleEmailCustomVariables(): Promise<Record<string, string>> {
  const variables = await listEmailCustomVariables();
  const samples = new Map(EMPLOYEE_VARIABLE_SOURCES.map((source) => [source.column, source.sample]));
  return Object.fromEntries(
    variables
      .filter((variable) => variable.sourceAllowed)
      .map((variable) => [variable.token, samples.get(variable.sourceColumn) ?? ""]),
  );
}

/**
 * Resolve every custom token for one employee. Re-checks the allowlist per row (never trusts
 * the stored source_column) and coerces to a display string; a missing/unknown value becomes
 * "" so a template can never render the literal word "null" or leak a raw object.
 */
export async function resolveEmailCustomVariables(employeeHrId: string | null | undefined): Promise<Record<string, string>> {
  const hrId = String(employeeHrId ?? "").trim().toUpperCase();
  const variables = await listEmailCustomVariables();
  const usable = variables.filter((variable) => variable.sourceAllowed);
  if (!hrId || usable.length === 0) return {};

  try {
    const columns = Array.from(new Set(usable.map((variable) => variable.sourceColumn)));
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select(columns.join(","))
      .eq("hr_id", hrId)
      .maybeSingle();
    if (error) throw error;
    const employee = (data ?? {}) as Record<string, unknown>;

    return Object.fromEntries(
      usable.map((variable) => {
        const raw = employee[variable.sourceColumn];
        const value = raw === null || raw === undefined ? "" : String(raw);
        return [variable.token, value];
      }),
    );
  } catch (error) {
    // Best-effort: a lookup failure must degrade to empty tokens, never break the send.
    logError("Email custom variable resolution failed", {
      labels: { event: "email_custom_variable_resolution_failed", hr_id: hrId },
      error,
    });
    return {};
  }
}
