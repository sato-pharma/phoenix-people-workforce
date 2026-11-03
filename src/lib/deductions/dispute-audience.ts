// Who a reply to a deduction dispute reaches.
//
// Owner, 2026-10-08: "when I reply, my reply will appear in the portal, and go to them, CC their
// managers — in the email, Telegram, in-app." Before this a reply reached the employee and copied
// only its sender; the employee's managers heard nothing. And "go to them" was a promise the screen
// could not keep honestly, because Telegram reaches only a person who linked it — so the same lookup
// that decides the CC also reports, per person, whether Telegram is linked, and the inbox shows it.
//
// ONE decision, two readers: the Disputes read shows the To and CC BEFORE the Reply button is
// pressed, and the reply send uses the same function to address the notification. They cannot
// disagree because there is only this.
//
// WHICH MANAGERS (owner's answer, 2026-10-08, asked in chat as multiple choice): the direct
// manager AND the one above — `DISPUTE_REPLY_MANAGER_LEVELS`. The walk is `employees.manager_hr_id`,
// the same chain notifications/email.ts `loadManagerChain` and notifications/policy.ts
// `managerChainFor` use, and a DEPARTED manager ends it (policy.ts: "a departed manager must not be
// notified") — a person who has left is never copied, and nobody above them is reached around them.

import { ACTIVE_EMPLOYMENT_STATUSES } from "@/lib/auth/session-lifecycle";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { DeductionDisputeAudience, DeductionDisputeRecipient } from "./types.ts";

export const DISPUTE_REPLY_MANAGER_LEVELS = 2;

type EmployeeLite = {
  hr_id: string | null;
  full_name: string | null;
  nickname: string | null;
  job_title: string | null;
  manager_hr_id: string | null;
  employment_status: string | null;
};

export type ResolvedDisputePerson = {
  hrId: string;
  name: string;
  title: string | null;
};

export type ResolvedDisputeAudience = {
  employee: ResolvedDisputePerson | null;
  managers: ResolvedDisputePerson[];
};

async function loadEmployee(hrId: string | null | undefined): Promise<EmployeeLite | null> {
  const lookups = hrIdLookupKeys(hrId);
  if (lookups.length === 0) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, full_name, nickname, job_title, manager_hr_id, employment_status")
    .in("hr_id", lookups)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as EmployeeLite | null) ?? null;
}

function isActive(row: EmployeeLite): boolean {
  const status = String(row.employment_status ?? "").trim().toLowerCase();
  return status === "" || ACTIVE_EMPLOYMENT_STATUSES.has(status);
}

function toPerson(row: EmployeeLite): ResolvedDisputePerson | null {
  const hrId = String(row.hr_id ?? "").trim();
  if (!hrId) return null;
  return {
    hrId,
    name: resolveEmployeeDisplayName(String(row.full_name ?? "").trim(), row.nickname, hrId).trim() || "Employee",
    title: String(row.job_title ?? "").trim() || null,
  };
}

/**
 * The employee and the managers a reply is copied to. The employee may be a leaver (their dispute
 * still deserves an answer), a manager must be active. Never throws on a missing manager.
 */
export async function resolveDisputeAudience(employeeHrId: string | null | undefined): Promise<ResolvedDisputeAudience> {
  const employeeRow = await loadEmployee(employeeHrId);
  if (!employeeRow) return { employee: null, managers: [] };

  const managers: ResolvedDisputePerson[] = [];
  const seen = new Set<string>();
  const ownKey = canonicalHrIdKey(employeeRow.hr_id);
  if (ownKey) seen.add(ownKey);

  let current: EmployeeLite = employeeRow;
  for (let level = 0; level < DISPUTE_REPLY_MANAGER_LEVELS; level += 1) {
    const managerKey = canonicalHrIdKey(current.manager_hr_id);
    if (!managerKey || seen.has(managerKey)) break;
    seen.add(managerKey);
    const manager = await loadEmployee(current.manager_hr_id);
    if (!manager || !isActive(manager)) break;
    const person = toPerson(manager);
    if (!person) break;
    managers.push(person);
    current = manager;
  }

  return { employee: toPerson(employeeRow), managers };
}

/**
 * Whether Telegram will actually reach each person: a connected link AND the preference not turned
 * off. Keyed by canonical HR id. Best-effort — an unreadable table reads as "not linked", which is
 * the cautious thing to tell a sender.
 */
export async function loadTelegramReach(hrIds: Array<string | null | undefined>): Promise<Map<string, boolean>> {
  const reach = new Map<string, boolean>();
  const lookups = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
  if (lookups.length === 0) return reach;
  const supabase = getSupabaseAdmin();
  try {
    const [links, prefs] = await Promise.all([
      supabase
        .from("telegram_connections")
        .select("hr_id, status, updated_at")
        .in("hr_id", lookups)
        .order("updated_at", { ascending: false }),
      supabase.from("notification_preferences").select("hr_id, telegram_enabled").in("hr_id", lookups),
    ]);
    const newestStatus = new Map<string, string>();
    for (const row of (links.data ?? []) as Array<{ hr_id?: string | null; status?: string | null }>) {
      const key = canonicalHrIdKey(row.hr_id);
      if (key && !newestStatus.has(key)) newestStatus.set(key, String(row.status ?? ""));
    }
    const telegramOff = new Set<string>();
    for (const row of (prefs.data ?? []) as Array<{ hr_id?: string | null; telegram_enabled?: boolean | null }>) {
      const key = canonicalHrIdKey(row.hr_id);
      if (key && row.telegram_enabled === false) telegramOff.add(key);
    }
    for (const hrId of hrIds) {
      const key = canonicalHrIdKey(hrId);
      if (key) reach.set(key, newestStatus.get(key) === "connected" && !telegramOff.has(key));
    }
  } catch {
    for (const hrId of hrIds) {
      const key = canonicalHrIdKey(hrId);
      if (key) reach.set(key, false);
    }
  }
  return reach;
}

export function toAudienceRecipient(person: ResolvedDisputePerson): DeductionDisputeRecipient {
  return { name: person.name, title: person.title };
}

/** The shape the Disputes inbox shows beside the Reply button. */
export function toDisputeAudience(resolved: ResolvedDisputeAudience): DeductionDisputeAudience | null {
  if (!resolved.employee) return null;
  return {
    to: toAudienceRecipient(resolved.employee),
    managers: resolved.managers.map(toAudienceRecipient),
  };
}
