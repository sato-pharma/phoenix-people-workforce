/**
 * Who a ChatGPT connector token speaks for, checked LIVE on every call.
 *
 * A token pins the account (login id, role, session_version) at the moment the person pressed "Allow".
 * Each call re-reads that account and its employee record, uncached, and refuses when any of these
 * changed: the account is deactivated; the employee has left (the same lifecycle gate the website's
 * session check uses); the role changed or is no longer the owner's or the CEO's; the password was
 * changed or the account was signed out everywhere (session_version moved); it is a test account.
 * A database that cannot be read refuses too — never a silent pass.
 *
 * The access context handed to the tools is built exactly as a website session builds it
 * (`createAccessContext`, source "session"), so every permission check and scope helper treats
 * ChatGPT as that person on their own screens.
 */
import { createAccessContext, normalizeRole, type AccessContext } from "@/lib/auth/permissions";
import { evaluateEmployeeLifecycleGate } from "@/lib/auth/session-lifecycle";
import { hrIdsMatch } from "@/lib/hr-id";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { isConnectorRole, type GrantSubject } from "./oauth";

export type LiveAccount = {
  login_id: string;
  hr_id: string | null;
  role: string;
  is_active: boolean | null;
  session_version: number | null;
  is_test_persona: boolean | null;
  name: string | null;
};

export type LiveEmployee = { employment_status: string | null; last_working_date: string | null } | null;

/** The pure decision, so it can be tested without a database. */
export function decideLiveSubject(
  subject: GrantSubject,
  account: LiveAccount | null,
  employee: { lookupFailed: boolean; row: LiveEmployee },
  todayCairo: string,
): { ok: true } | { ok: false; reason: string } {
  if (!account) return { ok: false, reason: "The Phoenix account no longer exists." };
  if (account.is_active !== true) return { ok: false, reason: "The Phoenix account is switched off." };
  if (account.is_test_persona === true) return { ok: false, reason: "Test accounts cannot connect ChatGPT." };
  const role = normalizeRole(account.role);
  if (!isConnectorRole(role)) return { ok: false, reason: "Only the owner and the CEO can connect ChatGPT." };
  if (role !== subject.role) return { ok: false, reason: "The account's role changed since ChatGPT was connected. Connect it again." };
  if (Number(account.session_version ?? 0) !== Number(subject.sessionVersion)) {
    return { ok: false, reason: "The password was changed or the account was signed out everywhere. Connect ChatGPT again." };
  }
  // The same person, compared the way the rest of Phoenix compares HR ids: a website session carries the
  // CANONICAL key (createAccessContext lowercases it, "b-10"), the account row keeps the record's own
  // spelling ("B-10"). A plain string test refused the owner's own first connection (17 Nov 2026).
  const neitherLinked = !String(account.hr_id ?? "").trim() && !String(subject.hrId ?? "").trim();
  if (!neitherLinked && !hrIdsMatch(account.hr_id, subject.hrId)) {
    return { ok: false, reason: "The account is linked to a different employee now. Connect ChatGPT again." };
  }
  const gate = evaluateEmployeeLifecycleGate({
    lookupFailed: employee.lookupFailed,
    employmentStatus: employee.row?.employment_status ?? null,
    lastWorkingDate: employee.row?.last_working_date ?? null,
    todayCairo,
  });
  if (!gate.allowed) {
    return { ok: false, reason: gate.reason === "employee_lookup_failed" ? "Phoenix could not check the account just now. Try again." : "The employee is no longer active." };
  }
  return { ok: true };
}

export async function readLiveAccount(loginId: string, db = getSupabaseAdmin()) {
  const { data, error } = await db
    .from("app_auth_users")
    .select("login_id, hr_id, role, is_active, session_version, is_test_persona, name")
    .eq("login_id", loginId)
    .maybeSingle();
  if (error) throw error;
  return (data as LiveAccount | null) ?? null;
}

async function readLiveEmployee(hrId: string | null, db = getSupabaseAdmin()): Promise<{ lookupFailed: boolean; row: LiveEmployee }> {
  const id = String(hrId ?? "").trim();
  if (!id) return { lookupFailed: false, row: null };
  const { data, error } = await db.from("employees").select("employment_status, last_working_date").eq("hr_id", id).maybeSingle();
  if (error) return { lookupFailed: true, row: null };
  return { lookupFailed: false, row: (data as LiveEmployee) ?? null };
}

/** The live check oauth.ts runs at approval, code exchange and refresh. */
export async function checkConnectorSubject(subject: GrantSubject): Promise<{ ok: true } | { ok: false; reason: string }> {
  let account: LiveAccount | null;
  try {
    account = await readLiveAccount(subject.loginId);
  } catch {
    return { ok: false, reason: "Phoenix could not check the account just now. Try again." };
  }
  const employee = await readLiveEmployee(account?.hr_id ?? subject.hrId);
  return decideLiveSubject(subject, account, employee, currentCairoDateOnlyIso());
}

/** The access context for one /api/mcp call, or the reason it is refused. */
export async function connectorAccessContext(subject: GrantSubject): Promise<{ ok: true; ctx: AccessContext } | { ok: false; reason: string }> {
  const verdict = await checkConnectorSubject(subject);
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    ctx: createAccessContext({ hrId: subject.hrId, loginId: subject.loginId, role: subject.role, source: "session" }),
  };
}
