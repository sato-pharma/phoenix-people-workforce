// ─────────────────────────────────────────────────────────────────────────────────────────────
// The word a screen puts beside someone who is no longer here, while something of theirs is still
// open (owner, 2026-11-03). It only says so: leaving closes nothing and decides nothing, for anyone.
// Free of Supabase so a client component imports it.
//
// A DECLINED OFFER IS NOT "LEFT". They never started, so `hasDepartedEmployment` rightly leaves them
// out and there is no last working day to quote, but the case and the task opened for them are just
// as stranded, so they get their own words. Ledger rows and placeholders are nobody, and get none.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

export type EmployeeLeftFlag = {
  /** The last working day, `YYYY-MM-DD`, when the record holds one. Never set on a declined offer. */
  date: string | null;
  kind: "declined" | "left";
};

export function employeeLeftFlag(input: {
  employmentStatus: string | null | undefined;
  lastWorkingDate: string | null | undefined;
}): EmployeeLeftFlag | null {
  if (hasDepartedEmployment(input.employmentStatus)) return { date: input.lastWorkingDate || null, kind: "left" };
  if (String(input.employmentStatus ?? "").trim().toLowerCase() === "declined_offer") return { date: null, kind: "declined" };
  return null;
}

/** A calendar day, read as one: it is formatted in UTC so no viewer's clock can move it a day. */
export function formatLeftDay(key: string): string {
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  return stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(date);
}

export function employeeLeftLabel(flag: EmployeeLeftFlag): string {
  if (flag.kind === "declined") return "Offer declined";
  return flag.date ? `Left ${formatLeftDay(flag.date)}` : "Left";
}

/** The word for a probation tracker row, whose fields are snake case. Null for anyone still here. */
export function employeeLeftWord(row: {
  employment_status?: string | null;
  last_working_date?: string | null;
}): string | null {
  const flag = employeeLeftFlag({ employmentStatus: row.employment_status, lastWorkingDate: row.last_working_date });
  return flag ? employeeLeftLabel(flag) : null;
}
