/**
 * New Hire Accounts, server side: who is waiting for their account, and the one send. The rule and his words are in
 * `./rules.ts`.
 *
 * Outside `src/lib/phoenix-crm` on purpose: that module reads only its own tables, the organogram, people's names and
 * the product list, and this page reads logins and the audit trail. It writes nothing itself: the one write is
 * `sendPasswordSetupLink`, the same sender the Super Admin's access page uses, which touches `force_password_reset`,
 * `session_version` and `updated_at` and no role, line, manager or scope.
 */

import { sendPasswordSetupLink } from "@/lib/auth/password-setup";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import {
  isNewHireAccount,
  lastSendOf,
  newHireAddress,
  newHireMissingText,
  NEW_HIRE_ROLES,
  parseNewHireChannel,
  type NewHireAccountRow,
  type NewHireAccountsView,
  type NewHireLastSend,
  type NewHireSendResult,
} from "@/lib/new-hire-accounts/rules";
import { canUseSfeFieldControls, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { personKey } from "@/lib/phoenix-crm/scope";
import { toDialableLocalMobile, toWhatsAppNumber } from "@/lib/reports/organogram-whatsapp";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** How far back the page looks for an earlier send: the hire window, plus the weeks a person is invited ahead of it. */
const LAST_SEND_LOOKBACK_DAYS = 120;

type LoginRow = {
  login_id: string;
  hr_id: string | null;
  role: string | null;
  is_active: boolean | null;
  force_password_reset: boolean | null;
  is_test_persona: boolean | null;
};

type EmployeeRow = {
  hr_id: string;
  job_title: string | null;
  hire_date: string | null;
  employment_status: string | null;
  work_email: string | null;
  personal_email: string | null;
  mobile_number: string | null;
};

/** The Super Admin and the SFE Manager (owner, 2026-11-03), and never a test account. */
export function canSendNewHireAccounts(viewer: PhoenixCrmViewer): boolean {
  return canUseSfeFieldControls(viewer);
}

function assertSender(viewer: PhoenixCrmViewer): void {
  if (!canSendNewHireAccounts(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager send new hire accounts.");
}

/** Everyone who passes `isNewHireAccount` today, or the one login a press names. */
async function loadPeople(viewer: PhoenixCrmViewer, onlyLoginId?: string): Promise<Array<Omit<NewHireAccountRow, "lastSend">>> {
  let logins = getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id, hr_id, role, is_active, force_password_reset, is_test_persona")
    .eq("is_active", true)
    .eq("force_password_reset", true)
    .in("role", [...NEW_HIRE_ROLES]);
  if (onlyLoginId) logins = logins.eq("login_id", onlyLoginId);
  const { data: loginData, error: loginError } = await logins;
  if (loginError) throw loginError;
  const loginRows = (loginData ?? []) as LoginRow[];

  const hrIds = loginRows.map((row) => String(row.hr_id ?? "").trim()).filter(Boolean);
  if (hrIds.length === 0) return [];

  const { data: employeeData, error: employeeError } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, job_title, hire_date, employment_status, work_email, personal_email, mobile_number")
    .in("hr_id", hrIds);
  if (employeeError) throw employeeError;
  const employees = new Map(((employeeData ?? []) as EmployeeRow[]).map((row) => [row.hr_id, row]));

  const waiting = loginRows.flatMap((login) => {
    const employee = employees.get(String(login.hr_id ?? "").trim());
    if (!employee) return [];
    const passes = isNewHireAccount(
      {
        role: login.role,
        isActive: login.is_active === true,
        forcePasswordReset: login.force_password_reset === true,
        isTestPersona: login.is_test_persona === true,
        employmentStatus: employee.employment_status,
        hireDate: employee.hire_date,
      },
      viewer.cairoToday,
    );
    return passes ? [{ login, employee }] : [];
  });

  const names = await loadPeopleNames(waiting.map(({ employee }) => employee.hr_id));
  const joinDistinct = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))].join(" · ");
  return waiting
    .map(({ login, employee }) => {
      const seats = viewer.org.seatsByOccupant.get(personKey(employee.hr_id) ?? "") ?? [];
      const whatsApp = toWhatsAppNumber(employee.mobile_number);
      return {
        loginId: login.login_id,
        name: nameOf(names, employee.hr_id),
        jobTitle: employee.job_title,
        lineName: joinDistinct(seats.map((seat) => seat.lineName)) || "No line",
        areaName: joinDistinct(seats.map((seat) => seat.areaName)) || "No area",
        hireDate: String(employee.hire_date).slice(0, 10),
        satoEmail: pickDeliverableEmail(employee.work_email),
        privateEmail: pickDeliverableEmail(employee.personal_email),
        mobile: whatsApp ? toDialableLocalMobile(whatsApp) : null,
      };
    })
    .sort((left, right) => right.hireDate.localeCompare(left.hireDate) || left.name.localeCompare(right.name));
}

type AuditRow = { entity_id: string; actor_login_id: string | null; created_at: string; new_values: Record<string, unknown> | null };

/** The newest send of each login, from the audit row `sendPasswordSetupLink` is required to write. */
async function loadLastSends(loginIds: string[]): Promise<Map<string, NewHireLastSend> | null> {
  if (loginIds.length === 0) return new Map();
  const since = new Date(Date.now() - LAST_SEND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("audit_logs")
    .select("entity_id, actor_login_id, created_at, new_values")
    .eq("entity_type", "user")
    .in("entity_id", loginIds)
    .eq("new_values->>action", "password_setup_link_generated")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return null;

  const rows = (data ?? []) as AuditRow[];
  const names = await loadPeopleNames(rows.map((row) => row.actor_login_id));
  const sends = new Map<string, NewHireLastSend>();
  for (const row of rows) {
    if (sends.has(row.entity_id)) continue;
    sends.set(row.entity_id, {
      at: row.created_at,
      byName: row.actor_login_id ? nameOf(names, row.actor_login_id) : null,
      ...lastSendOf(row.new_values ?? {}),
    });
  }
  return sends;
}

export async function loadNewHireAccounts(viewer: PhoenixCrmViewer): Promise<NewHireAccountsView> {
  assertSender(viewer);
  const people = await loadPeople(viewer);
  const sends = await loadLastSends(people.map((person) => person.loginId));
  return {
    rows: people.map((person) => ({ ...person, lastSend: sends?.get(person.loginId) ?? null })),
    lastSendUnavailable: sends === null,
  };
}

/**
 * One link to one person, by one press. 🔴 The person is asked for again here, so a stale page reaches nobody who has
 * since set a password, and the address is the register's, read by the sender: nothing but the login and the channel is
 * read from the request.
 */
export async function sendNewHireAccount(
  viewer: PhoenixCrmViewer,
  raw: unknown,
  context: { actorLoginId: string | null; origin: string },
): Promise<NewHireSendResult> {
  assertSender(viewer);
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const loginId = String(body.loginId ?? "").trim();
  if (!loginId) throw validationError("Choose a person from the list.");
  const channel = parseNewHireChannel(body.channel);
  if (!channel) throw validationError("Reload the page and try again.");

  const [person] = await loadPeople(viewer, loginId);
  if (!person) throw validationError("This person is no longer waiting for a new hire account. Reload the page.");
  if (!newHireAddress(person, channel)) throw validationError(`${newHireMissingText(channel)}. Choose another way to send it.`);

  const result = await sendPasswordSetupLink({
    actorLoginId: context.actorLoginId,
    deliveryMode: channel === "whatsapp" ? "whatsapp" : "email",
    ...(channel === "whatsapp" ? {} : { emailTo: channel === "private_email" ? ("private" as const) : ("work" as const) }),
    governanceReason: "Sent from the New Hire Accounts page.",
    loginId,
    origin: context.origin,
    purpose: "setup",
  });

  const names = await loadPeopleNames([viewer.hrId]);
  const delivered = result.emailDelivered !== false;
  return {
    loginId,
    channel,
    message: result.deliveryMessage,
    delivered,
    whatsAppUrl: result.whatsAppUrl ?? null,
    lastSend: {
      at: new Date().toISOString(),
      byName: viewer.hrId ? nameOf(names, viewer.hrId) : null,
      ...lastSendOf({
        deliveryMode: result.deliveryMode,
        delivery: delivered ? "email_sent" : result.emailQueuedForRetry ? "email_queued_for_retry" : "link_generated_only",
        emailTo: channel === "private_email" ? "private" : channel === "sato_email" ? "work" : null,
      }),
    },
  };
}
