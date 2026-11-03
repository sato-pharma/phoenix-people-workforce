import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import type { AccessContext } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The screen for addresses Phoenix refuses to email (owner, 2026-11-03).
 *
 * A bounce or a complaint writes `email_suppressions`, and from then on every email to that address is
 * silently skipped, salary and leave notices included. Nothing showed it: 6 active employees had been
 * blocked since 4 October and could not reset their own password. This shows who, and lets the Super Admin
 * lift a block on an address that has since been fixed.
 *
 * LIFTING IS NOT SENDING. It deletes one row and sends nothing, and no test email goes out from here.
 * A hard bounce usually means the mailbox did not exist, so a lift before the mailbox is created only earns
 * another bounce, which blocks the address again. The screen says so (suppression-words.ts).
 * A complaint or an unsubscribe is the person's own word, so it is refused.
 */

export type EmailBlockReason = "hard_bounce" | "complaint" | "unsubscribe" | "manual";

export type EmailBlockRow = {
  address: string;
  blockedAt: string;
  jobTitle: string | null;
  liftable: boolean;
  personActive: boolean;
  personName: string | null;
  providerWords: string | null;
  reason: string;
};

export type NoWorkEmailPerson = { jobTitle: string | null; name: string };

export type EmailBlockView = { blocked: EmailBlockRow[]; noWorkEmail: NoWorkEmailPerson[] };

export type SuppressionDbRow = {
  address: string;
  bounce_subtype: string | null;
  created_at: string;
  expires_at: string | null;
  reason: string;
};

export type EmployeeEmailDbRow = {
  employment_status: string | null;
  full_name: string | null;
  hr_id: string;
  job_title: string | null;
  work_email: string | null;
};

const LIFTABLE: ReadonlySet<string> = new Set<EmailBlockReason>(["hard_bounce", "manual"]);

function assertEmailBlockAccess(access: AccessContext): void {
  if (access.role !== "Super Admin") throw forbiddenError("Forbidden: blocked work emails are Super Admin only.");
}

/** Pure. An expired row is not a block. Active employees first, each group newest first. */
export function buildEmailBlockView(
  suppressions: readonly SuppressionDbRow[],
  employees: readonly EmployeeEmailDbRow[],
  nowMs: number,
): EmailBlockView {
  const byAddress = new Map<string, EmployeeEmailDbRow>();
  for (const employee of employees) {
    const address = employee.work_email?.trim().toLowerCase();
    if (!address) continue;
    const current = byAddress.get(address);
    // Two rows can share an address; the live person is the one a block costs.
    if (!current || isTerminalEmploymentStatus(current.employment_status)) byAddress.set(address, employee);
  }

  const blocked = suppressions
    .filter((row) => !row.expires_at || Date.parse(row.expires_at) > nowMs)
    .map((row): EmailBlockRow => {
      const person = byAddress.get(row.address.trim().toLowerCase()) ?? null;
      return {
        address: row.address,
        blockedAt: row.created_at,
        jobTitle: person?.job_title ?? null,
        liftable: LIFTABLE.has(row.reason),
        personActive: Boolean(person) && !isTerminalEmploymentStatus(person?.employment_status),
        personName: person?.full_name ?? null,
        providerWords: row.bounce_subtype,
        reason: row.reason,
      };
    })
    .sort((left, right) => Number(right.personActive) - Number(left.personActive) || right.blockedAt.localeCompare(left.blockedAt));

  const noWorkEmail = employees
    .filter((row) => !row.work_email?.trim() && !isTerminalEmploymentStatus(row.employment_status) && row.employment_status)
    .map((row) => ({ jobTitle: row.job_title, name: row.full_name ?? row.hr_id }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { blocked, noWorkEmail };
}

export async function readEmployeeEmails(): Promise<EmployeeEmailDbRow[]> {
  const supabase = getSupabaseAdmin();
  const rows: EmployeeEmailDbRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id, full_name, job_title, work_email, employment_status")
      .order("hr_id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as EmployeeEmailDbRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** A failed read throws: the panel says it could not read, and never shows an empty list as clear. */
export async function readEmailBlocks(access: AccessContext): Promise<EmailBlockView> {
  assertEmailBlockAccess(access);
  const [suppressions, employees] = await Promise.all([
    getSupabaseAdmin().from("email_suppressions").select("address, reason, bounce_subtype, created_at, expires_at"),
    readEmployeeEmails(),
  ]);
  if (suppressions.error) throw suppressions.error;
  return buildEmailBlockView((suppressions.data ?? []) as SuppressionDbRow[], employees, Date.now());
}

export async function liftEmailBlock(access: AccessContext, input: { address: string }): Promise<EmailBlockView> {
  assertEmailBlockAccess(access);
  assertRealSessionForDecision(access, "lift a blocked email");
  const address = String(input.address ?? "").trim().toLowerCase();
  if (!address) throw validationError("Name the address.");

  const supabase = getSupabaseAdmin();
  const read = await supabase
    .from("email_suppressions")
    .select("address, reason, source, bounce_subtype, created_at")
    .eq("address", address)
    .maybeSingle();
  if (read.error) throw read.error;
  if (!read.data) throw notFoundError("That address is not blocked.");
  const row = read.data as { address: string; bounce_subtype: string | null; created_at: string; reason: string; source: string };
  if (!LIFTABLE.has(row.reason)) {
    throw validationError(
      row.reason === "complaint"
        ? "This person marked an email as spam. A complaint is theirs to withdraw, so it cannot be lifted here."
        : "This person unsubscribed. An unsubscribe is theirs to withdraw, so it cannot be lifted here.",
    );
  }

  const removal = await supabase.from("email_suppressions").delete().eq("address", address);
  if (removal.error) throw removal.error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: address,
    entityType: "notification",
    newValues: { blocked: false },
    oldValues: { blocked: true, ...row },
    summary: `The email block on ${address} (${row.reason}) was lifted. Nothing was sent.`,
  });
  return readEmailBlocks(access);
}
