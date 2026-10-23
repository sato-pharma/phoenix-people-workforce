import type { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdForDisplay, canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";

/**
 * Columns 1 and 2 — whose HR id and name an error row carries.
 *
 * An error row holds an `hr_id` (or only a `login_id`), never a name, and the names live in two
 * places: `employees` (the person) and `app_auth_users` (the login, its HR id and its role). Read
 * in batches of 200 lookup values, both casings, because stored HR ids drift between `b-10` and
 * `B-10` (hr-id.ts explains the 37,000 lowercase ones).
 *
 * A FAILED READ THROWS. An empty map passed off as "nobody had a name" would print a column of
 * blanks the owner would read as unattributed errors — the precise failure this audit replaces.
 */

type Client = ReturnType<typeof getSupabaseAdmin>;

export type PersonRecord = {
  /** The stored spelling (`B-10`), never the lowercase comparison key. */
  hrIdDisplay: string;
  name: string | null;
  /** The login's role when one is linked, else the employee's job title. */
  role: string | null;
};

export interface PersonDirectory {
  /**
   * Keyed by `canonicalHrIdKey` of every id asked for that resolved, AND of the HR id it resolved
   * to — so a caller holding a login id or an HR id finds the person either way. Ids that match
   * nobody are simply absent; a read failure throws.
   */
  lookup(hrIdsOrLoginIds: readonly string[]): Promise<Map<string, PersonRecord>>;
}

const BATCH = 200;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function lookupValues(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.flatMap((id) => hrIdLookupKeys(id))));
}

type EmployeeRow = { hr_id: string | null; full_name: string | null; job_title: string | null };
type LoginRow = { login_id: string | null; hr_id: string | null; role: string | null };

function readFailure(table: string, error: { message?: string; code?: string }): Error {
  const code = error.code ? ` (${error.code})` : "";
  return new Error(`System audit person lookup failed on ${table}${code}: ${error.message ?? "unknown error"}`);
}

export function createPersonDirectory(supabase: Client): PersonDirectory {
  async function readEmployees(values: readonly string[]): Promise<EmployeeRow[]> {
    const rows: EmployeeRow[] = [];
    for (const batch of chunks(values, BATCH)) {
      const { data, error } = await supabase.from("employees").select("hr_id, full_name, job_title").in("hr_id", batch);
      if (error) throw readFailure("employees", error);
      rows.push(...((data ?? []) as EmployeeRow[]));
    }
    return rows;
  }

  async function readLogins(column: "login_id" | "hr_id", values: readonly string[]): Promise<LoginRow[]> {
    const rows: LoginRow[] = [];
    for (const batch of chunks(values, BATCH)) {
      const { data, error } = await supabase.from("app_auth_users").select("login_id, hr_id, role").in(column, batch);
      if (error) throw readFailure("app_auth_users", error);
      rows.push(...((data ?? []) as LoginRow[]));
    }
    return rows;
  }

  return {
    async lookup(hrIdsOrLoginIds) {
      const asked = Array.from(new Set(hrIdsOrLoginIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
      const result = new Map<string, PersonRecord>();
      if (asked.length === 0) return result;

      // A login id names a login; its HR id names the person. Resolve logins first so a row that
      // carries only `login_id` still reaches the employee.
      const logins = await readLogins("login_id", lookupValues(asked));
      const hrIdByLogin = new Map<string, string>();
      const roleByHrKey = new Map<string, string>();
      for (const login of logins) {
        const loginKey = canonicalHrIdKey(login.login_id);
        const hrKey = canonicalHrIdKey(login.hr_id);
        if (loginKey && login.hr_id) hrIdByLogin.set(loginKey, login.hr_id);
        if (hrKey && login.role) roleByHrKey.set(hrKey, login.role);
      }

      const hrIds = Array.from(new Set(asked.map((id) => hrIdByLogin.get(canonicalHrIdKey(id) ?? "") ?? id)));
      const [employees, hrLogins] = await Promise.all([readEmployees(lookupValues(hrIds)), readLogins("hr_id", lookupValues(hrIds))]);
      for (const login of hrLogins) {
        const hrKey = canonicalHrIdKey(login.hr_id);
        if (hrKey && login.role && !roleByHrKey.has(hrKey)) roleByHrKey.set(hrKey, login.role);
      }

      const byHrKey = new Map<string, PersonRecord>();
      for (const employee of employees) {
        const hrKey = canonicalHrIdKey(employee.hr_id);
        if (!hrKey || byHrKey.has(hrKey)) continue;
        byHrKey.set(hrKey, {
          hrIdDisplay: employee.hr_id ? String(employee.hr_id) : (canonicalHrIdForDisplay(hrKey) ?? hrKey),
          name: employee.full_name?.trim() || null,
          role: roleByHrKey.get(hrKey) ?? employee.job_title ?? null,
        });
      }

      for (const id of asked) {
        const askedKey = canonicalHrIdKey(id);
        if (!askedKey) continue;
        const resolvedHrId = hrIdByLogin.get(askedKey) ?? id;
        const hrKey = canonicalHrIdKey(resolvedHrId);
        const person = hrKey ? byHrKey.get(hrKey) : undefined;
        if (!person || !hrKey) continue;
        result.set(askedKey, person);
        result.set(hrKey, person);
      }
      return result;
    },
  };
}

/**
 * A directory over a fixed map — for tests and for the historical runner, which reads the people
 * once from a snapshot. Keys are canonicalised on the way in, so `B-10` and `b-10` both find him.
 */
export function createStaticPersonDirectory(people: ReadonlyMap<string, PersonRecord> | Record<string, PersonRecord>): PersonDirectory {
  const entries = people instanceof Map ? [...people.entries()] : Object.entries(people);
  const byKey = new Map<string, PersonRecord>();
  for (const [id, person] of entries) {
    const key = canonicalHrIdKey(id);
    if (key) byKey.set(key, person);
  }
  return {
    async lookup(hrIdsOrLoginIds) {
      const result = new Map<string, PersonRecord>();
      for (const id of hrIdsOrLoginIds) {
        const key = canonicalHrIdKey(id);
        const person = key ? byKey.get(key) : undefined;
        if (key && person) result.set(key, person);
      }
      return result;
    },
  };
}
